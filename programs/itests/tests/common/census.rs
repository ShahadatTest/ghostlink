//! Census instruction builders shared by the flow and spam-resistance
//! tests. Raw bytes, like everything else here, so a change to the
//! program's accounts or arguments fails these tests loudly.

use super::{ix_data, meta_r, meta_w, pda, pk, CENSUS_ID, SYSTEM_ID, SYSVAR_IX_ID};
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

pub fn census_tree_pda() -> Pubkey {
    pda(&[b"census"], &pk(CENSUS_ID))
}

/// Creates the tree.
pub fn census_initialize_ix(payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_w(census_tree_pda()),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("initialize", &()),
    }
}

pub fn census_snapshot_ix(payer: &Pubkey, wallet: &Pubkey, holding: &Pubkey) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_r(*wallet),
            meta_r(*holding),
            meta_w(census_tree_pda()),
            meta_r(pk(SYSVAR_IX_ID)),
        ],
        data: ix_data("snapshot", &()),
    }
}
