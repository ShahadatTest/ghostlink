//! GhostLink census program.
//!
//! In plain language: anyone may ask this program to look at a token
//! account and write down "wallet W held amount A of mint M at slot S" as
//! a leaf in an append-only Merkle tree. Later, the wallet's owner can
//! prove "I held at least X as of slot S" without revealing which wallet.
//! The program only ever reads accounts the token programs own, so a
//! snapshot can never lie about a balance.
//!
//! Recent roots are kept one per ~1-minute bucket (see
//! `ghostlink_verifier::merkle::RootRing`), so no burst of snapshots can
//! push the roots in-flight proofs use out of the history (ADR 0005).
//!
//! A snapshot must be a top-level instruction in a transaction holding
//! only compute-budget and snapshot instructions, so nothing in the same
//! transaction can lend a balance for the moment it is recorded.
//! Borrowing across transactions remains possible; verifiers bound it
//! with fresh `min_slot` windows.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;
use anchor_lang::Discriminator;
use ghostlink_verifier::merkle::{Frontier, RootRing, ROOT_HISTORY, TREE_DEPTH};
use ghostlink_verifier::poseidon;

declare_id!("CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d");

/// SPL Token program id.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Token-2022 program id.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// The wSOL mint, used as the mint id for native SOL snapshots.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Compute-budget instructions are the only foreign instructions a
/// snapshot transaction may carry.
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");

#[program]
pub mod ghostlink_census {
    use super::*;

    /// Creates the census tree. Called once; stores nothing about the caller.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let mut tree = ctx.accounts.tree_state.load_init()?;
        tree.ring().reset(ghostlink_verifier::merkle::empty_root(), slot);
        Ok(())
    }

    /// Snapshots one balance for `wallet`. Anyone may call and pay.
    ///
    /// Two shapes:
    /// - SPL / Token-2022: `holding` is a token account owned by one of
    ///   the token programs with `owner == wallet`; mint and amount are
    ///   read from its bytes.
    /// - Native SOL: `holding` is the wallet account itself; the amount
    ///   is its lamports and the mint is recorded as the wSOL mint.
    pub fn snapshot(ctx: Context<Snapshot>) -> Result<()> {
        // A program calling in could lend the balance and take it back
        // around this instruction; so could another instruction in the
        // same transaction.
        require!(
            get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
            CensusError::CpiForbidden
        );
        require_snapshot_only_transaction(&ctx.accounts.instructions)?;

        let wallet = ctx.accounts.wallet.key();
        let holding = &ctx.accounts.holding;
        let slot = Clock::get()?.slot;

        let (mint, amount) = if holding.key() == wallet {
            (NATIVE_MINT, holding.lamports())
        } else {
            let owner_program = *holding.owner;
            require!(
                owner_program == TOKEN_PROGRAM_ID || owner_program == TOKEN_2022_PROGRAM_ID,
                CensusError::NotATokenAccount
            );
            let data = holding.try_borrow_data()?;
            // SPL token account layout: mint [0..32], owner [32..64],
            // amount u64 LE [64..72]; Token-2022 keeps this base layout.
            // Classic accounts are exactly 165 bytes. Token-2022 extended
            // accounts carry AccountType::Account (2) at offset 165;
            // its 355-byte multisig layout has no such discriminator.
            let valid_layout = data.len() == 165 ||
                (owner_program == TOKEN_2022_PROGRAM_ID && data.len() > 165
                    && data.len() != 355 && data[165] == 2);
            require!(valid_layout, CensusError::NotATokenAccount);
            // state byte at 108: 0 = uninitialized, 1 = initialized, 2 = frozen.
            require!(data[108] == 1 || data[108] == 2, CensusError::NotATokenAccount);
            let token_owner = Pubkey::try_from(&data[32..64]).unwrap();
            require!(token_owner == wallet, CensusError::WrongOwner);
            let mint = Pubkey::try_from(&data[0..32]).unwrap();
            let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
            (mint, amount)
        };

        let leaf = poseidon::census_leaf(
            &wallet.to_bytes(),
            &mint.to_bytes(),
            amount,
            slot,
        )
        .map_err(|_| error!(CensusError::HashFailed))?;

        let mut tree = ctx.accounts.tree_state.load_mut()?;
        let tree_ref = &mut *tree;
        let leaf_index = tree_ref.next_index;
        let root = Frontier {
            next_index: &mut tree_ref.next_index,
            frontier: &mut tree_ref.frontier,
        }
        .append(leaf)
        .map_err(|_| error!(CensusError::TreeFull))?;
        tree_ref.ring().record(root, slot);

        emit!(SnapshotTaken {
            leaf_index,
            leaf,
            root,
            wallet,
            mint,
            amount,
            slot,
        });
        Ok(())
    }
}

/// Every top-level instruction in the transaction must be a compute-budget
/// instruction or a census snapshot: nothing can lend, move or return a
/// balance around the moment it is recorded.
fn require_snapshot_only_transaction(instructions: &AccountInfo) -> Result<()> {
    let count = {
        let data = instructions.try_borrow_data()?;
        require!(data.len() >= 2, CensusError::ForeignInstruction);
        u16::from_le_bytes([data[0], data[1]]) as usize
    };
    for index in 0..count {
        let ix = load_instruction_at_checked(index, instructions)?;
        let allowed = ix.program_id == COMPUTE_BUDGET_PROGRAM_ID
            || (ix.program_id == crate::ID
                && ix.data.starts_with(crate::instruction::Snapshot::DISCRIMINATOR));
        require!(allowed, CensusError::ForeignInstruction);
    }
    Ok(())
}

#[account(zero_copy)]
#[repr(C)]
pub struct TreeState {
    pub next_index: u64,
    pub frontier: [[u8; 32]; TREE_DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY],
    pub root_cursor: u8,
    pub _padding: [u8; 7],
    /// Slot at which each `roots` entry was last written.
    pub root_slots: [u64; ROOT_HISTORY],
}

impl TreeState {
    pub const SIZE: usize = 8 + 8 + 32 * TREE_DEPTH + 32 * ROOT_HISTORY + 1 + 7 + 8 * ROOT_HISTORY;

    fn ring(&mut self) -> RootRing<'_> {
        RootRing {
            roots: &mut self.roots,
            slots: &mut self.root_slots,
            cursor: &mut self.root_cursor,
        }
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = TreeState::SIZE,
        seeds = [b"census"],
        bump
    )]
    pub tree_state: AccountLoader<'info, TreeState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only its key enters the leaf; the balance is read from
    /// `holding`, whose ownership the program verifies itself.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: verified in the handler — either the wallet itself (native
    /// SOL) or a token account owned by a token program with owner == wallet.
    pub holding: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"census"], bump)]
    pub tree_state: AccountLoader<'info, TreeState>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[event]
pub struct SnapshotTaken {
    pub leaf_index: u64,
    pub leaf: [u8; 32],
    pub root: [u8; 32],
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[error_code]
pub enum CensusError {
    #[msg("holding is not a token account of a supported token program")]
    NotATokenAccount,
    #[msg("token account owner does not match the wallet")]
    WrongOwner,
    #[msg("Poseidon hash failed")]
    HashFailed,
    #[msg("census tree is full")]
    TreeFull,
    #[msg("snapshot must be a top-level instruction")]
    CpiForbidden,
    #[msg("a snapshot transaction may hold only compute-budget and snapshot instructions")]
    ForeignInstruction,
}
