//! Raw SPL token account and mint parsing, and the only two CPIs this
//! program ever makes: Transfer and CloseAccount on the pocket's own token
//! accounts, both signed with the pocket PDA. There is no other
//! `invoke_signed` anywhere in this program (audited invariant).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::state::PocketError;

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub struct ParsedTokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub close_authority: Option<Pubkey>,
    /// Frozen by its mint's freeze authority: no transfer or close succeeds.
    pub frozen: bool,
    /// Wrapped SOL: SPL's `is_native` is set.
    pub native: bool,
    /// The account's lamports when it was parsed.
    pub lamports: u64,
}

impl ParsedTokenAccount {
    pub fn can_close(&self, owner: &Pubkey) -> bool {
        self.close_authority.map_or(true, |authority| authority == *owner)
    }

    /// The balance a fill measures delivery on: the token amount, or for
    /// wrapped SOL the account's lamports. Lamports move only with real
    /// transfers. SyncNative merely copies lamports the account already
    /// holds into its amount, and can also lower the recorded rent reserve
    /// to the current rent, so neither can make the pocket's own lamports
    /// count as delivery.
    pub fn delivery_balance(&self) -> u64 {
        if self.native { self.lamports } else { self.amount }
    }
}

/// Parses an SPL token account a fill can use: owned by the SPL Token
/// program, initialized and not frozen. (Fills are SPL-Token-only in v1;
/// the census additionally reads Token-2022, see docs/adr/0001.)
pub fn parse_token_account(info: &AccountInfo) -> Result<ParsedTokenAccount> {
    let account = parse_token_account_any_state(info)?;
    require!(!account.frozen, PocketError::BadTokenAccount);
    Ok(account)
}

/// Parses an initialized SPL token account whether or not it is frozen.
/// Only recovery accepts a frozen account, and only to skip it.
pub fn parse_token_account_any_state(info: &AccountInfo) -> Result<ParsedTokenAccount> {
    require!(info.owner == &TOKEN_PROGRAM_ID, PocketError::BadTokenAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() == 165, PocketError::BadTokenAccount);
    let frozen = match data[108] {
        1 => false, // initialized
        2 => true,  // frozen
        _ => return err!(PocketError::BadTokenAccount),
    };
    let close_authority = match &data[129..133] {
        [0, 0, 0, 0] => None,
        [1, 0, 0, 0] => Some(Pubkey::try_from(&data[133..165]).unwrap()),
        _ => return err!(PocketError::BadTokenAccount),
    };
    let delegate = match &data[72..76] {
        [0, 0, 0, 0] => None,
        [1, 0, 0, 0] => Some(Pubkey::try_from(&data[76..108]).unwrap()),
        _ => return err!(PocketError::BadTokenAccount),
    };
    let native = match &data[109..113] {
        [0, 0, 0, 0] => false,
        [1, 0, 0, 0] => true,
        _ => return err!(PocketError::BadTokenAccount),
    };
    Ok(ParsedTokenAccount {
        mint: Pubkey::try_from(&data[0..32]).unwrap(),
        owner: Pubkey::try_from(&data[32..64]).unwrap(),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
        delegate,
        close_authority,
        frozen,
        native,
        lamports: info.lamports(),
    })
}

pub struct ParsedMint {
    pub freeze_authority: Option<Pubkey>,
}

/// Parses an initialized classic SPL mint (82 bytes: mint authority,
/// supply, decimals, initialized flag, then the freeze authority option).
pub fn parse_mint(info: &AccountInfo) -> Result<ParsedMint> {
    require!(info.owner == &TOKEN_PROGRAM_ID, PocketError::BadTokenAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() == 82 && data[45] == 1, PocketError::BadTokenAccount);
    let freeze_authority = match &data[46..50] {
        [0, 0, 0, 0] => None,
        [1, 0, 0, 0] => Some(Pubkey::try_from(&data[50..82]).unwrap()),
        _ => return err!(PocketError::BadTokenAccount),
    };
    Ok(ParsedMint { freeze_authority })
}

/// SPL Token Transfer (instruction 3) from a pocket-owned account, signed
/// by the pocket PDA.
pub fn transfer_from_pocket<'info>(
    source: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    pocket: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    pocket_seeds: &[&[u8]],
) -> Result<()> {
    require!(
        token_program.key == &TOKEN_PROGRAM_ID,
        PocketError::BadTokenAccount
    );
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*pocket.key, true),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[source.clone(), destination.clone(), pocket.clone()],
        &[pocket_seeds],
    )
    .map_err(Into::into)
}

/// SPL Token CloseAccount (instruction 9) on a pocket-owned account,
/// sending its rent lamports to `destination`.
pub fn close_pocket_account<'info>(
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    pocket: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    pocket_seeds: &[&[u8]],
) -> Result<()> {
    require!(
        token_program.key == &TOKEN_PROGRAM_ID,
        PocketError::BadTokenAccount
    );
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*pocket.key, true),
        ],
        data: vec![9u8],
    };
    invoke_signed(
        &ix,
        &[account.clone(), destination.clone(), pocket.clone()],
        &[pocket_seeds],
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(amount: u64, native: bool, lamports: u64) -> ParsedTokenAccount {
        ParsedTokenAccount { mint: Pubkey::default(), owner: Pubkey::default(), amount, delegate: None,
            close_authority: None, frozen: false, native, lamports }
    }

    #[test]
    fn wrapped_sol_delivery_is_measured_in_lamports() {
        assert_eq!(account(5, false, 999).delivery_balance(), 5);
        // Synced or not, every lamport of a native account is in its balance.
        assert_eq!(account(5, true, 2_039_380).delivery_balance(), 2_039_380);
    }
}
