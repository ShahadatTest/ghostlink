//! Bounded trading of assets without a pinned oracle. Cost is historical
//! acquisition cost, never a market price or a minimum permitted exit value.
use anchor_lang::prelude::*;
use crate::state::PocketError;
use crate::window::RollingWindow;

pub const MAX_POSITIONS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct SpeculativePolicy {
    pub daily_buy_cap_usd_e6: u64,
    pub max_cost_exposure_usd_e6: u64,
    pub max_positions: u8,
    #[max_len(4)]
    pub base_mints: Vec<Pubkey>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct Position {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    /// Acquisition and exit must use this exact pocket-owned token account.
    pub token_account: Pubkey,
    pub quantity: u64,
    pub cost_usd_e6: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug, InitSpace)]
pub struct SpeculativeLedger {
    /// Acquisition spending (USD e6) against the daily buy cap, over a rolling day.
    pub buys: RollingWindow,
    pub positions: [Position; MAX_POSITIONS],
}

/// PocketV3 boxes its ledger (see state.rs); the space is the ledger's own.
impl anchor_lang::Space for Box<SpeculativeLedger> {
    const INIT_SPACE: usize = SpeculativeLedger::INIT_SPACE;
}

impl SpeculativeLedger {
    pub fn has_positions(&self) -> bool {
        self.positions.iter().any(|p| p.quantity != 0)
    }

    pub fn cost_exposure(&self) -> Result<u64> {
        self.positions.iter().try_fold(0u64, |sum, p| sum.checked_add(p.cost_usd_e6)
            .ok_or(error!(PocketError::Overflow)))
    }

    /// Read-only preflight. State changes only after the measured output is
    /// known, inside fill_end; any later error rolls back the entire trade.
    pub fn check_buy(&self, policy: &SpeculativePolicy, mint: Pubkey, base: Pubkey,
        token_account: Pubkey, cost: u64, now_slot: u64) -> Result<usize> {
        require!(cost > 0 && policy.base_mints.contains(&base), PocketError::SpeculativeViolation);
        require!(self.buys.fits(now_slot, cost, policy.daily_buy_cap_usd_e6)?, PocketError::SpeculativeDailyCap);
        require!(self.cost_exposure()?.checked_add(cost)
            .ok_or(error!(PocketError::Overflow))? <= policy.max_cost_exposure_usd_e6,
            PocketError::SpeculativeExposureCap);
        if let Some(i) = self.positions.iter().position(|p| p.quantity != 0 && p.mint == mint) {
            let p = &self.positions[i];
            require!(p.base_mint == base && p.token_account == token_account, PocketError::SpeculativePosition);
            return Ok(i);
        }
        require!(self.positions.iter().filter(|p| p.quantity != 0).count() < policy.max_positions as usize,
            PocketError::SpeculativePositionLimit);
        self.positions.iter().position(|p| p.quantity == 0).ok_or(error!(PocketError::SpeculativePositionLimit))
    }

    pub fn acquire(&mut self, policy: &SpeculativePolicy, mint: Pubkey, base: Pubkey,
        token_account: Pubkey, quantity: u64, cost: u64, now_slot: u64) -> Result<()> {
        require!(quantity > 0, PocketError::SpeculativeViolation);
        let i = self.check_buy(policy, mint, base, token_account, cost, now_slot)?;
        let previous = self.positions[i];
        let position = Position { mint, base_mint: base, token_account,
            quantity: previous.quantity.checked_add(quantity).ok_or(error!(PocketError::Overflow))?,
            cost_usd_e6: previous.cost_usd_e6.checked_add(cost).ok_or(error!(PocketError::Overflow))? };
        self.buys.record(now_slot, cost)?;
        self.positions[i] = position;
        Ok(())
    }

    pub fn check_exit(&self, mint: Pubkey, base: Pubkey, token_account: Pubkey, quantity: u64) -> Result<usize> {
        self.positions.iter().position(|p| p.mint == mint && p.base_mint == base &&
            p.token_account == token_account && quantity > 0 && p.quantity >= quantity)
            .ok_or(error!(PocketError::SpeculativePosition))
    }

    /// Partial exits release floor(cost * quantity / balance). Rounding
    /// retains risk budget; a full exit releases the exact remaining cost.
    pub fn exit(&mut self, mint: Pubkey, base: Pubkey, token_account: Pubkey, quantity: u64) -> Result<u64> {
        let i = self.check_exit(mint, base, token_account, quantity)?;
        let p = &mut self.positions[i];
        let released = ((p.cost_usd_e6 as u128) * (quantity as u128) / (p.quantity as u128)) as u64;
        p.quantity -= quantity;
        p.cost_usd_e6 -= released;
        if p.quantity == 0 { *p = Position::default(); }
        Ok(released)
    }

    /// Sweeping an unrelated token account must not erase another account's
    /// exposure. A complete sweep of the tracked account retires permission.
    pub fn swept(&mut self, token_account: Pubkey) {
        self.take(token_account);
    }

