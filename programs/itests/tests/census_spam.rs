//! Spam resistance of the census and registry root histories (ADR 0005),
//! with the compiled programs under LiteSVM:
//!
//! - roots are kept one per 150-slot bucket, so any number of appends
//!   inside a bucket cannot push an earlier bucket's root out of the ring,
//!   and the committed fixture proof still opens a pocket after the spam;
//! - every snapshot pays the configured fee into the fee vault, which only
//!   the program's upgrade authority can change or withdraw;
//! - a snapshot runs only at the top level of a transaction that holds
//!   nothing but compute-budget and snapshot instructions;
//! - a full tree is still refused, without charging the fee.

#[allow(dead_code)]
mod common;

use common::*;
use ghostlink_verifier::merkle::{tree_account, ROOT_BUCKET_SLOTS, ROOT_HISTORY};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const UNIX_T: i64 = 1_800_000_000;
/// The committed fixture proof binds a census snapshot taken at this slot.
const SNAPSHOT_SLOT: u64 = 123_456_789;
const EXPIRY_SLOT: u64 = 123_500_000;
const BPF_LOADER_UPGRADEABLE: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

fn set_clock(h: &mut Harness, slot: u64) {
    h.svm.set_sysvar::<Clock>(&Clock {
        slot,
        epoch_start_timestamp: UNIX_T,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: UNIX_T,
    });
}

fn bucket_start(bucket: u64) -> u64 {
    bucket * ROOT_BUCKET_SLOTS
}

fn registry_tree_pda() -> Pubkey {
    pda(&[b"tree"], &pk(REGISTRY_ID))
}

/// The ring fields of a TreeState account.
struct Ring {
    next_index: u64,
    roots: Vec<[u8; 32]>,
    slots: Vec<u64>,
    cursor: usize,
}

impl Ring {
    fn read(h: &Harness, tree: &Pubkey) -> Ring {
        let data = h.account_data(tree).expect("tree account");
        assert_eq!(data.len(), tree_account::ACCOUNT_LEN, "TreeState layout");
        let u64_at = |off: usize| u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        Ring {
            next_index: u64_at(8),
            roots: (0..ROOT_HISTORY)
                .map(|i| {
                    let off = tree_account::ROOTS_OFFSET + 32 * i;
                    data[off..off + 32].try_into().unwrap()
                })
                .collect(),
            slots: (0..ROOT_HISTORY).map(|i| u64_at(tree_account::ROOT_SLOTS_OFFSET + 8 * i)).collect(),
            cursor: usize::from(data[tree_account::CURSOR_OFFSET]),
        }
    }

    fn newest(&self) -> [u8; 32] {
        self.roots[self.cursor]
    }

    fn contains(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

fn lamports(h: &Harness, address: &Pubkey) -> u64 {
    h.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
}

fn initialize_census(h: &mut Harness) {
    let ix = census_initialize_ix(&h.payer.pubkey());
    h.send(&[ix], &[]).expect("initialize census");
}

fn initialize_registry(h: &mut Harness) {
    let ix = Instruction {
        program_id: pk(REGISTRY_ID),
        accounts: vec![
            AccountMeta::new(h.payer.pubkey(), true),
            meta_w(registry_tree_pda()),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("initialize", &()),
    };
    h.send(&[ix], &[]).expect("initialize registry");
}

/// Native-SOL snapshot of an arbitrary address: the cheapest spam there is.
fn spam_ix(h: &Harness) -> Instruction {
    let target = Pubkey::new_unique();
    census_snapshot_ix(&h.payer.pubkey(), &target, &target)
}

fn snapshot_native(h: &mut Harness, wallet: &Pubkey) -> Result<(), String> {
    let ix = census_snapshot_ix(&h.payer.pubkey(), wallet, wallet);
    h.send(&[ix], &[])
}

fn system_transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec(); // SystemInstruction::Transfer
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: pk(SYSTEM_ID),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

fn program_data_pda() -> Pubkey {
    pda(&[pk(CENSUS_ID).as_ref()], &pk(BPF_LOADER_UPGRADEABLE))
}

/// Rewrites the census ProgramData's upgrade authority. LiteSVM deploys
/// programs with none, the shape of an immutable deployment.
fn set_upgrade_authority(h: &mut Harness, authority: Option<&Pubkey>) {
    let address = program_data_pda();
    let mut account = h.svm.get_account(&address).expect("census program data");
    // bincode UpgradeableLoaderState::ProgramData: tag u32 = 3 | slot u64 |
    // Option<Pubkey> tag u8 | authority [32].
    assert_eq!(&account.data[0..4], &3u32.to_le_bytes());
    match authority {
        Some(key) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(key.as_ref());
        }
        None => {
            account.data[12] = 0;
            account.data[13..45].fill(0);
        }
    }
    h.svm.set_account(address, account).unwrap();
}

fn set_fee_ix(authority: &Pubkey, fee_lamports: u64) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            meta_r(program_data_pda()),
            meta_w(census_config_pda()),
        ],
        data: ix_data("set_fee", &fee_lamports),
    }
}

