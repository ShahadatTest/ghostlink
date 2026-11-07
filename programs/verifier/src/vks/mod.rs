//! Compiled-in Groth16 verifying keys.
//!
//! The two files below are GENERATED from circuits/keys/*_vk.json by
//! `cargo run -p ghostlink-verifier --bin gen-vk --features circom-vk`
//! (which scripts/build-circuits.sh runs for you). Dev keys come from a
//! single-party setup with one random phase-2 contribution, so whoever ran
//! it could forge proofs; mainnet keys must come from a public multi-party
//! ceremony and be reproducible from its transcript.

pub mod login_vk;
pub mod owner_vk;