    /// Clears and returns the open position held in `token_account`. Buys
    /// bind one account per asset, so at most one position matches.
    pub fn take(&mut self, token_account: Pubkey) -> Option<Position> {
        let mut taken = None;
        for p in &mut self.positions {
            if p.token_account == token_account {
                if p.quantity != 0 { taken = Some(*p); }
                *p = Position::default();
            }
        }
        taken
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SLOTS_PER_DAY;
    use crate::window::BUCKET_SLOTS;

    const NOW: u64 = 123_456_800;

    fn policy(base: Pubkey) -> SpeculativePolicy {
        SpeculativePolicy { daily_buy_cap_usd_e6: 30, max_cost_exposure_usd_e6: 20,
            max_positions: 2, base_mints: vec![base] }
    }

    #[test]
    fn limits_and_account_binding_survive_exits_and_sweeps() {
        let (mint, base, account) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let p = policy(base);
        let mut l = SpeculativeLedger::default();
        l.acquire(&p, mint, base, account, 100, 20, NOW).unwrap();
        assert!(l.check_buy(&p, mint, base, account, 1, NOW).is_err());
        assert!(l.check_exit(mint, base, account, 101).is_err()); // donations don't expand permission
        assert!(l.check_exit(mint, Pubkey::new_unique(), account, 1).is_err());
        assert!(l.check_exit(mint, base, Pubkey::new_unique(), 1).is_err());
        assert_eq!(l.exit(mint, base, account, 50).unwrap(), 10);
        assert!(l.check_buy(&p, mint, base, Pubkey::new_unique(), 1, NOW).is_err());
        l.acquire(&p, mint, base, account, 50, 10, NOW).unwrap();
        assert_eq!(l.exit(mint, base, account, 100).unwrap(), 20);
        assert!(!l.has_positions());
        assert!(l.check_buy(&p, mint, base, account, 1, NOW).is_err()); // daily budget never refunded
        // Only time returns it: a day later the purchase may still count, 25 hours later it never does.
        assert!(l.check_buy(&p, mint, base, account, 1, NOW + SLOTS_PER_DAY - 1).is_err());
        let later = NOW + SLOTS_PER_DAY + BUCKET_SLOTS;
        l.acquire(&p, mint, base, account, 1, 1, later).unwrap();
        l.swept(Pubkey::new_unique());
        assert_eq!(l.cost_exposure().unwrap(), 1);
        l.swept(account);
        assert!(!l.has_positions());
        assert!(l.check_exit(mint, base, account, 1).is_err()); // redeposit cannot resurrect permission
        assert_eq!(l.buys.total(later).unwrap(), 1);
    }

    #[test]
    fn take_clears_only_the_open_position_held_in_that_account() {
        let (mint, base, account) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let p = policy(base);
        let mut l = SpeculativeLedger::default();
        l.acquire(&p, mint, base, account, 5, 3, NOW).unwrap();
        assert_eq!(l.take(Pubkey::new_unique()), None);
        assert_eq!(l.cost_exposure().unwrap(), 3);
        assert_eq!(l.take(account), Some(Position { mint, base_mint: base, token_account: account,
            quantity: 5, cost_usd_e6: 3 }));
        assert!(!l.has_positions());
        assert_eq!(l.take(account), None);
    }

    #[test]
    fn partial_exit_rounding_never_releases_extra_exposure() {
        for (cost, quantity) in [(1, 7), (7, 3), (u64::MAX, u64::MAX)] {
            let (mint, base, account) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
            let p = SpeculativePolicy { daily_buy_cap_usd_e6: u64::MAX,
                max_cost_exposure_usd_e6: u64::MAX, ..policy(base) };
            let mut l = SpeculativeLedger::default();
            l.acquire(&p, mint, base, account, quantity, cost, NOW).unwrap();
            assert!(l.check_buy(&p, mint, base, account, u64::MAX, NOW).is_err());
            let sold = quantity / 2;
            let released = l.exit(mint, base, account, sold).unwrap();
            assert_eq!(released as u128, cost as u128 * sold as u128 / quantity as u128);
            assert_eq!(l.exit(mint, base, account, quantity - sold).unwrap(), cost - released);
            assert_eq!(l.cost_exposure().unwrap(), 0);
            assert!(l.positions.iter().all(|p| *p == Position::default()));
        }
    }

    #[test]
    fn bounded_slots_and_failed_acquisitions_do_not_mutate_state() {
        let base = Pubkey::new_unique();
        let p = policy(base);
        let mut l = SpeculativeLedger::default();
        for _ in 0..2 { l.acquire(&p, Pubkey::new_unique(), base, Pubkey::new_unique(), 1, 1, NOW).unwrap(); }
        let before = l.try_to_vec().unwrap();
        assert!(l.acquire(&p, Pubkey::new_unique(), base, Pubkey::new_unique(), 1, 1, NOW).is_err());
        assert_eq!(before, l.try_to_vec().unwrap());
        // Account readers must reject old allocations, even their zero padding.
        assert_eq!(8 + crate::state::PocketV3::INIT_SPACE, 3685);
    }
}
