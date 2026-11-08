/**
 * React bindings for GhostLink. An app wraps itself in
 * <GhostLinkProvider>, reads state through useGhostLink(), and drops
 * <ContinueWithGhostLink> next to its old connect button.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GhostLink,
  type GhostLinkConfig,
  type GhostLinkSession,
} from "@ghostlink/sdk";

/** The app's login flow: gather witness data, prove, send the proof to its backend. */
export type GhostLinkLoginFlow = (client: GhostLink) => Promise<GhostLinkSession>;

export interface GhostLinkContextValue {
  /** Null until `ensureClient()` (or the first login) has created it. */
  client: GhostLink | null;
  session: GhostLinkSession | null;
  /** "proving" while a login runs; "error" when the client failed to initialize. */
  status: "idle" | "initializing" | "proving" | "ready" | "error";
  /** Why the last client initialization or login failed; cleared by the next attempt. */
  error: string | null;
  setSession: (s: GhostLinkSession | null) => void;
  /** Creates the client once (concurrent callers share it) and resolves with it. */
  ensureClient: () => Promise<GhostLink>;
  /**
   * Runs `flow` with the client, reporting "proving" until it settles, and
   * exposes its session on success. Rejects with the flow's error.
   */
  login: (flow: GhostLinkLoginFlow) => Promise<GhostLinkSession>;
}

// No default value: outside a provider every action would silently do nothing.
const Ctx = createContext<GhostLinkContextValue | null>(null);

export interface GhostLinkProviderProps {
  /**
   * Configuration for this provider's lifetime. To change cluster,
   * endpoints, origin or prover, remount the provider using a different
   * React key so the previous client and session are discarded together.
   */
  config: GhostLinkConfig;
  children: ReactNode;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GhostLinkProvider({ config, children }: GhostLinkProviderProps) {
  const [initialConfig] = useState(config);
  const [client, setClient] = useState<GhostLink | null>(null);
  const [session, setSession] = useState<GhostLinkSession | null>(null);
  const [status, setStatus] = useState<GhostLinkContextValue["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<GhostLink> | null>(null);
  const proving = useRef(0);

  const ensureClient = useCallback(() => {
    // One shared initialization however many callers race; a failure is
    // forgotten so that the next call retries.
    if (!pending.current) {
      setStatus("initializing");
      setError(null);
      pending.current = GhostLink.init(initialConfig).then(
        (c) => {
          setClient(c);
          setStatus("ready");
          return c;
        },
        (e: unknown) => {
          pending.current = null;
          setError(message(e));
          setStatus("error");
          throw e;
        },
      );
    }
    return pending.current;
  }, [initialConfig]);

  const login = useCallback(async (flow: GhostLinkLoginFlow) => {
    const c = await ensureClient();
    proving.current += 1;
    setStatus("proving");
    setError(null);
    try {
      const s = await flow(c);
      setSession(s);
      return s;
    } catch (e) {
      setError(message(e));
      throw e;
    } finally {
      // Overlapping logins: stay "proving" until the last one settles.
      if (--proving.current === 0) setStatus("ready");
    }
  }, [ensureClient]);

  const value = useMemo<GhostLinkContextValue>(
    () => ({ client, session, status, error, setSession, ensureClient, login }),
    [client, session, status, error, ensureClient, login],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The provider's state and actions. Throws when rendered outside <GhostLinkProvider>. */
export function useGhostLink(): GhostLinkContextValue {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error("useGhostLink and <ContinueWithGhostLink> must be rendered inside <GhostLinkProvider>");
  }
  return value;
}

export interface ContinueWithGhostLinkProps {
  /** Called when the user taps the button; the app runs its login flow
   * (gather witness data, prove, send the proof to its backend) and
   * resolves with the session, which the provider then exposes. */
  onLogin: GhostLinkLoginFlow;
  label?: string;
  /** Text shown while a login runs. Defaults to "Proving…". */
  busyLabel?: string;
  className?: string;
}

export function ContinueWithGhostLink({
  onLogin,
  label = "Continue with GhostLink",
  busyLabel = "Proving…",
  className,
}: ContinueWithGhostLinkProps) {
  const { login } = useGhostLink();
  const [busy, setBusy] = useState(false);

  const [failure, setFailure] = useState<string | null>(null);

  const click = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await login(onLogin);
    } catch (e) {
      // A refused wallet or a failed proof is the user's to see, not an
      // unhandled rejection in the console.
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }, [busy, login, onLogin]);

  return (
    <>
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus
          mid-login. click() already ignores presses while busy. */}
      <button
        type="button"
        className={className}
        onClick={click}
        aria-busy={busy}
        aria-disabled={busy}
      >
        {busy ? busyLabel : label}
      </button>
      {failure && (
        <span role="alert" style={{ display: "block", marginTop: 8, fontSize: 13 }}>
          {failure}
        </span>
      )}
    </>
  );
}
