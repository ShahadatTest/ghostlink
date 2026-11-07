//! The incremental Merkle frontier and root-history ring both trees use.
//! Appending touches 26 Poseidon syscalls; the
//! zero-subtree constants are compiled in (`zeros.rs`, generated from the
//! shared fixtures and cross-checked by a test).

use crate::poseidon::node;
use crate::zeros::ZEROS;
use crate::VerifierError;

pub const TREE_DEPTH: usize = 26;
pub const ROOT_HISTORY: usize = 128;

/// Width of one root-history bucket, in slots (about a minute at 400 ms
/// per slot). The ring keeps one root per bucket: every append inside a
/// bucket overwrites the newest entry, and only the first append of a
/// later bucket pushes a new one. However many appends arrive, the
/// `ROOT_HISTORY` entries therefore span at least `ROOT_HISTORY` buckets
/// — 19,200 slots, about 2.1 hours, more than twice the pocket's one-hour
/// census freshness window — so spam cannot push a root out of the ring
/// faster than time passes. Provers use the root of a bucket that has
/// ended: the newest entry can still be overwritten while its bucket is
/// open. (packages/common `ROOT_BUCKET_SLOTS` mirrors this value.)
pub const ROOT_BUCKET_SLOTS: u64 = 150;

/// The root-history bucket a slot falls in.
pub fn root_bucket(slot: u64) -> u64 {
    slot / ROOT_BUCKET_SLOTS
}

/// The on-chain tree state: a frontier of filled-subtree hashes plus the
/// next leaf index. The caller owns the actual account layout; this is
/// pure logic over borrowed fields.
pub struct Frontier<'a> {
    pub next_index: &'a mut u64,
    pub frontier: &'a mut [[u8; 32]; TREE_DEPTH],
}

impl Frontier<'_> {
    /// Append a leaf and return the new root.
    pub fn append(&mut self, leaf: [u8; 32]) -> Result<[u8; 32], VerifierError> {
        let index = *self.next_index;
        if index >= 1u64 << TREE_DEPTH {
            return Err(VerifierError::TreeFull);
        }
        let mut cur = leaf;
        let mut idx = index;
        for level in 0..TREE_DEPTH {
            if idx % 2 == 0 {
                self.frontier[level] = cur;
                cur = node(&cur, &ZEROS[level])?;
            } else {
                cur = node(&self.frontier[level], &cur)?;
            }
            idx /= 2;
        }
        *self.next_index = index + 1;
        Ok(cur)
    }
}

/// Time-bucketed history of the last `ROOT_HISTORY` bucket roots, so
/// proofs built against a slightly stale root still verify. Each entry
/// keeps the slot of its last write. Never check against a single current
/// root (threat model: stale root attack).
pub struct RootRing<'a> {
    pub roots: &'a mut [[u8; 32]; ROOT_HISTORY],
    pub slots: &'a mut [u64; ROOT_HISTORY],
    pub cursor: &'a mut u8,
}

impl RootRing<'_> {
    /// Starts a fresh ring whose only entry is `root`, written at `slot`.
    pub fn reset(&mut self, root: [u8; 32], slot: u64) {
        // fill() writes in place: no 4 KiB temporary on the SBF stack.
        self.roots.fill([0u8; 32]);
        self.slots.fill(0);
        *self.cursor = 0;
        self.roots[0] = root;
        self.slots[0] = slot;
    }

    /// Records the tree's new `root` as of `slot`: overwrites the newest
    /// entry while `slot` is in that entry's bucket, otherwise pushes a
    /// new entry and evicts the oldest.
    pub fn record(&mut self, root: [u8; 32], slot: u64) {
        let mut cursor = *self.cursor as usize % ROOT_HISTORY;
        if root_bucket(self.slots[cursor]) != root_bucket(slot) {
            cursor = (cursor + 1) % ROOT_HISTORY;
            *self.cursor = cursor as u8;
        }
        self.roots[cursor] = root;
        self.slots[cursor] = slot;
    }

    pub fn contains(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

/// The empty tree's root (all-zero leaves).
pub fn empty_root() -> [u8; 32] {
    ZEROS[TREE_DEPTH]
}

/// Raw-layout reader for a TreeState account owned by the registry or
/// census program, so the pocket program can check root membership
/// without a cross-program call. Layout (after the 8-byte anchor
/// discriminator): next_index u64 | frontier [32 x 26] | roots [32 x 128]
/// | cursor u8 | padding [7] | root slots [u64 LE x 128].
pub mod tree_account {
    use super::{ROOT_HISTORY, TREE_DEPTH};

    pub const ROOTS_OFFSET: usize = 8 + 8 + 32 * TREE_DEPTH;
    pub const CURSOR_OFFSET: usize = ROOTS_OFFSET + 32 * ROOT_HISTORY;
    /// End of the roots, cursor and padding: all `ring_contains` reads.
    pub const TOTAL_LEN: usize = CURSOR_OFFSET + 1 + 7;
    pub const ROOT_SLOTS_OFFSET: usize = TOTAL_LEN;
    /// Full account length, including the slot of each ring entry.
    pub const ACCOUNT_LEN: usize = ROOT_SLOTS_OFFSET + 8 * ROOT_HISTORY;

    /// True when `root` is one of the account's last 128 bucket roots.
    /// The caller must have verified the account's owner program id.
    pub fn ring_contains(data: &[u8], root: &[u8; 32]) -> bool {
        if data.len() < TOTAL_LEN {
            return false;
        }
        for i in 0..ROOT_HISTORY {
            let off = ROOTS_OFFSET + i * 32;
            if &data[off..off + 32] == root {
                return true;
            }
        }
        false
    }

    /// The newest ring entry and the slot it was written at, or None for
    /// an account too short to hold the root slots.
    pub fn newest(data: &[u8]) -> Option<([u8; 32], u64)> {
        if data.len() < ACCOUNT_LEN {
            return None;
        }
        let cursor = data[CURSOR_OFFSET] as usize % ROOT_HISTORY;
        let root: [u8; 32] = data[ROOTS_OFFSET + 32 * cursor..ROOTS_OFFSET + 32 * (cursor + 1)]
            .try_into()
            .ok()?;
        let off = ROOT_SLOTS_OFFSET + 8 * cursor;
        let slot = u64::from_le_bytes(data[off..off + 8].try_into().ok()?);
        Some((root, slot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(n: u32) -> [u8; 32] {
        let mut r = [0u8; 32];
        r[28..].copy_from_slice(&n.to_be_bytes());
        r
    }

    #[test]
    fn one_entry_per_bucket() {
        let mut roots = [[0u8; 32]; ROOT_HISTORY];
        let mut slots = [0u64; ROOT_HISTORY];
        let mut cursor = 0u8;
        let mut ring = RootRing { roots: &mut roots, slots: &mut slots, cursor: &mut cursor };
        ring.reset(root(1), 10);
        // Inside the first bucket the newest entry is overwritten.
        ring.record(root(2), 20);
        ring.record(root(3), ROOT_BUCKET_SLOTS - 1);
        assert!(!ring.contains(&root(1)) && !ring.contains(&root(2)) && ring.contains(&root(3)));
        // The next bucket pushes; the completed bucket's root stays.
        ring.record(root(4), ROOT_BUCKET_SLOTS);
        ring.record(root(5), ROOT_BUCKET_SLOTS + 1);
        assert!(ring.contains(&root(3)) && !ring.contains(&root(4)) && ring.contains(&root(5)));
        assert_eq!(*ring.cursor, 1);
        assert_eq!(ring.slots[1], ROOT_BUCKET_SLOTS + 1);
    }
}
