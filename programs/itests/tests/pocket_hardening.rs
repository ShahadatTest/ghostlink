//! Compiled-program regressions for the Pocket hardening recorded in
//! docs/adr/0006-pocket-hardening.md. The world below rebuilds the fixture
//! pocket from the committed proofs on its own, so this file shares only
//! the generic harness in tests/common with the other test crates.
#![allow(dead_code)] // tests/common serves several test crates.

mod common;

use common::*;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const SNAPSHOT_SLOT: u64 = 123_456_789;
const OPEN_SLOT: u64 = 123_456_790;
const FILL_SLOT: u64 = 123_456_800;
const EXPIRY_SLOT: u64 = 123_500_000;
const UNIX_T: i64 = 1_800_000_000;
const TIMELOCK_SLOTS: u64 = 216_000;

// Custom error codes: 6000 + the variant's position in PocketError.
const PROOF_INVALID: &str = "Custom(6002)";
const WRONG_SIGNER: &str = "Custom(6019)";
const OUTPUT_TOO_LOW: &str = "Custom(6029)";
const BAD_ORACLE: &str = "Custom(6031)";
const STALE_ORACLE: &str = "Custom(6032)";
const BAD_TOKEN_ACCOUNT: &str = "Custom(6033)";
const POSITIONS_OPEN: &str = "Custom(6046)";
const DAILY_CAP_EXCEEDED: &str = "Custom(6026)";
const SESSION_REPLAYED: &str = "Custom(6039)";
const FREEZABLE_MINT: &str = "Custom(6047)";
const ORACLE_NOT_CANONICAL: &str = "Custom(6048)";
const ORACLE_CONFIDENCE: &str = "Custom(6049)";
// SPL Token's TokenError::MintCannotFreeze.
const MINT_CANNOT_FREEZE: &str = "Custom(16)";

struct World {
    h: Harness,
    v: serde_json::Value,
    session: Keypair,
    solver: Keypair,
    registry_tree: Pubkey,
    pocket: Pubkey,
    home: Pubkey,
    policy: Policy,
    usdc: [u8; 32],
    sol: [u8; 32],
    usdc_price: Pubkey,
    sol_price: Pubkey,
    /// The pocket's USDC (input) and SOL (priced output) accounts, and the solver's.
    pocket_usdc: Pubkey,
    pocket_sol: Pubkey,
    solver_usdc: Pubkey,
    solver_sol: Pubkey,
}

fn set_clock(h: &mut Harness, slot: u64) {
    h.svm.set_sysvar::<Clock>(&Clock { slot, epoch_start_timestamp: UNIX_T, epoch: 0, leader_schedule_epoch: 0,
        unix_timestamp: UNIX_T });
}

fn slot(w: &World) -> u64 {
    w.h.svm.get_sysvar::<Clock>().slot
}