fn withdraw_fees_ix(authority: &Pubkey, recipient: &Pubkey, lamports: u64) -> Instruction {
    Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            meta_r(program_data_pda()),
            meta_w(census_fee_vault_pda()),
            meta_w(*recipient),
        ],
        data: ix_data("withdraw_fees", &lamports),
    }
}

fn config_fee(h: &Harness) -> u64 {
    let data = h.account_data(&census_config_pda()).expect("census config");
    u64::from_le_bytes(data[8..16].try_into().unwrap())
}

fn funded_keypair(h: &mut Harness) -> Keypair {
    let kp = Keypair::new();
    h.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    kp
}

fn assert_custom(err: &str, code: u32, name: &str) {
    assert!(err.contains(&format!("Custom({code})")) || err.contains(name), "expected {name}: {err}");
}

#[test]
fn spam_inside_one_bucket_cannot_evict_an_earlier_root() {
    let mut h = Harness::new();
    let tree = census_tree_pda();
    set_clock(&mut h, bucket_start(1_000) + 3);
    initialize_census(&mut h);

    // One snapshot in bucket 1,001: the root a prover would be using.
    set_clock(&mut h, bucket_start(1_001) + 10);
    let wallet = Pubkey::new_unique();
    snapshot_native(&mut h, &wallet).expect("first snapshot");
    let before = Ring::read(&h, &tree);
    let proven_root = before.newest();

    // 200 snapshots, ten per transaction, all inside bucket 1,002: far
    // more than the 128 entries the ring has.
    for batch in 0..20u64 {
        set_clock(&mut h, bucket_start(1_002) + batch * 7);
        let ixs: Vec<Instruction> = (0..10).map(|_| spam_ix(&h)).collect();
        h.send(&ixs, &[]).expect("snapshot batch");
    }

    let after = Ring::read(&h, &tree);
    assert_eq!(after.next_index, 201, "every snapshot was appended");
    assert!(after.contains(&proven_root), "the earlier bucket's root survives the spam");
    assert!(
        tree_account::ring_contains(&h.account_data(&tree).unwrap(), &proven_root),
        "and the pocket's raw ring reader finds it"
    );
    assert_eq!(after.cursor, (before.cursor + 1) % ROOT_HISTORY, "the whole burst used one ring entry");
    assert_eq!(after.slots[after.cursor], bucket_start(1_002) + 19 * 7);
    assert_eq!(after.roots.iter().filter(|r| **r != [0u8; 32]).count(), 3, "init, bucket 1,001, bucket 1,002");
}

