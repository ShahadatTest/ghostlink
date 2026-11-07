//! Pyth price reading and USD valuation.
//!
//! The pocket parses Pyth `PriceUpdateV2` accounts directly (owner-checked
//! against the Pyth receiver program) instead of linking the receiver SDK,
//! keeping the dependency surface auditable. Which feed prices which mint
//! is fixed in the pocket's policy by the user, so an app or solver can
//! never substitute a friendlier feed. Switchboard support is a documented
//! v2 candidate (docs/adr/0001).
//!
//! Only one account per feed is accepted: the push oracle's shard-0 PDA,
//! which Pyth's sponsored pusher keeps current. The push oracle writes an
//! update only when its publish time is newer than the stored one, so the
//! account moves forward in time and a solver cannot choose among older
//! posted updates (docs/adr/0006).

use anchor_lang::prelude::*;

use crate::state::{PocketError, MAX_ORACLE_AGE_SECS, MAX_ORACLE_CONF_BPS, MAX_ORACLE_POSTED_AGE_SLOTS};

/// Pyth receiver program (same id on devnet and mainnet).
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Pyth push-oracle program that pairs with that receiver.
pub const PYTH_PUSH_ORACLE_ID: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/// The shard Pyth's sponsored pusher updates.
pub const SPONSORED_SHARD: u16 = 0;

/// Anchor discriminator of PriceUpdateV2 = sha256("account:PriceUpdateV2")[..8].
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// Byte length of a fully verified PriceUpdateV2 up to the posted slot:
/// 8 disc + 32 write_authority + 1 verification level + 84 price message
/// + 8 posted_slot.
const FULL_LEN: usize = 8 + 32 + 1 + 84 + 8;

pub struct OraclePrice {
    pub price: i64,
    pub exponent: i32,
}

/// The sponsored price account for a feed: the push oracle's PDA of
/// (shard u16 little-endian, feed id). Pyth's SDKs derive it the same way.
pub fn push_feed_address(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&SPONSORED_SHARD.to_le_bytes(), feed_id], &PYTH_PUSH_ORACLE_ID).0
}

/// Parses and validates the sponsored PriceUpdateV2 account for `expected_feed_id`.
///
/// Layout after the discriminator:
///   write_authority: Pubkey (32)
///   verification_level: borsh enum — 0 => Partial { num_signatures: u8 }
///                       (one extra byte), 1 => Full
///   price_message: feed_id [32], price i64, conf u64, exponent i32,
///                  publish_time i64, prev_publish_time i64, ema_price
///                  i64, ema_conf u64
///   posted_slot: u64
pub fn read_price(account: &AccountInfo, expected_feed_id: &[u8; 32], clock: &Clock) -> Result<OraclePrice> {
    require!(account.key() == push_feed_address(expected_feed_id), PocketError::OracleNotCanonical);
    require!(account.owner == &PYTH_RECEIVER_ID, PocketError::BadOracle);
    let data = account.try_borrow_data()?;
    require!(data.len() > 8 + 32 && data[..8] == PRICE_UPDATE_V2_DISC, PocketError::BadOracle);
    // Full verification only: a Partial update checked fewer guardian
    // signatures and carries an extra num_signatures byte.
    require!(data[8 + 32] == 1, PocketError::BadOracle);
    require!(data.len() >= FULL_LEN, PocketError::BadOracle);

    let at = |offset: usize| -> [u8; 8] { data[offset..offset + 8].try_into().unwrap() };
    let mut off = 8 + 32 + 1;
    let feed_id: [u8; 32] = data[off..off + 32].try_into().unwrap();
    require!(&feed_id == expected_feed_id, PocketError::BadOracle);
    off += 32;
    let price = i64::from_le_bytes(at(off));
    let conf = u64::from_le_bytes(at(off + 8));
    let exponent = i32::from_le_bytes(data[off + 16..off + 20].try_into().unwrap());
    let publish_time = i64::from_le_bytes(at(off + 20));
    // prev_publish_time, ema_price and ema_conf precede the posted slot.
    let posted_slot = u64::from_le_bytes(at(off + 52));

    require!(price > 0, PocketError::BadOracle);
    require!(
        (conf as u128) * 10_000 <= (price as u128) * MAX_ORACLE_CONF_BPS as u128,
        PocketError::OracleConfidence
    );
    require!(
        publish_time >= clock.unix_timestamp.saturating_sub(MAX_ORACLE_AGE_SECS),
        PocketError::StaleOracle
    );
    // Solana's own slot clock, in case its unix timestamp drifts. The
    // receiver records the current slot, so a posted slot is never ahead.
    require!(
        clock.slot.saturating_sub(posted_slot) <= MAX_ORACLE_POSTED_AGE_SLOTS,
        PocketError::StaleOracle
    );

    Ok(OraclePrice { price, exponent })
}

/// USD value (micro-dollars) of `amount` raw units of a mint with
/// `decimals`, at `price * 10^exponent` dollars per whole token.
/// usd_e6 = amount * price * 10^(6 + exponent) / 10^decimals.
pub fn usd_e6(amount: u64, decimals: u8, p: &OraclePrice) -> Result<u64> {
    // Account metadata can contain the full i32 exponent/u8 decimals
    // ranges. Reject unsupported powers instead of wrapping or panicking.
    let scale = 6i64 + p.exponent as i64 - decimals as i64;
    require!(p.price > 0 && (-38..=38).contains(&scale), PocketError::BadOracle);
    let base = (amount as u128)
        .checked_mul(p.price as u128)
        .ok_or(error!(PocketError::Overflow))?;
    let value = if scale >= 0 {
        base.checked_mul(10u128.pow(scale as u32))
            .ok_or(error!(PocketError::Overflow))?
    } else {
        base / 10u128.pow((-scale) as u32)
    };
    u64::try_from(value).map_err(|_| error!(PocketError::Overflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sponsored_account_matches_pyth_published_address() {
        // Pyth lists 7UVi…jLiE as the shard-0 SOL/USD price feed account on Solana.
        let sol_usd: [u8; 32] = [0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1,
            0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d];
        assert_eq!(push_feed_address(&sol_usd), pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"));
    }

    #[test]
    fn usd_valuation() {
        // 25 USDC (6 decimals) at $1.00 (price 100000000, expo -8):
        let p = OraclePrice { price: 100_000_000, exponent: -8 };
        assert_eq!(usd_e6(25_000_000, 6, &p).unwrap(), 25_000_000);
        // 0.16 SOL (9 decimals) at $156.25 (price 15625000000, expo -8):
        let p = OraclePrice { price: 15_625_000_000, exponent: -8 };
        assert_eq!(usd_e6(160_000_000, 9, &p).unwrap(), 25_000_000);
    }

    #[test]
    fn unsupported_scales_return_errors_without_panicking() {
        for (exponent, decimals) in [(i32::MAX, 0), (i32::MIN, 255), (-8, 255), (33, 0)] {
            assert!(usd_e6(1, decimals, &OraclePrice { price: 1, exponent }).is_err());
        }
        assert!(usd_e6(u64::MAX, 0, &OraclePrice { price: i64::MAX, exponent: 32 }).is_err());
    }
}