fn hex_str(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Registers the fixture wallet, takes its census snapshot and opens the
/// fixture pocket with the committed proof for `policy`.
fn world(speculative: bool) -> World {
    let mut h = Harness::new();
    let v = vectors();
    let wallet = Keypair::new_from_array(hex32(v["identity"]["walletSeed"].as_str().unwrap()));
    let session = Keypair::new_from_array(hex32(v["identity"]["sessionSeed"].as_str().unwrap()));
    let registry_tree = pda(&[b"tree"], &pk(REGISTRY_ID));
    let app_id = fe(v["identity"]["appId"].as_str().unwrap());
    let pocket = pda(&[b"pocket", &app_id], &pk(POCKET_ID));
    let home = Pubkey::new_from_array(hex32(v["identity"]["homeAddress"].as_str().unwrap()));
    let policy = if speculative { speculative_policy() } else { feeds_policy() };
    let (usdc, sol) = (label("usdc mint"), label("sol mint"));

    set_clock(&mut h, SNAPSHOT_SLOT - 100);
    let payer = h.payer.pubkey();
    let init_registry = Instruction { program_id: pk(REGISTRY_ID),
        accounts: vec![AccountMeta::new(payer, true), meta_w(registry_tree), meta_r(pk(SYSTEM_ID))],
        data: ix_data("initialize", &()) };
    h.send(&[init_registry, census_initialize_ix(&payer)], &[]).expect("initialize trees");

    let commitment = fe(v["identity"]["commitment"].as_str().unwrap());
    let message = format!("ghostlink:register:v1\ncommitment:{}\nwallet:{}\nprogram:{}\ncluster:devnet",
        hex_str(&commitment), v["identity"]["walletBase58"].as_str().unwrap(), REGISTRY_ID).into_bytes();
    let register = Instruction { program_id: pk(REGISTRY_ID), accounts: vec![AccountMeta::new(payer, true),
        meta_r(wallet.pubkey()), meta_w(pda(&[b"binding", wallet.pubkey().as_ref()], &pk(REGISTRY_ID))),
        meta_w(registry_tree), meta_r(pk(SYSVAR_IX_ID)), meta_r(pk(SYSTEM_ID))],
        data: ix_data("register", &commitment) };
    let signature = sign64(&wallet, &message);
    h.send(&[ed25519_ix(&wallet.pubkey().to_bytes(), &signature, &message), register], &[]).expect("register");

    set_clock(&mut h, SNAPSHOT_SLOT);
    let holding = Pubkey::new_unique();
    h.svm.set_account(holding, token_account(&usdc, &wallet.pubkey(), 150_000_000)).unwrap();
    h.send(&[census_snapshot_ix(&payer, &wallet.pubkey(), &holding)], &[]).expect("snapshot");

    let mut w = World { h, v, session, solver: Keypair::new(), registry_tree, pocket, home, policy, usdc, sol,
        usdc_price: push_feed_address(&usdc_feed()), sol_price: push_feed_address(&sol_feed()),
        pocket_usdc: Pubkey::new_unique(), pocket_sol: Pubkey::new_unique(),
        solver_usdc: Pubkey::new_unique(), solver_sol: Pubkey::new_unique() };
    set_clock(&mut w.h, OPEN_SLOT);
    let proof = if speculative { "circuits/keys/login_speculative_proof.json" } else { "circuits/keys/login_proof.json" };
    let args = open_session_args(&w, proof, EXPIRY_SLOT, true);
    w.h.send(&[compute_budget(400_000), open_session_ix(&w, &args)], &[]).expect("open session");

    set_clock(&mut w.h, FILL_SLOT);
    w.h.svm.airdrop(&w.solver.pubkey(), 10_000_000_000).unwrap();
    let (pocket_key, solver_key) = (w.pocket, w.solver.pubkey());
    for (address, account) in [
        (w.pocket_usdc, token_account(&usdc, &pocket_key, 100_000_000)),
        (w.pocket_sol, token_account(&sol, &pocket_key, 0)),
        (w.solver_usdc, token_account(&usdc, &solver_key, 0)),
        (w.solver_sol, token_account(&sol, &solver_key, 10_000_000_000)),
    ] {
        w.h.svm.set_account(address, account).unwrap();
    }
    refresh_prices(&mut w);
    w
}

fn usdc_feed() -> [u8; 32] {
    label("usdc pyth feed")
}

fn sol_feed() -> [u8; 32] {
    label("sol pyth feed")
}

/// USDC at $1.00 and SOL at $156.25, published and posted now, in the
/// sponsored accounts the pocket pins for the policy's feeds.
fn refresh_prices(w: &mut World) {
    let (usdc_price, sol_price, now) = (w.usdc_price, w.sol_price, slot(w));
    w.h.svm.set_account(usdc_price, pyth_update(&usdc_feed(), 100_000_000, -8, 0, UNIX_T, now, true)).unwrap();
    w.h.svm.set_account(sol_price, pyth_update(&sol_feed(), 15_625_000_000, -8, 0, UNIX_T, now, true)).unwrap();
}

fn open_session_args(w: &World, proof_file: &str, expiry: u64, with_policy: bool) -> OpenSessionArgs {
    let fx = load_json(proof_file);
    let (a, b, c) = convert_proof(&fx["proof"]);
    let pubs = &w.v["circuits"]["login"]["public"];
    let mut key = [0u8; 33];
    key[..32].copy_from_slice(&w.session.pubkey().to_bytes());
    OpenSessionArgs { proof_a: a, proof_b: b, proof_c: c,
        registry_root: fe(pubs["registry_root"].as_str().unwrap()),
        census_root: fe(pubs["census_root"].as_str().unwrap()),
        domain_hash: fe(pubs["domain_hash"].as_str().unwrap()),
        app_id: fe(pubs["app_id"].as_str().unwrap()),
        mint: w.usdc, threshold: 100_000_000, min_slot: 123_450_000, claim_holdings: true,
        session_kind: 0, session_key: key, session_expiry_slot: expiry, home: w.home.to_bytes(),
        policy: if with_policy { Some(w.policy.clone()) } else { None } }
}

fn open_session_ix(w: &World, args: &OpenSessionArgs) -> Instruction {
    Instruction { program_id: pk(POCKET_ID), accounts: vec![AccountMeta::new(w.h.payer.pubkey(), true),
        meta_w(w.pocket), meta_r(w.registry_tree), meta_r(census_tree_pda()),
        meta_r(pk(SYSVAR_IX_ID)), meta_r(pk(SYSTEM_ID))], data: ix_data("open_session_v2", args) }
}

fn intent(w: &World, nonce: u64, in_mint: [u8; 32], in_max: u64, out_mint: [u8; 32], out_min: u64) -> IntentArgs {
    IntentArgs { nonce, in_mint, in_max, out_mint, out_min, deadline_slot: slot(w) + 100, policy_hash: w.policy.hash() }
}

fn intent_hash(w: &World, args: &IntentArgs) -> [u8; 32] {
    sha(&[&ghostlink_verifier::intent::Intent { pocket: w.pocket.to_bytes(), nonce: args.nonce,
        in_mint: args.in_mint, in_max: args.in_max, out_mint: args.out_mint, out_min: args.out_min,
        deadline_slot: args.deadline_slot, policy_hash: args.policy_hash }.to_bytes()])
}

fn session_sig(w: &World, digest: &[u8; 32]) -> Instruction {
    signed_by(&w.session, digest)
}

fn signed_by(key: &Keypair, digest: &[u8; 32]) -> Instruction {
    ed25519_ix(&key.pubkey().to_bytes(), &sign64(key, digest), digest)
}

/// The accounts one fill touches; `None` prices mean "this leg is unpriced".
struct Legs {
    pocket_in: Pubkey,
    solver_in: Pubkey,
    pocket_out: Pubkey,
    solver_out: Pubkey,
    in_price: Option<Pubkey>,
    out_price: Option<Pubkey>,
}

fn priced(w: &World) -> Legs {
    Legs { pocket_in: w.pocket_usdc, solver_in: w.solver_usdc, pocket_out: w.pocket_sol, solver_out: w.solver_sol,
        in_price: Some(w.usdc_price), out_price: Some(w.sol_price) }
}

/// [session signature, fill_begin, the solver's delivery..., fill_end].
fn fill_tx(w: &World, args: &IntentArgs, legs: &Legs, route: Vec<Instruction>) -> Vec<Instruction> {
    fill_tx_signed(w, &w.session, args, legs, route)
}

/// Like `fill_tx`, with the intent signed by `signer`.
fn fill_tx_signed(w: &World, signer: &Keypair, args: &IntentArgs, legs: &Legs, route: Vec<Instruction>) -> Vec<Instruction> {
    #[derive(borsh::BorshSerialize)]
    struct BeginArgs(IntentArgs, Option<WebauthnData>);
    let fill_state = pda(&[b"fill", w.pocket.as_ref(), &args.nonce.to_le_bytes()], &pk(POCKET_ID));
    let begin = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.solver.pubkey(), true), meta_w(w.pocket), meta_w(legs.pocket_in), meta_w(legs.solver_in),
        meta_r(legs.pocket_out), meta_r(legs.in_price.unwrap_or_else(|| pk(POCKET_ID))), meta_w(fill_state),
        meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID)), meta_r(pk(SYSTEM_ID)),
        meta_r(Pubkey::new_from_array(args.out_mint))],
        data: ix_data("fill_begin", &BeginArgs(args.clone(), None)) };
    let end = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.solver.pubkey(), true), meta_w(w.pocket), meta_w(fill_state), meta_r(legs.pocket_out),
        // Anchor optional account: the program id itself means None.
        meta_r(legs.out_price.unwrap_or_else(|| pk(POCKET_ID)))],
        data: ix_data("fill_end", args) };
    let mut tx = vec![signed_by(signer, &intent_hash(w, args)), begin];
    tx.extend(route);
    tx.push(end);
    tx
}