#[test]
fn ring_keeps_one_root_per_bucket_and_only_time_evicts() {
    let mut h = Harness::new();
    let tree = census_tree_pda();
    set_clock(&mut h, bucket_start(5_000));
    initialize_census(&mut h);
    let empty_root = Ring::read(&h, &tree).newest();

    let first = 5_001u64;
    let buckets = ROOT_HISTORY as u64 + 2;
    let mut finals = Vec::new();
    let mut superseded = Vec::new();
    for b in first..first + buckets {
        for k in 0..2u64 {
            set_clock(&mut h, bucket_start(b) + 40 * k);
            snapshot_native(&mut h, &Pubkey::new_unique()).expect("snapshot");
            let root = Ring::read(&h, &tree).newest();
            if k == 0 { superseded.push(root) } else { finals.push(root) }
        }
    }

    let ring = Ring::read(&h, &tree);
    assert_eq!(ring.next_index, 2 * buckets);
    assert_eq!(ring.cursor, buckets as usize % ROOT_HISTORY, "one push per bucket");
    for (i, root) in finals.iter().enumerate() {
        // The newest 128 buckets are kept; the two oldest are evicted.
        assert_eq!(ring.contains(root), i >= 2, "bucket {} final root", first + i as u64);
    }
    assert!(superseded.iter().all(|r| !ring.contains(r)), "a bucket keeps only its last root");
    assert!(!ring.contains(&empty_root), "the initial entry is evicted like any other");
    let last = first + buckets - 1;
    assert_eq!(ring.slots[ring.cursor], bucket_start(last) + 40);
    for (i, slot) in ring.slots.iter().enumerate() {
        let b = slot / ROOT_BUCKET_SLOTS;
        assert!(b >= first + 2 && b <= last, "entry {i} holds bucket {b}");
    }
}

#[test]
fn registry_root_history_is_bucketed_too() {
    let mut h = Harness::new();
    let tree = registry_tree_pda();
    set_clock(&mut h, bucket_start(7_000) + 1);
    initialize_registry(&mut h);

    let register = |h: &mut Harness, n: u32| {
        let wallet = Keypair::new();
        let mut commitment = [0u8; 32];
        commitment[28..].copy_from_slice(&(n + 1).to_be_bytes());
        let hex: String = commitment.iter().map(|b| format!("{b:02x}")).collect();
        let message = format!(
            "ghostlink:register:v1\ncommitment:{hex}\nwallet:{}\nprogram:{}\ncluster:devnet",
            wallet.pubkey(),
            REGISTRY_ID,
        )
        .into_bytes();
        let pre = ed25519_ix(&wallet.pubkey().to_bytes(), &sign64(&wallet, &message), &message);
        let binding = pda(&[b"binding", wallet.pubkey().as_ref()], &pk(REGISTRY_ID));
        let reg = Instruction {
            program_id: pk(REGISTRY_ID),
            accounts: vec![
                AccountMeta::new(h.payer.pubkey(), true),
                meta_r(wallet.pubkey()),
                meta_w(binding),
                meta_w(registry_tree_pda()),
                meta_r(pk(SYSVAR_IX_ID)),
                meta_r(pk(SYSTEM_ID)),
            ],
            data: ix_data("register", &commitment),
        };
        h.send(&[pre, reg], &[]).expect("register");
        binding
    };

    set_clock(&mut h, bucket_start(7_001) + 5);
    let binding = register(&mut h, 0);
    let binding_data = h.account_data(&binding).unwrap();
    assert_eq!(
        u64::from_le_bytes(binding_data[48..56].try_into().unwrap()),
        bucket_start(7_001) + 5,
        "the binding records the registration slot"
    );
    let before = Ring::read(&h, &tree);
    let proven_root = before.newest();

    set_clock(&mut h, bucket_start(7_002) + 2);
    for n in 1..=(ROOT_HISTORY as u32 + 4) {
        register(&mut h, n);
    }
    let after = Ring::read(&h, &tree);
    assert_eq!(after.next_index, ROOT_HISTORY as u64 + 5);
    assert!(after.contains(&proven_root), "registrations in one bucket cannot evict an earlier root");
    assert_eq!(after.cursor, (before.cursor + 1) % ROOT_HISTORY);
}

