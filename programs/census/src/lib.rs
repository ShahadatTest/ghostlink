//! GhostLink census program.
//!
//! In plain language: anyone may ask this program to look at a token
//! account and write down "wallet W held amount A of mint M at slot S" as
//! a leaf in an append-only Merkle tree. Later, the wallet's owner can
//! prove "I held at least X as of slot S" without revealing which wallet.
//! The program only ever reads accounts the token programs own, so a
//! snapshot can never lie about a balance.
//!
//! Spam resistance (ADR 0005):
//! - recent roots are kept one per ~1-minute bucket, so no burst of
//!   snapshots can push the roots in-flight proofs use out of the history;
//! - every snapshot pays a fee into the fee vault, so filling the tree's
//!   2^26 leaves costs far more than network fees;
//! - a snapshot must be a top-level instruction in a transaction holding
//!   only compute-budget and snapshot instructions, so nothing in the same
//!   transaction can lend a balance for the moment it is recorded.
//!   Borrowing across transactions remains possible; verifiers bound it
//!   with fresh `min_slot` windows.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;
use anchor_lang::system_program;
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

/// Snapshot fee a fresh deployment starts with: 100,000 lamports, twenty
/// times a signature's base fee. Filling the 2^26-leaf tree then costs
/// about 6,700 SOL in fees alone. The upgrade authority can change it.
pub const DEFAULT_SNAPSHOT_FEE_LAMPORTS: u64 = 100_000;

#[program]
pub mod ghostlink_census {
    use super::*;

    /// Creates the census tree, the fee config at the default fee and the
    /// empty fee vault. Called once; stores nothing about the caller: the
    /// fee and the vault answer to the program's upgrade authority.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let mut tree = ctx.accounts.tree_state.load_init()?;
        tree.ring().reset(ghostlink_verifier::merkle::empty_root(), slot);
        ctx.accounts.config.fee_lamports = DEFAULT_SNAPSHOT_FEE_LAMPORTS;
        ctx.accounts.config.bump = ctx.bumps.config;
        ctx.accounts.fee_vault.bump = ctx.bumps.fee_vault;
        Ok(())
    }

    /// Snapshots one balance for `wallet`. Anyone may call and pay; the
    /// payer also pays the current snapshot fee into the fee vault and
    /// names the most it accepts in `max_fee_lamports`.
    ///
    /// Two shapes:
    /// - SPL / Token-2022: `holding` is a token account owned by one of
    ///   the token programs with `owner == wallet`; mint and amount are
    ///   read from its bytes.
    /// - Native SOL: `holding` is the wallet account itself; the amount
    ///   is its lamports and the mint is recorded as the wSOL mint.
    pub fn snapshot(ctx: Context<Snapshot>, max_fee_lamports: u64) -> Result<()> {
        // A program calling in could lend the balance and take it back
        // around this instruction; so could another instruction in the
        // same transaction.
        require!(
            get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
            CensusError::CpiForbidden
        );
        require_snapshot_only_transaction(&ctx.accounts.instructions)?;

        let fee = ctx.accounts.config.fee_lamports;
        require!(fee <= max_fee_lamports, CensusError::FeeAboveMaximum);
        if fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let wallet = ctx.accounts.wallet.key();
        let holding = &ctx.accounts.holding;
        let slot = Clock::get()?.slot;

        // Read after the fee: a wallet paying for its own native-SOL
        // snapshot is recorded with what it holds afterwards.
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

    /// Sets the per-snapshot fee. Only the program's upgrade authority.
    pub fn set_fee(ctx: Context<SetFee>, fee_lamports: u64) -> Result<()> {
        ctx.accounts.config.fee_lamports = fee_lamports;
        msg!("census snapshot fee set to {} lamports", fee_lamports);
        Ok(())
    }

    /// Moves collected fees out of the vault, never below its rent-exempt
    /// minimum. Only the program's upgrade authority.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, lamports: u64) -> Result<()> {
        let vault = ctx.accounts.fee_vault.to_account_info();
        let floor = Rent::get()?.minimum_balance(vault.data_len());
        require!(
            lamports <= vault.lamports().saturating_sub(floor),
            CensusError::InsufficientFees
        );
        **vault.try_borrow_mut_lamports()? -= lamports;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += lamports;
        msg!("withdrew {} lamports of census fees", lamports);
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

/// The snapshot fee. Governed by the program's upgrade authority, so it
/// adds no key of its own and freezes when the program becomes immutable.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub fee_lamports: u64,
    pub bump: u8,
}

/// Holds collected snapshot fees as lamports above its rent-exempt minimum.
#[account]
#[derive(InitSpace)]
pub struct FeeVault {
    pub bump: u8,
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
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = payer, space = 8 + FeeVault::INIT_SPACE, seeds = [b"fee_vault"], bump)]
    pub fee_vault: Account<'info, FeeVault>,
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
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"fee_vault"], bump = fee_vault.bump)]
    pub fee_vault: Account<'info, FeeVault>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFee<'info> {
    pub authority: Signer<'info>,
    #[account(
        address = bpf_loader_upgradeable::get_program_data_address(&crate::ID),
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ CensusError::NotAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub authority: Signer<'info>,
    #[account(
        address = bpf_loader_upgradeable::get_program_data_address(&crate::ID),
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ CensusError::NotAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut, seeds = [b"fee_vault"], bump = fee_vault.bump)]
    pub fee_vault: Account<'info, FeeVault>,
    /// CHECK: any account the authority names receives the lamports.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
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
    #[msg("snapshot fee exceeds the payer's maximum")]
    FeeAboveMaximum,
    #[msg("signer is not the census upgrade authority")]
    NotAuthority,
    #[msg("fee vault holds less than requested above its rent-exempt minimum")]
    InsufficientFees,
}