/// A fill whose route is one plain SPL transfer of `delivered` output units.
fn fill(w: &mut World, args: &IntentArgs, legs: &Legs, delivered: u64) -> Result<(), String> {
    let route = vec![spl_transfer(&legs.solver_out, &legs.pocket_out, &w.solver.pubkey(), delivered)];
    let tx = fill_tx(w, args, legs, route);
    let solver = w.solver.clone();
    w.h.send(&tx, &[&solver])
}

/// Sends `tx` and asserts a refusal with `code` that leaves the pocket and
/// every watched account exactly as they were.
fn refused_without_movement(w: &mut World, tx: &[Instruction], code: &str, watched: &[Pubkey]) {
    let before = (w.h.account_data(&w.pocket), watched.iter().map(|k| w.h.svm.get_account(k)).collect::<Vec<_>>());
    let solver = w.solver.clone();
    let err = w.h.send(tx, &[&solver]).expect_err("transaction unexpectedly succeeded");
    assert!(err.contains(code), "expected {code}: {err}");
    let after = (w.h.account_data(&w.pocket), watched.iter().map(|k| w.h.svm.get_account(k)).collect::<Vec<_>>());
    assert!(before == after, "a refused transaction changed state");
}

/// Like `Harness::send`, but returns the logs of the successful transaction.
fn send_with_logs(h: &mut Harness, instructions: &[Instruction], signers: &[&Keypair]) -> Vec<String> {
    h.svm.expire_blockhash();
    let payer = h.payer.clone();
    let mut all: Vec<&Keypair> = vec![&payer];
    all.extend_from_slice(signers);
    let message = solana_message::Message::new(instructions, Some(&payer.pubkey()));
    let tx = solana_transaction::Transaction::new(&all, message, h.svm.latest_blockhash());
    h.svm.send_transaction(tx).map(|meta| meta.logs).unwrap_or_else(|failed| panic!("{:?}", failed.err))
}

/// The `Program data:` log line an Anchor event with these Borsh fields produces.
fn event_log(name: &str, fields: &[&[u8]]) -> String {
    let mut payload = sha(&[format!("event:{name}").as_bytes()])[..8].to_vec();
    fields.iter().for_each(|field| payload.extend_from_slice(field));
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::from("Program data: ");
    for chunk in payload.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { CHARS[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
        }
    }
    out
}

fn owner_proof(name: &str) -> OwnerProofArgs {
    let actions = load_json("circuits/keys/owner_actions.json");
    owner_proof_from(&actions[name])
}

fn owner_proof_from(fx: &serde_json::Value) -> OwnerProofArgs {
    let (a, b, c) = convert_proof(&fx["proof"]);
    OwnerProofArgs { proof_a: a, proof_b: b, proof_c: c, registry_root: fe(fx["publicSignals"][0].as_str().unwrap()) }
}

fn sweep_ix(w: &World, auth: SessionOrOwner, pairs: &[(Pubkey, Pubkey)]) -> Instruction {
    let mut accounts = vec![AccountMeta::new(w.h.payer.pubkey(), true), meta_w(w.pocket), meta_w(w.home),
        meta_r(w.registry_tree), meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID))];
    for (source, destination) in pairs {
        accounts.extend([meta_w(*source), meta_w(*destination)]);
    }
    Instruction { program_id: pk(POCKET_ID), accounts, data: ix_data("sweep_home", &auth) }
}

fn propose_policy_ix(w: &World, policy: Policy, proof: OwnerProofArgs) -> Instruction {
    Instruction { program_id: pk(POCKET_ID), accounts: vec![AccountMeta::new(w.h.payer.pubkey(), true),
        meta_w(w.pocket), meta_r(w.registry_tree)], data: ix_data("propose_change", &(Change::Policy(policy), proof)) }
}

fn execute_ix(w: &World) -> Instruction {
    Instruction { program_id: pk(POCKET_ID), accounts: vec![AccountMeta::new(w.h.payer.pubkey(), true),
        meta_w(w.pocket)], data: ix_data("execute_change", &()) }
}