/// The registration, snapshot and open of the committed fixtures, with a
/// burst of 200 snapshots in between: the proof's census root comes from
/// the bucket before the burst and is still accepted.
#[test]
fn fixture_proof_survives_snapshot_spam() {
    let mut h = Harness::new();
    let v = vectors();
    let wallet = Keypair::new_from_array(hex32(v["identity"]["walletSeed"].as_str().unwrap()));
    let session = Keypair::new_from_array(hex32(v["identity"]["sessionSeed"].as_str().unwrap()));
    let registry_tree = registry_tree_pda();
    let census_tree = census_tree_pda();

    set_clock(&mut h, SNAPSHOT_SLOT - 100);
    initialize_registry(&mut h);
    initialize_census(&mut h);

    let commitment = fe(v["identity"]["commitment"].as_str().unwrap());
    let hex: String = commitment.iter().map(|b| format!("{b:02x}")).collect();
    let message = format!(
        "ghostlink:register:v1\ncommitment:{hex}\nwallet:{}\nprogram:{}\ncluster:devnet",
        v["identity"]["walletBase58"].as_str().unwrap(),
        REGISTRY_ID,
    )
    .into_bytes();
    let pre = ed25519_ix(&wallet.pubkey().to_bytes(), &sign64(&wallet, &message), &message);
    let register = Instruction {
        program_id: pk(REGISTRY_ID),
        accounts: vec![
            AccountMeta::new(h.payer.pubkey(), true),
            meta_r(wallet.pubkey()),
            meta_w(pda(&[b"binding", wallet.pubkey().as_ref()], &pk(REGISTRY_ID))),
            meta_w(registry_tree),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("register", &commitment),
    };
    h.send(&[pre, register], &[]).expect("register");

    let usdc = label("usdc mint");
    set_clock(&mut h, SNAPSHOT_SLOT);
    let holding = Pubkey::new_unique();
    h.svm.set_account(holding, token_account(&usdc, &wallet.pubkey(), 150_000_000)).unwrap();
    let ix = census_snapshot_ix(&h.payer.pubkey(), &wallet.pubkey(), &holding);
    h.send(&[ix], &[]).expect("fixture snapshot");
    let pubs = &v["circuits"]["login"]["public"];
    let census_root = fe(pubs["census_root"].as_str().unwrap());
    assert_eq!(Ring::read(&h, &census_tree).newest(), census_root, "fixture census root");

    // The burst lands in the next bucket.
    let next_bucket = bucket_start(SNAPSHOT_SLOT / ROOT_BUCKET_SLOTS + 1);
    set_clock(&mut h, next_bucket);
    for _ in 0..20 {
        let ixs: Vec<Instruction> = (0..10).map(|_| spam_ix(&h)).collect();
        h.send(&ixs, &[]).expect("spam batch");
    }
    assert_eq!(Ring::read(&h, &census_tree).next_index, 201);

    set_clock(&mut h, next_bucket + 50);
    let fx = load_json("circuits/keys/login_proof.json");
    let (proof_a, proof_b, proof_c) = convert_proof(&fx["proof"]);
    let mut session_key = [0u8; 33];
    session_key[..32].copy_from_slice(&session.pubkey().to_bytes());
    let app_id = fe(pubs["app_id"].as_str().unwrap());
    let args = OpenSessionArgs {
        proof_a,
        proof_b,
        proof_c,
        registry_root: fe(pubs["registry_root"].as_str().unwrap()),
        census_root,
        domain_hash: fe(pubs["domain_hash"].as_str().unwrap()),
        app_id,
        mint: usdc,
        threshold: 100_000_000,
        min_slot: 123_450_000,
        claim_holdings: true,
        session_kind: 0,
        session_key,
        session_expiry_slot: EXPIRY_SLOT,
        home: hex32(v["identity"]["homeAddress"].as_str().unwrap()),
        policy: Some(feeds_policy()),
    };
    let pocket = pda(&[b"pocket", &app_id], &pk(POCKET_ID));
    let open = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(h.payer.pubkey(), true),
            meta_w(pocket),
            meta_r(registry_tree),
            meta_r(census_tree),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("open_session_v2", &args),
    };
    h.send(&[compute_budget(400_000), open], &[]).expect("open_session against the pre-spam census root");
    assert!(h.account_data(&pocket).is_some(), "pocket opened");
}

