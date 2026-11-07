/**
 * The indexer's state: both Merkle trees rebuilt leaf by leaf from
 * events, plus lookup tables for bindings and latest census snapshots.
 *
 * Both programs keep one root per 150-slot bucket (ROOT_BUCKET_SLOTS):
 * appends inside a bucket overwrite its root, so only a bucket that has
 * ended has a root that stays on chain. The store therefore serves
 * roots, paths, leaves, bindings and snapshots only for leaves of
 * completed buckets: buckets that end before the slot through which the
 * poller has applied all history (`advance`), or before the bucket of a
 * later leaf of the same tree. Newer entries wait in the pending lists.
 *
 * This derived state lives in memory. The hosted entry point persists it
 * through `saveCheckpoint` into the encrypted SQLite checkpoint
 * (database.ts), committed together with the scan spool. The optional
 * JSON snapshot path (`persistPath`/`load`) is a local development and
 * test facility only; the hosted entry point refuses it (PERSIST_PATH).
 * Everything here is rebuildable from finalized chain history, and
 * clients verify served roots against the chain: this service carries
 * no trust.
 *
 * Every tree append is checked BEFORE it happens: an event whose index
 * or root does not chain leaves the store untouched, and a redelivery of
 * a leaf already present is a no-op — so neither a webhook retry nor an
 * overlapping poll can leave a phantom leaf behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FieldElement, IncrementalTree, ROOT_BUCKET_SLOTS, ROOT_HISTORY_SIZE, bytes32ToField, rootBucket } from "@ghostlink/common";
import type { GhostLinkEvent } from "@ghostlink/service-kit";

export interface CensusEntry {
  leafIndex: number;
  wallet: string;
  mint: string;
  amount: string;
  slot: string;
}

export interface BindingEntry {
  leafIndex: number;
  commitmentHex: string;
  /** Registration slot (decimal). */
  slot: string;
}

export type TreeKind = "registry" | "census";

/** A registration the chain has, whose root bucket has not ended yet. */
export interface PendingBinding {
  wallet: string;
  entry: BindingEntry;
}

/** The newest root of one root-history bucket and the leaf count it covers. */
interface BucketEnd {
  bucket: number;
  size: number;
  root: FieldElement;
}

export interface PocketEntry {
  pocket: string;
  appIdHex: string;
  createdAt: string; // ISO time of first SessionOpened seen
  sessionExpirySlot: string;
  revoked: boolean;
  sweptHomeTo?: string;
  pendingChangeAfterSlot?: string;
}

export interface ActivityEntry {
  pocket: string;
  kind: string;
  at: string; // ISO ingest time (block time is the explorer's job)
  detail: Record<string, string>;
}

export interface Snapshot {
  registryLeaves: string[];
  censusLeaves: string[];
  /** Slot of every leaf, parallel to the leaf lists; it decides the leaf's root bucket. */
  registrySlots: number[];
  censusSlots: number[];
  /** Leaves appended before these slots belong to completed buckets and are served. */
  completeBefore: Record<TreeKind, number>;
  /** Served: registrations and latest snapshots of completed buckets. */
  bindings: Record<string, BindingEntry>;
  census: Record<string, CensusEntry>;
  /** Not served yet, in append order: their buckets have not ended. */
  pendingBindings: PendingBinding[];
  pendingCensus: CensusEntry[];
  pockets?: Record<string, PocketEntry>;
  activity?: ActivityEntry[];
  /** program id -> newest fully processed signature (poller cursors). */
  cursors?: Record<string, string>;
  processedTransactions?: string[];
}

