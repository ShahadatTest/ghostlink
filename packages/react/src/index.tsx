"use client";
/**
 * React bindings for GhostLink. An app wraps itself in
 * <GhostLinkProvider>, reads state through useGhostLink(), and drops
 * <ContinueWithGhostLink> next to its old connect button. A site that signs
 * users in through a separate identity app (the handoff,
 * docs/IDENTITY-HANDOFF.md) needs only the button, with `identityOrigin`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  GhostLink,
  requestLogin,
  type GhostLinkConfig,
  type GhostLinkSession,
  type HandoffLogin,
  type RequestLoginOptions,
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

interface ButtonProps {
  label?: string;
  /** Text shown while a login runs. Defaults to "Proving…", or "Waiting for approval…" with `identityOrigin`. */
  busyLabel?: string;
  className?: string;
  /** Inline styles for the button, for apps without a stylesheet. */
  style?: CSSProperties;
}

/** The app proves on this page itself (it holds the identity): needs a <GhostLinkProvider>. */
export interface ContinueWithGhostLinkFlowProps extends ButtonProps {
  /** Called when the user taps the button; the app runs its login flow
   * (gather witness data, prove, send the proof to its backend) and
   * resolves with the session, which the provider then exposes. */
  onLogin: GhostLinkLoginFlow;
  identityOrigin?: undefined;
  onSignIn?: undefined;
}

/**
 * The site asks a separate identity app, in a popup, for a login proof
 * (`requestLogin`). No provider is needed and no identity secret reaches
 * the page.
 */
export interface ContinueWithGhostLinkHandoffProps extends ButtonProps, Omit<RequestLoginOptions, "window" | "signal"> {
  /** The identity app's exact origin, e.g. "https://id.example.com". */
  identityOrigin: string;
  /**
   * Called with the approved login. Fetch a single-use nonce from your
   * backend and send it `await login.signChallenge(nonce)`; a rejection is
   * shown below the button.
   */
  onSignIn: (login: HandoffLogin) => void | Promise<void>;
  onLogin?: undefined;
}

export type ContinueWithGhostLinkProps = ContinueWithGhostLinkFlowProps | ContinueWithGhostLinkHandoffProps;

export function ContinueWithGhostLink(props: ContinueWithGhostLinkProps) {
  const { label = "Continue with GhostLink", className, style } = props;
  const handoff = typeof props.identityOrigin === "string";
  const busyLabel = props.busyLabel ?? (handoff ? "Waiting for approval…" : "Proving…");
  // Read unconditionally (hooks keep their order); only the in-page flow needs a provider.
  const context = useContext(Ctx);
  if (!handoff && !context) {
    throw new Error("useGhostLink and <ContinueWithGhostLink> must be rendered inside <GhostLinkProvider>");
  }
  const [busy, setBusy] = useState(false);

  const [failure, setFailure] = useState<string | null>(null);

  const click = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (props.identityOrigin !== undefined) {
        // Called before anything awaits, so the popup opens inside this click's user gesture.
        const { onSignIn, label: _l, busyLabel: _b, className: _c, style: _s, onLogin: _o, ...options } = props;
        await onSignIn(await requestLogin(options));
      } else {
        await context!.login(props.onLogin);
      }
    } catch (e) {
      // A refused wallet, a closed sign-in window or a failed proof is the
      // user's to see, not an unhandled rejection in the console.
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }, [busy, context, props]);

  return (
    <>
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus
          mid-login. click() already ignores presses while busy. */}
      <button
        type="button"
        className={className}
        style={style}
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