#[test]
fn snapshot_fee_is_charged_and_only_the_upgrade_authority_moves_it() {
    let mut h = Harness::new();
    set_clock(&mut h, bucket_start(9_000));
    initialize_census(&mut h);
    let vault = census_fee_vault_pda();
    let floor = lamports(&h, &vault);
    assert_eq!(floor, h.svm.minimum_balance_for_rent_exemption(8 + 1), "vault starts rent-exempt and empty");
    assert_eq!(config_fee(&h), DEFAULT_SNAPSHOT_FEE);

    // A snapshot moves exactly the fee from the payer to the vault.
    let payer = h.payer.pubkey();
    let before = lamports(&h, &payer);
    snapshot_native(&mut h, &Pubkey::new_unique()).expect("snapshot");
    assert_eq!(lamports(&h, &vault), floor + DEFAULT_SNAPSHOT_FEE);
    assert_eq!(before - lamports(&h, &payer), DEFAULT_SNAPSHOT_FEE + 5_000, "fee plus one signature");

    // The payer's maximum binds.
    let target = Pubkey::new_unique();
    let low = census_snapshot_ix_with_max_fee(&payer, &target, &target, DEFAULT_SNAPSHOT_FEE - 1);
    assert_custom(&h.send_expect_err(&[low], &[]), 6006, "FeeAboveMaximum");

    // LiteSVM deploys without an upgrade authority: nobody may set the fee.
    let authority = funded_keypair(&mut h);
    let stranger = funded_keypair(&mut h);
    let err = h.send_expect_err(&[set_fee_ix(&authority.pubkey(), 250_000)], &[&authority]);
    assert_custom(&err, 6007, "NotAuthority");

    set_upgrade_authority(&mut h, Some(&authority.pubkey()));
    let err = h.send_expect_err(&[set_fee_ix(&stranger.pubkey(), 1)], &[&stranger]);
    assert_custom(&err, 6007, "NotAuthority");
    h.send(&[set_fee_ix(&authority.pubkey(), 250_000)], &[&authority]).expect("authority sets the fee");
    assert_eq!(config_fee(&h), 250_000);

    let target = Pubkey::new_unique();
    let stale = census_snapshot_ix_with_max_fee(&payer, &target, &target, DEFAULT_SNAPSHOT_FEE);
    assert_custom(&h.send_expect_err(&[stale], &[]), 6006, "FeeAboveMaximum");
    let ok = census_snapshot_ix_with_max_fee(&payer, &target, &target, 250_000);
    h.send(&[ok], &[]).expect("snapshot at the new fee");
    let collected = DEFAULT_SNAPSHOT_FEE + 250_000;
    assert_eq!(lamports(&h, &vault), floor + collected);

    // Withdrawal: only the authority, never below the rent floor.
    let err = h.send_expect_err(&[withdraw_fees_ix(&stranger.pubkey(), &stranger.pubkey(), 1)], &[&stranger]);
    assert_custom(&err, 6007, "NotAuthority");
    let err = h.send_expect_err(
        &[withdraw_fees_ix(&authority.pubkey(), &authority.pubkey(), collected + 1)],
        &[&authority],
    );
    assert_custom(&err, 6008, "InsufficientFees");
    let had = lamports(&h, &authority.pubkey());
    h.send(&[withdraw_fees_ix(&authority.pubkey(), &authority.pubkey(), collected)], &[&authority])
        .expect("authority withdraws the fees");
    assert_eq!(lamports(&h, &authority.pubkey()), had + collected);
    assert_eq!(lamports(&h, &vault), floor);

    // A zero fee charges nothing; removing the authority freezes the fee.
    h.send(&[set_fee_ix(&authority.pubkey(), 0)], &[&authority]).expect("fee off");
    snapshot_native(&mut h, &Pubkey::new_unique()).expect("free snapshot");
    assert_eq!(lamports(&h, &vault), floor);
    set_upgrade_authority(&mut h, None);
    let err = h.send_expect_err(&[set_fee_ix(&authority.pubkey(), 1)], &[&authority]);
    assert_custom(&err, 6007, "NotAuthority");
}