export class IndexerStore {
  registry = new IncrementalTree();
  census = new IncrementalTree();
  /** Decimal leaf values in append order — the persistence source of truth. */
  registryLeaves: string[] = [];
  censusLeaves: string[] = [];
  /** Append slot of each leaf. */
  registrySlots: number[] = [];
  censusSlots: number[] = [];
  /** wallet base58 -> binding, once its bucket has ended */
  bindings = new Map<string, BindingEntry>();
  /** `${wallet}:${mint}` -> latest snapshot of a completed bucket */
  latestCensus = new Map<string, CensusEntry>();
  /** Appended but not yet servable, oldest first. */
  pendingBindings: PendingBinding[] = [];
  pendingCensus: CensusEntry[] = [];
  /** pocket address base58 -> live state from pocket-program events */
  pockets = new Map<string, PocketEntry>();
  /** newest last; capped so the store stays rebuildable-light */
  activity: ActivityEntry[] = [];
  /** Poller cursors, persisted with the snapshot. */
  cursors = new Map<string, string>();
  private processedTransactions = new Set<string>();
  private completeBefore: Record<TreeKind, number> = { registry: 0, census: 0 };
  /** Leaves served per tree: those appended before `completeBefore`. */
  private completed: Record<TreeKind, number> = { registry: 0, census: 0 };
  /** Recent bucket roots per tree, oldest first, as the program's ring keeps them. */
  private buckets: Record<TreeKind, BucketEnd[]> = { registry: [], census: [] };

  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath?: string, private readonly saveCheckpoint?: (snapshot: Snapshot) => void) {}

  snapshot(): Snapshot {
    return { registryLeaves: this.registryLeaves, censusLeaves: this.censusLeaves,
      registrySlots: this.registrySlots, censusSlots: this.censusSlots, completeBefore: { ...this.completeBefore },
      bindings: Object.fromEntries(this.bindings), census: Object.fromEntries(this.latestCensus),
      pendingBindings: this.pendingBindings, pendingCensus: this.pendingCensus,
      pockets: Object.fromEntries(this.pockets), activity: this.activity,
      cursors: Object.fromEntries(this.cursors), processedTransactions: [...this.processedTransactions] };
  }

  restore(snap: Snapshot): void {
    // State from before root-history buckets has no leaf slots: rebuild it from chain history.
    if (!Array.isArray(snap.registrySlots) || !Array.isArray(snap.censusSlots) || !snap.completeBefore ||
      !Array.isArray(snap.pendingBindings) || !Array.isArray(snap.pendingCensus) ||
      snap.registrySlots.length !== snap.registryLeaves.length || snap.censusSlots.length !== snap.censusLeaves.length) {
      throw new Error("indexer snapshot lacks root-bucket slots; rebuild it from chain history");
    }
    this.registry = new IncrementalTree(); this.census = new IncrementalTree();
    this.registryLeaves = []; this.censusLeaves = []; this.registrySlots = []; this.censusSlots = [];
    this.buckets = { registry: [], census: [] }; this.completed = { registry: 0, census: 0 };
    this.completeBefore = { registry: 0, census: 0 };
    for (const kind of ["registry", "census"] as const) {
      const tree = kind === "registry" ? this.registry : this.census;
      const leaves = kind === "registry" ? snap.registryLeaves : snap.censusLeaves;
      const slots = kind === "registry" ? snap.registrySlots : snap.censusSlots;
      leaves.forEach((leaf, i) => { this.checkSlot(kind, slots[i]!); tree.append(BigInt(leaf)); this.recordLeaf(kind, leaf, slots[i]!); });
      this.completeBefore[kind] = Math.max(this.completeBefore[kind], slotValue(snap.completeBefore[kind]));
    }
    this.bindings = new Map(Object.entries(snap.bindings)); this.latestCensus = new Map(Object.entries(snap.census));
    this.pendingBindings = [...snap.pendingBindings]; this.pendingCensus = [...snap.pendingCensus];
    this.settle("registry"); this.settle("census");
    this.pockets = new Map(Object.entries(snap.pockets ?? {})); this.activity = snap.activity ?? [];
    this.cursors = new Map(Object.entries(snap.cursors ?? {})); this.processedTransactions = new Set(snap.processedTransactions ?? []);
  }

  /** One transaction's events and cursor updates commit together; failure restores the last complete state. */
  checkpointTransaction(signature: string, events: GhostLinkEvent[], programs: string[], commit: (snapshot: Snapshot) => void): number {
    const before = JSON.stringify(this.snapshot());
    try {
      const applied = this.applyTransaction(signature, events);
      for (const program of programs) this.setCursor(program, signature);
      commit(this.snapshot());
      return applied;
    } catch (error) { this.restore(JSON.parse(before) as Snapshot); throw error; }
    finally { if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = null; }
  }

  /** Deduplicate whole transactions across polling, webhook retries and restarts. */
  applyTransaction(signature: string, events: GhostLinkEvent[]): number {
    if (this.processedTransactions.has(signature)) return 0;
    let applied = 0;
    for (const event of events) if (this.apply(event)) applied += 1;
    if (events.length) {
      this.processedTransactions.add(signature);
      this.persist();
    }
    return applied;
  }

  /** Applies one event. Returns false when it was a harmless redelivery. */
  apply(event: GhostLinkEvent): boolean {
    switch (event.kind) {
      case "Registered": {
        const { index, duplicate } = this.appendChecked("registry", event.leaf, Number(event.leafIndex), event.root, event.slot);
        if (duplicate) return false;
        this.pendingBindings.push({ wallet: event.wallet, entry: {
          leafIndex: index,
          commitmentHex: Buffer.from(event.commitment).toString("hex"),
          slot: event.slot.toString(),
        } });
        this.settle("registry");
        break;
      }
      case "SnapshotTaken": {
        const { index, duplicate } = this.appendChecked("census", event.leaf, Number(event.leafIndex), event.root, event.slot);
        if (duplicate) return false;
        this.pendingCensus.push({
          leafIndex: index,
          wallet: event.wallet,
          mint: event.mint,
          amount: event.amount.toString(),
          slot: event.slot.toString(),
        });
        this.settle("census");
        break;
      }
      case "SessionOpened": {
        const appIdHex = Buffer.from(event.appId).toString("hex");
        const existing = this.pockets.get(event.pocket);
        this.pockets.set(event.pocket, {
          pocket: event.pocket,
          appIdHex,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          sessionExpirySlot: event.sessionExpirySlot.toString(),
          revoked: false,
          sweptHomeTo: existing?.sweptHomeTo,
          pendingChangeAfterSlot: existing?.pendingChangeAfterSlot,
        });
        this.note(event.pocket, "SessionOpened", {
          created: String(event.created),
          expirySlot: event.sessionExpirySlot.toString(),
        });
        break;
      }
      case "Filled": {
        this.note(event.pocket, "Filled", {
          inMint: event.inMint,
          inMax: event.inMax.toString(),
          outMint: event.outMint,
          outReceived: event.outReceived.toString(),
          usdE6: event.inValueUsdE6.toString(),
          mode: event.mode.toString(),
          releasedCostUsdE6: event.releasedCostUsdE6.toString(),
        });
        break;
      }
      case "SweptHome": {
        const p = this.pockets.get(event.pocket);
        if (p) p.sweptHomeTo = event.home;
        this.note(event.pocket, "SweptHome", { home: event.home });
        break;
      }
      case "SessionRevoked": {
        const p = this.pockets.get(event.pocket);
        if (p) p.revoked = true;
        this.note(event.pocket, "SessionRevoked", {});
        break;
      }
      case "ChangeProposed": {
        const p = this.pockets.get(event.pocket);
        if (p) p.pendingChangeAfterSlot = event.executableAfterSlot.toString();
        this.note(event.pocket, "ChangeProposed", {
          executableAfterSlot: event.executableAfterSlot.toString(),
        });
        break;
      }
      case "ChangeExecuted":
      case "ChangeCanceled": {
        const p = this.pockets.get(event.pocket);
        if (p) p.pendingChangeAfterSlot = undefined;
        this.note(event.pocket, event.kind, {});
        break;
      }
      case "PositionWrittenOff": {
        this.note(event.pocket, "PositionWrittenOff", {
          tokenAccount: event.tokenAccount,
          mint: event.mint,
          quantity: event.quantity.toString(),
          costUsdE6: event.costUsdE6.toString(),
        });
        break;
      }
      default:
        return false;
    }
    this.persist();
    return true;
  }

  setCursor(program: string, signature: string): void {
    this.cursors.set(program, signature);
    this.persist();
  }

  /**
   * Every transaction through `throughSlot` has been applied, so every
   * bucket that ends by then is complete: its root is final on chain.
   * Monotonic and idempotent; returns true when more became servable.
   */
  advance(throughSlot: number): boolean {
    const boundary = rootBucket(slotValue(throughSlot) + 1) * ROOT_BUCKET_SLOTS;
    const before = this.completed.registry + this.completed.census;
    for (const kind of ["registry", "census"] as const) {
      if (boundary > this.completeBefore[kind]) { this.completeBefore[kind] = boundary; this.settle(kind); }
    }
    return this.completed.registry + this.completed.census !== before;
  }

  /** Leaves of completed buckets: the prefix every served root and path covers. */
  completedSize(kind: TreeKind): number {
    return this.completed[kind];
  }

  /** Leaves appended before this slot are served. */
  completeBeforeSlot(kind: TreeKind): number {
    return this.completeBefore[kind];
  }

  /** The root over the served prefix: the newest completed bucket's root (the empty root if none). */
  completedRoot(kind: TreeKind): FieldElement {
    const size = this.completed[kind];
    const ends = this.buckets[kind];
    for (let i = ends.length - 1; i >= 0; i--) {
      if (ends[i]!.size === size) return ends[i]!.root;
      if (ends[i]!.size < size) break;
    }
    return (kind === "registry" ? this.registry : this.census).rootAt(size);
  }

  /** The served root and the slot of its last leaf, or null while nothing is served. */
  servedRoot(kind: TreeKind): { root: string; slot: number } | null {
    const size = this.completed[kind];
    if (size === 0) return null;
    const slots = kind === "registry" ? this.registrySlots : this.censusSlots;
    return { root: this.completedRoot(kind).toString(), slot: slots[size - 1]! };
  }

  /** A path for a served leaf against `completedRoot`. */
  completedPath(kind: TreeKind, index: number): { index: number; siblings: FieldElement[]; root: FieldElement } {
    const path = (kind === "registry" ? this.registry : this.census).pathAt(index, this.completed[kind]);
    return { index: path.index, siblings: path.siblings, root: this.completedRoot(kind) };
  }

  /** For a leaf the store holds but does not serve yet: the last slot of its bucket. */
  completesAfterSlot(kind: TreeKind, leafIndex: number): number | undefined {
    const slots = kind === "registry" ? this.registrySlots : this.censusSlots;
    if (leafIndex < this.completed[kind] || leafIndex >= slots.length) return undefined;
    return (rootBucket(slots[leafIndex]!) + 1) * ROOT_BUCKET_SLOTS - 1;
  }

  pendingBinding(wallet: string): BindingEntry | undefined {
    return this.pendingBindings.find(p => p.wallet === wallet)?.entry;
  }

  /** The newest snapshot of `wallet:mint` that is not served yet. */
  pendingSnapshot(key: string): CensusEntry | undefined {
    for (let i = this.pendingCensus.length - 1; i >= 0; i--) {
      const entry = this.pendingCensus[i]!;
      if (`${entry.wallet}:${entry.mint}` === key) return entry;
    }
    return undefined;
  }

  /** Extends a tree's served prefix to its boundary and moves newly completed entries to the served maps. */
  private settle(kind: TreeKind): void {
    const slots = kind === "registry" ? this.registrySlots : this.censusSlots;
    let size = this.completed[kind];
    while (size < slots.length && slots[size]! < this.completeBefore[kind]) size++;
    this.completed[kind] = size;
    if (kind === "registry") {
      while (this.pendingBindings.length && this.pendingBindings[0]!.entry.leafIndex < size) {
        const { wallet, entry } = this.pendingBindings.shift()!;
        this.bindings.set(wallet, entry);
      }
    } else {
      while (this.pendingCensus.length && this.pendingCensus[0]!.leafIndex < size) {
        const entry = this.pendingCensus.shift()!;
        this.latestCensus.set(`${entry.wallet}:${entry.mint}`, entry);
      }
    }
  }

  private checkSlot(kind: TreeKind, slot: number): void {
    const slots = kind === "registry" ? this.registrySlots : this.censusSlots;
    slotValue(slot);
    if (slots.length && slot < slots[slots.length - 1]!) {
      throw new Error(`${kind} leaf slot regressed — refusing to diverge from the chain`);
    }
  }

  /** Records an appended leaf: its slot, and its tree's root as its bucket's latest. */
  private recordLeaf(kind: TreeKind, leaf: string, slot: number): void {
    const tree = kind === "registry" ? this.registry : this.census;
    (kind === "registry" ? this.registryLeaves : this.censusLeaves).push(leaf);
    (kind === "registry" ? this.registrySlots : this.censusSlots).push(slot);
    const ends = this.buckets[kind], bucket = rootBucket(slot), last = ends[ends.length - 1];
    if (last && last.bucket === bucket) { last.size = tree.nextIndex; last.root = tree.root; }
    else {
      ends.push({ bucket, size: tree.nextIndex, root: tree.root });
      if (ends.length > ROOT_HISTORY_SIZE * 2) ends.splice(0, ends.length - ROOT_HISTORY_SIZE);
    }
    // A leaf at this slot proves every earlier bucket of this tree has ended.
    this.completeBefore[kind] = Math.max(this.completeBefore[kind], bucket * ROOT_BUCKET_SLOTS);
  }

  private note(pocket: string, kind: string, detail: Record<string, string>): void {
    this.activity.push({ pocket, kind, at: new Date().toISOString(), detail });
    if (this.activity.length > 5000) this.activity.splice(0, this.activity.length - 5000);
  }

  pocketByAppId(appIdHex: string): PocketEntry | undefined {
    for (const p of this.pockets.values()) {
      if (p.appIdHex === appIdHex.toLowerCase()) return p;
    }
    return undefined;
  }

  activityFor(pocket: string, limit = 50): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    for (let i = this.activity.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.activity[i]!.pocket === pocket) out.push(this.activity[i]!);
    }
    return out;
  }

  /**
   * Checks index and root against the event BEFORE touching the tree.
   * Redelivery of an identical leaf is reported as a duplicate; a
   * different leaf at an existing index, a gap, or a root that does not
   * chain is refused with the tree unchanged.
   */
  private appendChecked(
    kind: TreeKind,
    leafBytes: Uint8Array,
    eventIndex: number,
    rootBytes: Uint8Array,
    eventSlot: bigint,
  ): { index: number; duplicate: boolean } {
    const tree = kind === "registry" ? this.registry : this.census;
    const leaf = bytes32ToField(leafBytes);
    const root = bytes32ToField(rootBytes);
    const next = tree.nextIndex;
    if (eventIndex < next) {
      if (tree.leafAt(eventIndex) === leaf) return { index: eventIndex, duplicate: true };
      throw new Error(
        `${kind} leaf ${eventIndex} is already present with different contents — refusing to diverge from the chain`,
      );
    }
    if (eventIndex > next) {
      throw new Error(`${kind} leaf gap: event says ${eventIndex}, tree is at ${next} — an earlier event is missing`);
    }
    if (tree.rootAfterAppend(leaf) !== root) {
      throw new Error(`${kind} root mismatch: the event's root does not chain from this tree — refused`);
    }
    if (eventSlot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${kind} leaf slot out of range`);
    const slot = Number(eventSlot);
    this.checkSlot(kind, slot);
    tree.append(leaf);
    this.recordLeaf(kind, leaf.toString(), slot);
    return { index: next, duplicate: false };
  }

  /**
   * Roots a prover may use: one per completed bucket, most recent last,
   * within the ROOT_HISTORY_SIZE entries the program's ring keeps.
   */
  recentRoots(kind: TreeKind, limit = ROOT_HISTORY_SIZE): string[] {
    return this.buckets[kind].slice(-ROOT_HISTORY_SIZE)
      .filter(end => end.size <= this.completed[kind])
      .slice(-limit)
      .map(end => end.root.toString());
  }

  /** Debounced, atomic snapshot write (temp file + rename). */
  private persist(): void {
    if (this.saveCheckpoint || !this.persistPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 250);
    this.persistTimer.unref?.();
  }

  flush(): void {
    if (this.saveCheckpoint) { this.saveCheckpoint(this.snapshot()); return; }
    if (!this.persistPath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const snapshot = this.snapshot();
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, this.persistPath);
  }

  /**
   * Loads a snapshot. A missing file starts empty; a corrupt one throws,
   * because silently starting over would make the store disagree with
   * every client that already trusted its roots.
   */
  static load(persistPath?: string): IndexerStore {
    const store = new IndexerStore(persistPath);
    if (!persistPath || !existsSync(persistPath)) return store;
    const snap = JSON.parse(readFileSync(persistPath, "utf8")) as Snapshot;
    store.restore(snap);
    return store;
  }
}

function slotValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid indexer slot");
  return value;
}
