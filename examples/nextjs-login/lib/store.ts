/**
 * Single-use sign-in challenges and signed-in sessions, in this process's
 * memory. Enough for one `next start` or `next dev` process; a site with
 * several server instances needs a shared store with an atomic
 * "get and delete" (Redis GETDEL, a database row deleted in a transaction).
 */
import { randomBytes } from "node:crypto";

export const CHALLENGE_TTL_MS = 120_000;
const MAX_ENTRIES = 10_000;

export interface Session {
  appId: string;
  /** The holdings claim the sign-in proved, when the site gates on one. */
  gate?: { mint: string; threshold: string };
  expiresAt: number;
}

export class MemoryStore {
  readonly #challenges = new Map<string, { nonce: Uint8Array; expiresAt: number }>();
  readonly #sessions = new Map<string, Session>();

  /** A fresh 32-byte nonce under a random ID. */
  issue(now = Date.now()): { challengeId: string; nonce: Uint8Array } {
    prune(this.#challenges, now);
    if (this.#challenges.size >= MAX_ENTRIES) throw new Error("too many pending sign-ins");
    const challengeId = randomBytes(32).toString("hex");
    const nonce = new Uint8Array(randomBytes(32));
    this.#challenges.set(challengeId, { nonce, expiresAt: now + CHALLENGE_TTL_MS });
    return { challengeId, nonce };
  }

  /** Get and delete in one step: a challenge can be used once, whatever happens next. */
  take(challengeId: string, now = Date.now()): Uint8Array | undefined {
    const entry = this.#challenges.get(challengeId);
    this.#challenges.delete(challengeId);
    return entry && entry.expiresAt > now ? entry.nonce : undefined;
  }

  createSession(session: Session, now = Date.now()): string {
    prune(this.#sessions, now);
    if (this.#sessions.size >= MAX_ENTRIES) throw new Error("too many sessions");
    const id = randomBytes(32).toString("hex");
    this.#sessions.set(id, session);
    return id;
  }

  session(id: string | undefined, now = Date.now()): Session | undefined {
    if (!id) return undefined;
    const session = this.#sessions.get(id);
    if (session && session.expiresAt <= now) this.#sessions.delete(id);
    return session && session.expiresAt > now ? session : undefined;
  }

  endSession(id: string | undefined): void {
    if (id) this.#sessions.delete(id);
  }
}

function prune(map: Map<string, { expiresAt: number }>, now: number) {
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}

/** One store per server process, kept across development hot reloads. */
export function store(): MemoryStore {
  const g = globalThis as { __ghostlinkStarterStore?: MemoryStore };
  return (g.__ghostlinkStarterStore ??= new MemoryStore());
}

export const SESSION_COOKIE = "starter_session";

export function sessionCookieId(cookieHeader: string | null): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}
