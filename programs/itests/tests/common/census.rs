//! Census instruction builders shared by the flow and spam-resistance
//! tests. Raw bytes, like everything else here, so a change to the
//! program's accounts or arguments fails these tests loudly.

use super::{ix_data, meta_r, meta_w, pda, pk, CENSUS_ID, SYSTEM_ID, SYSVAR_IX_ID};
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

/// Fee a freshly initialized census charges per snapshot.
pub const DEFAULT_SNAPSHOT_FEE: u64 = 100_000;

pub fn census_tree_pda() -> Pubkey {
    pda(&[b"census"], &pk(CENSUS_ID))
}

pub fn census_config_pda() -> Pubkey {
    pda(&[b"config"], &pk(CENSUS_ID))
}

pub fn census_fee_vault_pda() -> Pubkey {
    pda(&[b"fee_vault"], &pk(CENSUS_ID))
}

/// Creates the tree, the fee config and the fee vault.
pub fn census_initialize_ix(payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_w(census_tree_pda()),
            meta_w(census_config_pda()),
            meta_w(census_fee_vault_pda()),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("initialize", &()),
    }
}

/// A snapshot that accepts the default fee.
pub fn census_snapshot_ix(payer: &Pubkey, wallet: &Pubkey, holding: &Pubkey) -> Instruction {
    census_snapshot_ix_with_max_fee(payer, wallet, holding, DEFAULT_SNAPSHOT_FEE)
}

pub fn census_snapshot_ix_with_max_fee(
    payer: &Pubkey,
    wallet: &Pubkey,
    holding: &Pubkey,
    max_fee_lamports: u64,
) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_r(*wallet),
            meta_r(*holding),
            meta_w(census_tree_pda()),
            meta_r(census_config_pda()),
            meta_w(census_fee_vault_pda()),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("snapshot", &max_fee_lamports),
    }
}