#[test]
fn snapshot_refuses_cpi_and_any_instruction_that_could_lend_a_balance() {
    let mut h = Harness::new();
    set_clock(&mut h, bucket_start(11_000));
    initialize_census(&mut h);
    let tree = census_tree_pda();
    let vault = census_fee_vault_pda();
    let floor = lamports(&h, &vault);
    let payer = h.payer.pubkey();
    let wallet = Pubkey::new_unique();

    // Through another program, which could lend before and take back after.
    let err = h.send_expect_err(&[via_cpi(census_snapshot_ix(&payer, &wallet, &wallet))], &[]);
    assert_custom(&err, 6004, "CpiForbidden");

    // Borrow, snapshot, repay in one transaction: the lend is refused...
    let lend = system_transfer(&payer, &wallet, 1_000_000_000);
    let snap = census_snapshot_ix(&payer, &wallet, &wallet);
    let err = h.send_expect_err(&[lend.clone(), snap.clone()], &[]);
    assert_custom(&err, 6005, "ForeignInstruction");
    // ...and so is anything after the snapshot.
    let err = h.send_expect_err(&[snap.clone(), lend], &[]);
    assert_custom(&err, 6005, "ForeignInstruction");
    // A census instruction other than snapshot does not qualify either.
    let authority = funded_keypair(&mut h);
    set_upgrade_authority(&mut h, Some(&authority.pubkey()));
    let err = h.send_expect_err(&[set_fee_ix(&authority.pubkey(), 0), snap.clone()], &[&authority]);
    assert_custom(&err, 6005, "ForeignInstruction");

    let ring = Ring::read(&h, &tree);
    assert_eq!(ring.next_index, 0, "nothing was recorded");
    assert_eq!(lamports(&h, &vault), floor, "nothing was charged");

    // Compute-budget instructions and several snapshots may share one.
    let other = Pubkey::new_unique();
    h.send(&[compute_budget(600_000), snap, census_snapshot_ix(&payer, &other, &other)], &[])
        .expect("compute budget plus snapshots");
    assert_eq!(Ring::read(&h, &tree).next_index, 2);
}

#[test]
fn full_tree_is_refused_without_charging_the_fee() {
    let mut h = Harness::new();
    set_clock(&mut h, bucket_start(13_000));
    initialize_census(&mut h);
    let tree = census_tree_pda();
    let vault = census_fee_vault_pda();
    let floor = lamports(&h, &vault);

    let mut account = h.svm.get_account(&tree).unwrap();
    account.data[8..16].copy_from_slice(&(1u64 << 26).to_le_bytes());
    h.svm.set_account(tree, account).unwrap();
    let before = h.account_data(&tree).unwrap();

    let err = snapshot_native(&mut h, &Pubkey::new_unique()).unwrap_err();
    assert_custom(&err, 6003, "TreeFull");
    assert_eq!(h.account_data(&tree).unwrap(), before, "tree unchanged");
    assert_eq!(lamports(&h, &vault), floor, "fee not charged");
}
