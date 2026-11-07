//! Rolling daily spending windows.
//!
//! A fixed day that resets allows twice the cap within seconds: spend the
//! cap just before the reset and again just after it. Instead, spending is
//! recorded in hourly buckets, and a spend is allowed only while the
//! current hour's bucket, the 24 before it and the spend itself stay within
//! the cap.
//!
//! Guarantee: spends accepted at slots `a <= b` with `b - a < SLOTS_PER_DAY`
//! (any span shorter than 24 hours) total at most the cap. Their buckets
//! differ by at most 24, so the earlier one is still inside the window when
//! the later one is checked. Budget returns when a bucket leaves the
//! window, between 24 and 25 hours after the spend.

use anchor_lang::prelude::*;

use crate::state::{PocketError, SLOTS_PER_DAY};

/// One bucket per hour of 400 ms slots.
pub const BUCKET_SLOTS: u64 = SLOTS_PER_DAY / 24;
/// The current hour plus the 24 before it.
pub const BUCKETS: usize = 25;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct RollingWindow {
    /// Bucket index (`slot / BUCKET_SLOTS`) of the newest recorded hour.
    pub latest_bucket: u64,
    /// `amounts[b % BUCKETS]` holds bucket `b`'s total, for the `BUCKETS`
    /// buckets ending at `latest_bucket`.
    pub amounts: [u64; BUCKETS],
}

impl RollingWindow {
    /// Forgets the buckets that have left the window ending at `now_slot`.
    /// Slots never go backwards; an older slot leaves the window as it is.
    fn advance(&mut self, now_slot: u64) {
        let bucket = now_slot / BUCKET_SLOTS;
        if bucket <= self.latest_bucket {
            return;
        }
        if bucket - self.latest_bucket >= BUCKETS as u64 {
            self.amounts = [0; BUCKETS];
        } else {
            for b in self.latest_bucket + 1..=bucket {
                self.amounts[(b % BUCKETS as u64) as usize] = 0;
            }
        }
        self.latest_bucket = bucket;
    }

    /// Everything recorded in the window ending at `now_slot`.
    pub fn total(&self, now_slot: u64) -> Result<u64> {
        let mut window = *self;
        window.advance(now_slot);
        window.amounts.iter().try_fold(0u64, |sum, amount| {
            sum.checked_add(*amount).ok_or(error!(PocketError::Overflow))
        })
    }

    /// Whether `amount` more keeps the window ending at `now_slot` within `cap`.
    pub fn fits(&self, now_slot: u64, amount: u64, cap: u64) -> Result<bool> {
        Ok(self.total(now_slot)?.checked_add(amount).ok_or(error!(PocketError::Overflow))? <= cap)
    }

    /// Adds `amount` to the bucket of `now_slot`. On error nothing changes.
    pub fn record(&mut self, now_slot: u64, amount: u64) -> Result<()> {
        let mut next = *self;
        next.advance(now_slot);
        let i = (next.latest_bucket % BUCKETS as u64) as usize;
        next.amounts[i] = next.amounts[i].checked_add(amount).ok_or(error!(PocketError::Overflow))?;
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = BUCKET_SLOTS;
    const DAY: u64 = SLOTS_PER_DAY;

    #[test]
    fn a_reset_boundary_never_doubles_the_cap() {
        // The fixed-day exploit: spend the cap in the last slot before a
        // "reset" and again right after it.
        for start in [0, 1, HOUR - 1, 123_456_800] {
            let mut w = RollingWindow::default();
            w.record(start, 100).unwrap();
            for later in [start + 1, start + HOUR, start + DAY - 1] {
                assert!(!w.fits(later, 1, 100).unwrap(), "start {start}, later {later}");
            }
            // A full day later the spend may still count (it leaves with its
            // bucket), but it never counts after 25 hours.
            assert!(w.fits(start + DAY + HOUR, 100, 100).unwrap());
        }
    }

    #[test]
    fn every_span_shorter_than_a_day_stays_within_the_cap() {
        // Spend greedily every 37 minutes for three days; then check every
        // pair of spends closer than a day.
        let cap = 1_000;
        let mut w = RollingWindow::default();
        let mut accepted: Vec<(u64, u64)> = Vec::new();
        let mut slot = 7 * HOUR + 123;
        while slot < 7 * HOUR + 3 * DAY {
            let amount = 1 + (slot % 97) * 3;
            if w.fits(slot, amount, cap).unwrap() {
                w.record(slot, amount).unwrap();
                accepted.push((slot, amount));
            }
            slot += HOUR * 37 / 60;
        }
        assert!(accepted.len() > 10);
        for (i, (a, _)) in accepted.iter().enumerate() {
            let span: u64 = accepted[i..].iter().take_while(|(b, _)| b - a < DAY).map(|(_, x)| x).sum();
            assert!(span <= cap, "spends from slot {a} within a day total {span}");
        }
    }

    #[test]
    fn buckets_expire_with_their_hour_and_failures_leave_no_trace() {
        let mut w = RollingWindow::default();
        w.record(10 * HOUR, 5).unwrap();
        w.record(12 * HOUR + 1, 7).unwrap();
        assert_eq!(w.total(12 * HOUR + 2).unwrap(), 12);
        assert_eq!(w.total(34 * HOUR).unwrap(), 12, "hour 10 is still one of the last 25");
        assert_eq!(w.total(35 * HOUR).unwrap(), 7, "hour 10 left the window");
        assert_eq!(w.total(37 * HOUR).unwrap(), 0);
        // A query never changes state; an overflowing record changes nothing.
        let before = w;
        w.record(12 * HOUR + 3, u64::MAX).unwrap_err();
        assert_eq!(w, before);
        assert!(w.fits(12 * HOUR, u64::MAX, u64::MAX).is_err());
        // Slots before the newest bucket count toward it rather than corrupting older buckets.
        w.record(11 * HOUR, 1).unwrap();
        assert_eq!(w.total(12 * HOUR + 4).unwrap(), 13);
    }
}