fn owner_action_nonce(w: &World) -> u64 {
    let data = w.h.account_data(&w.pocket).unwrap();
    let at = layout(&data).owner_action_nonce;
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

// ---- PocketV3 layout -------------------------------------------------------

/// Byte offsets of the PocketV3 fields after the variable-length policy and
/// pending change (programs/pocket/src/state.rs field order).
struct Layout {
    policy: usize,
    spending: usize,
    owner_action_nonce: usize,
    positions: usize,
}

fn policy_len(data: &[u8], at: usize) -> usize {
    let u32_at = |i: usize| u32::from_le_bytes(data[i..i + 4].try_into().unwrap()) as usize;
    let mut off = at + 8 + 2 + 8 + 8 + 8; // caps, slippage and session length
    off += 4 + 32 * u32_at(off); // allowed output mints
    off += 4 + 65 * u32_at(off); // oracle feed bindings
    if data[off] == 1 {
        off += 1 + 8 + 8 + 1;
        off += 4 + 32 * u32_at(off); // speculative base mints
    } else {
        off += 1;
    }
    off - at
}

fn layout(data: &[u8]) -> Layout {
    let policy = 8 + 32 + 32 + 32 + 1 + 33 + 8 + 8; // through the revocation epoch
    let mut off = policy + policy_len(data, policy);
    off += match (data[off], data[off + 1]) {
        (0, _) => 1,
        (1, 0) => 2 + 32 + 8,
        (1, 1) => 2 + policy_len(data, off + 2) + 8,
        tags => panic!("unexpected pending change tags {tags:?}"),
    };
    let spending = off;
    off += WINDOW; // the rolling spending window
    off += NONCE_BITMAP + 1 + 8 + 8; // nonce bitmap, bump, max session expiry, nonce base
    let owner_action_nonce = off;
    off += 8;
    let positions = off + WINDOW; // after the speculative buys window
    Layout { policy, spending, owner_action_nonce, positions }
}

const NONCE_BITMAP: usize = 256;
/// A RollingWindow: newest bucket index and 25 hourly amounts.
const WINDOW: usize = 8 + 25 * 8;

/// Open speculative positions as (mint, token account, quantity, cost).
fn positions(w: &World) -> Vec<([u8; 32], Pubkey, u64, u64)> {
    let data = w.h.account_data(&w.pocket).unwrap();
    let at = layout(&data).positions;
    (0..8).map(|i| at + i * 112).filter_map(|p| {
        let quantity = u64::from_le_bytes(data[p + 96..p + 104].try_into().unwrap());
        (quantity != 0).then(|| (data[p..p + 32].try_into().unwrap(), Pubkey::try_from(&data[p + 64..p + 96]).unwrap(),
            quantity, u64::from_le_bytes(data[p + 104..p + 112].try_into().unwrap())))
    }).collect()
}

fn stored_policy(w: &World) -> Vec<u8> {
    let data = w.h.account_data(&w.pocket).unwrap();
    let at = layout(&data).policy;
    data[at..at + policy_len(&data, at)].to_vec()
}

// ---- Finding 1: frozen speculative positions -------------------------------

/// An unpriced asset the pocket may buy, with its own pocket and solver accounts.
struct Asset {
    mint: [u8; 32],
    pocket_account: Pubkey,
    solver_account: Pubkey,
}

fn asset(w: &mut World, name: &str, freeze_authority: Option<&Pubkey>) -> Asset {
    let mint = label(name);
    let a = Asset { mint, pocket_account: Pubkey::new_unique(), solver_account: Pubkey::new_unique() };
    let (pocket, solver) = (w.pocket, w.solver.pubkey());
    w.h.svm.set_account(Pubkey::new_from_array(mint), mint_account(6, freeze_authority)).unwrap();
    w.h.svm.set_account(a.pocket_account, token_account(&mint, &pocket, 0)).unwrap();
    w.h.svm.set_account(a.solver_account, token_account(&mint, &solver, 1_000_000)).unwrap();
    a
}

fn buy_legs(w: &World, a: &Asset) -> Legs {
    Legs { pocket_in: w.pocket_usdc, solver_in: w.solver_usdc, pocket_out: a.pocket_account,
        solver_out: a.solver_account, in_price: Some(w.usdc_price), out_price: None }
}

/// Puts the account into the SPL frozen state. The buy check makes this
/// unreachable for positions bought by this program; recovery must cope anyway.
fn freeze(w: &mut World, account: &Pubkey) {
    let mut frozen = w.h.svm.get_account(account).unwrap();
    frozen.data[108] = 2;
    w.h.svm.set_account(*account, frozen).unwrap();
}

#[test]
fn speculative_buys_refuse_mints_with_a_freeze_authority() {
    let mut w = world(true);
    let issuer = Keypair::new();
    let freezable = asset(&mut w, "freezable token", Some(&issuer.pubkey()));
    let args = intent(&w, 7, w.usdc, 10_000_000, freezable.mint, 100);
    let legs = buy_legs(&w, &freezable);
    let tx = fill_tx(&w, &args, &legs, vec![spl_transfer(&freezable.solver_account, &freezable.pocket_account,
        &w.solver.pubkey(), 100)]);
    let watched = [w.pocket_usdc, w.solver_usdc, freezable.pocket_account, freezable.solver_account];
    refused_without_movement(&mut w, &tx, FREEZABLE_MINT, &watched);

    // A mint account that is not the intent's output mint is refused too.
    let fixed = asset(&mut w, "fixed supply token", None);
    let mut swapped = fill_tx(&w, &intent(&w, 8, w.usdc, 10_000_000, fixed.mint, 100), &buy_legs(&w, &fixed),
        vec![spl_transfer(&fixed.solver_account, &fixed.pocket_account, &w.solver.pubkey(), 100)]);
    swapped[1].accounts[10] = meta_r(Pubkey::new_from_array(freezable.mint));
    let watched = [w.pocket_usdc, fixed.pocket_account];
    refused_without_movement(&mut w, &swapped, BAD_TOKEN_ACCOUNT, &watched);

    // The same buy of a mint without a freeze authority settles, and its
    // issuer can never freeze the position afterwards.
    let args = intent(&w, 9, w.usdc, 10_000_000, fixed.mint, 100);
    let legs = buy_legs(&w, &fixed);
    fill(&mut w, &args, &legs, 100).expect("buy of a mint without a freeze authority");
    assert_eq!(positions(&w), vec![(fixed.mint, fixed.pocket_account, 100, 10_000_000)]);
    let freeze_ix = Instruction { program_id: pk(TOKEN_ID), accounts: vec![meta_w(fixed.pocket_account),
        meta_r(Pubkey::new_from_array(fixed.mint)), AccountMeta::new_readonly(issuer.pubkey(), true)], data: vec![10] };
    let err = w.h.send_expect_err(&[freeze_ix], &[&issuer]);
    assert!(err.contains(MINT_CANNOT_FREEZE), "{err}");
}

#[test]
fn owner_writes_off_a_frozen_position_and_unblocks_the_policy_change() {
    let mut w = world(true);
    let token = asset(&mut w, "fixed supply token", None);
    let args = intent(&w, 7, w.usdc, 10_000_000, token.mint, 100);
    let legs = buy_legs(&w, &token);
    fill(&mut w, &args, &legs, 100).expect("speculative buy");
    let priced_args = intent(&w, 8, w.usdc, 25_000_000, w.sol, 160_000_000);
    let legs = priced(&w);
    fill(&mut w, &priced_args, &legs, 160_000_000).expect("priced buy");
    freeze(&mut w, &token.pocket_account);

    let proposal = load_json("circuits/keys/owner_speculative_policy_proof.json");
    let propose = propose_policy_ix(&w, feeds_policy(), owner_proof_from(&proposal));
    w.h.send(&[compute_budget(400_000), propose], &[]).expect("owner stages the conservative policy");
    set_clock(&mut w.h, FILL_SLOT + TIMELOCK_SLOTS);
    let err = w.h.send_expect_err(&[execute_ix(&w)], &[]);
    assert!(err.contains(POSITIONS_OPEN), "the frozen position blocks the change: {err}");

    // One owner recovery: the frozen account is skipped instead of failing
    // the batch, its position is written off, and the other balance goes home.
    let (home_token, home_sol) = (Pubkey::new_unique(), Pubkey::new_unique());
    let (mint, sol, home) = (token.mint, w.sol, w.home);
    w.h.svm.set_account(home_token, token_account(&mint, &home, 0)).unwrap();
    w.h.svm.set_account(home_sol, token_account(&sol, &home, 0)).unwrap();
    let sweep = sweep_ix(&w, SessionOrOwner::Owner(owner_proof("sweepAfterAction")),
        &[(token.pocket_account, home_token), (w.pocket_sol, home_sol)]);
    let logs = send_with_logs(&mut w.h, &[compute_budget(400_000), sweep], &[]);
    assert!(positions(&w).is_empty(), "the frozen position was written off");
    let written_off = event_log("PositionWrittenOff", &[w.pocket.as_ref(), token.pocket_account.as_ref(), &token.mint,
        &100u64.to_le_bytes(), &10_000_000u64.to_le_bytes()]);
    assert!(logs.contains(&written_off), "PositionWrittenOff event missing: {logs:?}");
    assert_eq!(w.h.token_balance(&home_sol), Some(160_000_000));
    assert_eq!(w.h.token_balance(&token.pocket_account), Some(100), "frozen tokens stay in the pocket's account");
    assert_eq!(w.h.token_balance(&home_token), Some(0));

    w.h.send(&[execute_ix(&w)], &[]).expect("the policy change is no longer blocked");
    assert_eq!(stored_policy(&w), borsh::to_vec(&feeds_policy()).unwrap());
}

#[test]
fn session_sweeps_skip_a_frozen_account_without_writing_it_off() {
    let mut w = world(true);
    let token = asset(&mut w, "fixed supply token", None);
    let args = intent(&w, 7, w.usdc, 10_000_000, token.mint, 100);
    let legs = buy_legs(&w, &token);
    fill(&mut w, &args, &legs, 100).expect("speculative buy");
    let priced_args = intent(&w, 8, w.usdc, 25_000_000, w.sol, 160_000_000);
    let legs = priced(&w);
    fill(&mut w, &priced_args, &legs, 160_000_000).expect("priced buy");
    freeze(&mut w, &token.pocket_account);

    let (home_token, home_sol) = (Pubkey::new_unique(), Pubkey::new_unique());
    let (mint, sol, home) = (token.mint, w.sol, w.home);
    w.h.svm.set_account(home_token, token_account(&mint, &home, 0)).unwrap();
    w.h.svm.set_account(home_sol, token_account(&sol, &home, 0)).unwrap();
    let digest = sha(&[b"ghostlink:sweep:v1", w.pocket.as_ref(), &owner_action_nonce(&w).to_le_bytes()]);
    let sweep = sweep_ix(&w, SessionOrOwner::Session { webauthn: None },
        &[(token.pocket_account, home_token), (w.pocket_sol, home_sol)]);
    let tx = [session_sig(&w, &digest), sweep];
    let logs = send_with_logs(&mut w.h, &tx, &[]);
    assert_eq!(w.h.token_balance(&home_sol), Some(160_000_000), "a frozen account does not fail the batch");
    assert_eq!(w.h.token_balance(&token.pocket_account), Some(100));
    assert!(!logs.iter().any(|line| line.starts_with("Program data: ") &&
        line == &event_log("PositionWrittenOff", &[w.pocket.as_ref(), token.pocket_account.as_ref(), &token.mint,
            &100u64.to_le_bytes(), &10_000_000u64.to_le_bytes()])));
    assert_eq!(positions(&w), vec![(token.mint, token.pocket_account, 100, 10_000_000)],
        "only an owner proof writes off a position");
}

// ---- Finding 5: unsynced wrapped SOL ---------------------------------------

/// The rent-exempt reserve SPL records in a native account's is_native field.
const NATIVE_RESERVE: u64 = 2_039_280;

/// A wrapped-SOL token account: SPL's is_native reserve is set, the token
/// amount says `amount`, and `unsynced` more lamports sit in it unsynced.
fn native_account(mint: &[u8; 32], owner: &Pubkey, amount: u64, unsynced: u64) -> solana_account::Account {
    let mut account = token_account(mint, owner, amount);
    account.data[109..113].copy_from_slice(&1u32.to_le_bytes());
    account.data[113..121].copy_from_slice(&NATIVE_RESERVE.to_le_bytes());
    account.lamports = NATIVE_RESERVE + amount + unsynced;
    account
}

/// SPL Token SyncNative (instruction 17): anyone may call it.
fn sync_native(account: &Pubkey) -> Instruction {
    Instruction { program_id: pk(TOKEN_ID), accounts: vec![meta_w(*account)], data: vec![17] }
}

#[test]
fn unsynced_wrapped_sol_in_the_output_account_never_counts_as_delivery() {
    let mut w = world(false);
    // The pocket's wrapped-SOL output account already holds 0.16 SOL that
    // someone sent as plain lamports and nobody synced. The SPL is_native
    // field, not the mint, is what makes an account native.
    let (pocket_wsol, solver_wsol) = (Pubkey::new_unique(), Pubkey::new_unique());
    let (sol, pocket, solver) = (w.sol, w.pocket, w.solver.pubkey());
    w.h.svm.set_account(pocket_wsol, native_account(&sol, &pocket, 0, 160_000_000)).unwrap();
    w.h.svm.set_account(solver_wsol, native_account(&sol, &solver, 1_000_000_000, 0)).unwrap();
    let legs = Legs { pocket_out: pocket_wsol, solver_out: solver_wsol, ..priced(&w) };
    let args = intent(&w, 7, w.usdc, 25_000_000, w.sol, 160_000_000);
    let watched = [w.pocket_usdc, w.solver_usdc, pocket_wsol, solver_wsol];

    // A route that only syncs the pocket's own lamports delivers nothing.
    let tx = fill_tx(&w, &args, &legs, vec![sync_native(&pocket_wsol)]);
    refused_without_movement(&mut w, &tx, OUTPUT_TOO_LOW, &watched);
    // Syncing them and topping up with less than the minimum is still short.
    // (This token program's SyncNative also lowers the recorded rent reserve
    // to the current rent, so "lamports minus reserve" would count part of
    // the pocket's own reserve as delivery here; lamports do not move.)
    let tx = fill_tx(&w, &args, &legs, vec![sync_native(&pocket_wsol),
        spl_transfer(&solver_wsol, &pocket_wsol, &solver, 159_999_999)]);
    refused_without_movement(&mut w, &tx, OUTPUT_TOO_LOW, &watched);

    // A real delivery is measured above the unsynced balance and settles.
    fill(&mut w, &args, &legs, 160_000_000).expect("delivery on top of unsynced lamports");
    assert_eq!(w.h.svm.get_account(&pocket_wsol).unwrap().lamports, NATIVE_RESERVE + 320_000_000,
        "the pocket keeps its own lamports and receives the full delivery");
    assert_eq!(w.h.token_balance(&w.solver_usdc), Some(25_000_000));

    // Lamports a route adds during the fill are delivery, synced or not.
    let args = intent(&w, 8, w.usdc, 25_000_000, w.sol, 160_000_000);
    let lamports = Instruction { program_id: pk(SYSTEM_ID), accounts: vec![AccountMeta::new(solver, true), meta_w(pocket_wsol)],
        data: [2u32.to_le_bytes().as_slice(), 160_000_000u64.to_le_bytes().as_slice()].concat() };
    let tx = fill_tx(&w, &args, &legs, vec![lamports]);
    let solver_key = w.solver.clone();
    w.h.send(&tx, &[&solver_key]).expect("an unsynced delivery during the fill counts");
    assert_eq!(w.h.token_balance(&w.solver_usdc), Some(50_000_000));
}

// ---- Finding 2: pinned, fresh, confident oracle accounts -------------------

/// A USDC price update with every field the pocket checks under control.
fn usdc_update(conf: u64, publish_time: i64, posted_slot: u64, full: bool) -> solana_account::Account {
    pyth_update(&usdc_feed(), 100_000_000, -8, conf, publish_time, posted_slot, full)
}

#[test]
fn oracle_prices_come_only_from_the_fresh_confident_sponsored_account() {
    let mut w = world(false);
    // The pocket derives the only acceptable account from the pinned feed id;
    // TypeScript derives the same addresses (vectors.json).
    let feeds = w.v["pdas"]["pythPushFeeds"].as_array().unwrap().clone();
    assert_eq!(feeds.len(), 2);
    for (feed, account) in feeds.iter().zip([w.usdc_price, w.sol_price]) {
        assert_eq!(push_feed_address(&hex32(feed["feedId"].as_str().unwrap())), account);
        assert_eq!(feed["address"].as_str().unwrap(), account.to_string());
    }
    let now = slot(&w);
    let args = intent(&w, 7, w.usdc, 25_000_000, w.sol, 160_000_000);
    let watched = [w.pocket_usdc, w.solver_usdc, w.pocket_sol, w.solver_sol];
    let deliver = |w: &World| vec![spl_transfer(&w.solver_sol, &w.pocket_sol, &w.solver.pubkey(), 160_000_000)];

    // A receiver-owned update with the right feed at any other address: the
    // solver can no longer bring its own posted update.
    let elsewhere = Pubkey::new_unique();
    w.h.svm.set_account(elsewhere, usdc_update(0, UNIX_T, now, true)).unwrap();
    let legs = Legs { in_price: Some(elsewhere), ..priced(&w) };
    let tx = fill_tx(&w, &args, &legs, deliver(&w));
    refused_without_movement(&mut w, &tx, ORACLE_NOT_CANONICAL, &watched);
    // The same for the output leg's price in fill_end.
    let sol_elsewhere = Pubkey::new_unique();
    w.h.svm.set_account(sol_elsewhere, pyth_update(&sol_feed(), 15_625_000_000, -8, 0, UNIX_T, now, true)).unwrap();
    let legs = Legs { out_price: Some(sol_elsewhere), ..priced(&w) };
    let tx = fill_tx(&w, &args, &legs, deliver(&w));
    refused_without_movement(&mut w, &tx, ORACLE_NOT_CANONICAL, &watched);

    let usdc_price = w.usdc_price;
    let refusals: [(solana_account::Account, &str); 6] = [
        // Confidence interval wider than 1% of the price.
        (usdc_update(1_000_001, UNIX_T, now, true), ORACLE_CONFIDENCE),
        // Published more than 30 seconds ago.
        (usdc_update(0, UNIX_T - 31, now, true), STALE_ORACLE),
        // Posted more than 75 slots ago.
        (usdc_update(0, UNIX_T, now - 76, true), STALE_ORACLE),
        // Partially verified (fewer guardian signatures checked).
        (usdc_update(0, UNIX_T, now, false), BAD_ORACLE),
        // Right address, wrong owner.
        ({ let mut a = usdc_update(0, UNIX_T, now, true); a.owner = pk(SYSTEM_ID); a }, BAD_ORACLE),
        // Right address and owner, another feed's update.
        (pyth_update(&sol_feed(), 100_000_000, -8, 0, UNIX_T, now, true), BAD_ORACLE),
    ];
    for (account, code) in refusals {
        w.h.svm.set_account(usdc_price, account).unwrap();
        let tx = fill_tx(&w, &args, &priced(&w), deliver(&w));
        refused_without_movement(&mut w, &tx, code, &watched);
    }

    // At exactly the bounds (1% confidence, 30 s, 75 slots) the fill settles.
    w.h.svm.set_account(usdc_price, usdc_update(1_000_000, UNIX_T - 30, now - 75, true)).unwrap();
    let legs = priced(&w);
    fill(&mut w, &args, &legs, 160_000_000).expect("a fresh, confident sponsored price");
    assert_eq!(w.h.token_balance(&w.pocket_sol), Some(160_000_000));
}

// ---- Finding 3: rolling daily cap -------------------------------------------

/// programs/pocket/src/window.rs: one-hour buckets, the current one and the 24 before it.
const BUCKET_SLOTS: u64 = 9_000;
const BUCKETS: u64 = 25;

/// Moves the clock and republishes both prices at the new slot.
fn set_slot(w: &mut World, slot: u64) {
    set_clock(&mut w.h, slot);
    refresh_prices(w);
}

/// Priced spending the window still counts at the current slot, read from
/// the account bytes the way RollingWindow::total computes it.
fn spent_in_window(w: &World) -> u64 {
    let data = w.h.account_data(&w.pocket).unwrap();
    let at = layout(&data).spending;
    let u64_at = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    let (latest, now) = (u64_at(at), slot(w) / BUCKET_SLOTS);
    (0..BUCKETS).filter(|i| {
        // Index i holds the newest bucket at or before `latest` with that remainder.
        let bucket = latest - (latest + BUCKETS - i) % BUCKETS;
        now < latest || now - bucket < BUCKETS
    }).map(|i| u64_at(at + 8 + 8 * i as usize)).sum()
}

/// Renews the fixture session for another day with the committed proof.
fn renew(w: &mut World) {
    let mut args = open_session_args(w, "circuits/keys/login_speculative_renew_proof.json", EXPIRY_SLOT + TIMELOCK_SLOTS, false);
    args.claim_holdings = false;
    let ix = open_session_ix(w, &args);
    w.h.send(&[compute_budget(400_000), ix], &[]).expect("renew the session for another day");
}

#[test]
fn the_daily_cap_cannot_be_exceeded_across_a_window_boundary() {
    let mut w = world(true); // $200 daily cap; a software session spends at most $50 at a time.
    let (usdc, pocket) = (w.usdc, w.pocket);
    w.h.svm.set_account(w.pocket_usdc, token_account(&usdc, &pocket, 1_000_000_000)).unwrap();
    let legs = priced(&w);
    let mut nonce = 100;
    let mut spend_25 = |w: &mut World| -> Result<(), String> {
        nonce += 1;
        let args = intent(w, nonce, w.usdc, 25_000_000, w.sol, 160_000_000);
        fill(w, &args, &legs, 160_000_000)
    };
    let refused = |result: Result<(), String>| {
        let err = result.expect_err("spending past the cap must be refused");
        assert!(err.contains(DAILY_CAP_EXCEEDED), "{err}");
    };

    for _ in 0..7 {
        spend_25(&mut w).expect("$175 of the $200 cap");
    }
    // The fixed day began when the pocket opened and reset 24 hours later.
    let old_reset = OPEN_SLOT + TIMELOCK_SLOTS;
    set_slot(&mut w, old_reset - 789);
    renew(&mut w);
    set_slot(&mut w, old_reset - 1);
    spend_25(&mut w).expect("the last $25 of the cap");
    assert_eq!(spent_in_window(&w), 200_000_000);
    // A fixed day would reset one slot later and allow another full cap.
    set_slot(&mut w, old_reset);
    refused(spend_25(&mut w));

    // The first $175 leaves when its hour leaves the window: still counted
    // in the last slot of the 25th hour, gone in the next one.
    let leaves = (FILL_SLOT / BUCKET_SLOTS + BUCKETS) * BUCKET_SLOTS;
    set_slot(&mut w, leaves - 1);
    refused(spend_25(&mut w));
    set_slot(&mut w, leaves);
    assert_eq!(spent_in_window(&w), 25_000_000);
    for _ in 0..7 {
        spend_25(&mut w).expect("the released budget");
    }
    assert_eq!(spent_in_window(&w), 200_000_000);
    refused(spend_25(&mut w));
}

// ---- Finding 4: revocation epoch ---------------------------------------------

/// The pocket's revocation epoch, at its fixed offset after the session fields.
fn authorization_epoch(w: &World) -> u64 {
    let data = w.h.account_data(&w.pocket).unwrap();
    u64::from_le_bytes(data[146..154].try_into().unwrap())
}

fn session_expiry(w: &World) -> u64 {
    let data = w.h.account_data(&w.pocket).unwrap();
    u64::from_le_bytes(data[138..146].try_into().unwrap())
}

fn revoke_ix(w: &World, auth: SessionOrOwner) -> Instruction {
    Instruction { program_id: pk(POCKET_ID), accounts: vec![AccountMeta::new(w.h.payer.pubkey(), true),
        meta_w(w.pocket), meta_r(w.registry_tree), meta_r(pk(SYSVAR_IX_ID))], data: ix_data("revoke_session", &auth) }
}

/// The committed passkey rotation: authorized for epoch 0, expiring later
/// than the live session, never submitted.
fn held_rotation(w: &World) -> OpenSessionArgs {
    let fx = load_json("circuits/keys/login_p256_proof.json");
    let mut args = open_session_args(w, "circuits/keys/login_p256_proof.json", EXPIRY_SLOT + 1, false);
    args.session_kind = 1;
    args.session_key = hexv(fx["compressedPubkey"].as_str().unwrap()).try_into().unwrap();
    args
}

/// Whether `instructions` would succeed now, tried on a copy of the chain.
fn succeeds_on_a_copy(w: &World, instructions: &[Instruction]) -> bool {
    let mut copy = w.h.svm.clone();
    copy.expire_blockhash();
    let message = solana_message::Message::new(instructions, Some(&w.h.payer.pubkey()));
    copy.send_transaction(solana_transaction::Transaction::new(&[&w.h.payer], message, copy.latest_blockhash())).is_ok()
}

#[test]
fn a_revoke_retires_every_session_authorization_issued_before_it() {
    let mut w = world(false);
    assert_eq!(authorization_epoch(&w), 0);
    let held = held_rotation(&w);
    let open_held = [compute_budget(400_000), open_session_ix(&w, &held)];
    assert!(succeeds_on_a_copy(&w, &open_held), "before the revoke the held authorization opens its session");
    // An earlier session's authorization is refused by the expiry replay guard.
    let replay = open_session_args(&w, "circuits/keys/login_proof.json", EXPIRY_SLOT, false);
    let err = w.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&w, &replay)], &[]);
    assert!(err.contains(SESSION_REPLAYED), "{err}");

    let revoke = revoke_ix(&w, SessionOrOwner::Owner(owner_proof("revoke")));
    w.h.send(&[compute_budget(400_000), revoke], &[]).expect("owner revoke");
    assert_eq!((authorization_epoch(&w), session_expiry(&w)), (1, 0));

    // Issued before the revoke, it can never open a session afterwards,
    // although it expires later than any session the pocket has had.
    let err = w.h.send_expect_err(&open_held, &[]);
    assert!(err.contains(PROOF_INVALID), "{err}");
    let err = w.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&w, &replay)], &[]);
    assert!(err.contains(PROOF_INVALID), "{err}");
    assert_eq!((authorization_epoch(&w), session_expiry(&w)), (1, 0), "still revoked");

    // Owner software proves for the current epoch, with a fresh key.
    let rotated = Keypair::new_from_array(label("revoked pocket session seed"));
    let mut fresh = open_session_args(&w, "circuits/keys/login_after_revoke_proof.json", EXPIRY_SLOT + 2, false);
    fresh.claim_holdings = false;
    fresh.session_key[..32].copy_from_slice(&rotated.pubkey().to_bytes());
    w.h.send(&[compute_budget(400_000), open_session_ix(&w, &fresh)], &[]).expect("an authorization for epoch 1");
    assert_eq!(session_expiry(&w), EXPIRY_SLOT + 2);

    // The revoked key's intents stay dead; the new key trades.
    let args = intent(&w, 7, w.usdc, 25_000_000, w.sol, 160_000_000);
    let legs = priced(&w);
    let route = || vec![spl_transfer(&w.solver_sol, &w.pocket_sol, &w.solver.pubkey(), 160_000_000)];
    let stale = fill_tx(&w, &args, &legs, route());
    let fresh_fill = fill_tx_signed(&w, &rotated, &args, &legs, route());
    let watched = [w.pocket_usdc, w.pocket_sol];
    refused_without_movement(&mut w, &stale, WRONG_SIGNER, &watched);
    let solver = w.solver.clone();
    w.h.send(&fresh_fill, &[&solver]).expect("the post-revoke session trades");
    assert_eq!(w.h.token_balance(&w.pocket_sol), Some(160_000_000));
}

#[test]
fn a_session_signed_revoke_raises_the_epoch_too() {
    let mut w = world(false);
    let digest = sha(&[b"ghostlink:revoke:v1", w.pocket.as_ref(), &0u64.to_le_bytes()]);
    let tx = [session_sig(&w, &digest), revoke_ix(&w, SessionOrOwner::Session { webauthn: None })];
    w.h.send(&tx, &[]).expect("the session revokes itself");
    assert_eq!((authorization_epoch(&w), session_expiry(&w)), (1, 0));
    let held = held_rotation(&w);
    let err = w.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&w, &held)], &[]);
    assert!(err.contains(PROOF_INVALID), "{err}");
}
