/**
 * No DOM renderer is installed for this package, so these tests render one
 * component at a time by calling it under a minimal hook runtime: state
 * lives in call-order slots, setters store values, and re-rendering is
 * calling the component again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { GhostLink, type GhostLinkSession } from "@ghostlink/sdk";
import { ContinueWithGhostLink, GhostLinkProvider, useGhostLink, type GhostLinkContextValue } from "../src/index.js";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, context: null as unknown }));
vi.mock("react", async (importOriginal) => {
  const slot = (init: () => unknown) => {
    const i = hooks.index++;
    if (!(i in hooks.slots)) hooks.slots[i] = init();
    return i;
  };
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (initial: unknown) => {
      const i = slot(() => (typeof initial === "function" ? initial() : initial));
      return [hooks.slots[i], (next: unknown) => {
        hooks.slots[i] = typeof next === "function" ? next(hooks.slots[i]) : next;
      }];
    },
    useRef: (initial: unknown) => hooks.slots[slot(() => ({ current: initial }))],
    useCallback: (fn: unknown) => (hooks.index++, fn),
    useMemo: (fn: () => unknown) => (hooks.index++, fn()),
    useContext: () => hooks.context,
  };
});

function render<P>(component: (props: P) => unknown, props: P): ReactElement<Record<string, any>> {
  hooks.index = 0;
  return component(props) as ReactElement<Record<string, any>>;
}

const config = { cluster: "localnet" as const, indexer: "https://indexer.test", origin: "https://app.test" };
const provide = () => render(GhostLinkProvider, { config, children: null }).props.value as GhostLinkContextValue;
const session = { appIdBase58: "fixture-user" } as unknown as GhostLinkSession;

beforeEach(() => {
  hooks.slots = [];
  hooks.context = null;
  vi.restoreAllMocks();
});

describe("GhostLinkProvider", () => {
  it("exposes ensureClient, so apps can use the client before any login, and creates it once", async () => {
    const init = vi.spyOn(GhostLink, "init");
    const first = provide();
    expect(first).toMatchObject({ client: null, session: null, status: "idle", error: null });
    const [a, b] = await Promise.all([first.ensureClient(), first.ensureClient()]);
    expect(a).toBe(b);
    expect(init).toHaveBeenCalledTimes(1);
    expect(provide()).toMatchObject({ client: a, status: "ready" });
    expect(await provide().ensureClient()).toBe(a);
  });

  it("reports proving while a login runs, then ready, and keeps the failure visible", async () => {
    let during: string | undefined;
    const result = await provide().login(async (client) => {
      expect(client).toBeInstanceOf(GhostLink);
      during = provide().status;
      return session;
    });
    expect(result).toBe(session);
    expect(during).toBe("proving");
    expect(provide()).toMatchObject({ status: "ready", session, error: null });

    await expect(provide().login(async () => { throw new Error("wallet refused"); })).rejects.toThrow("wallet refused");
    // A failed attempt does not sign the user out of an earlier session.
    expect(provide()).toMatchObject({ status: "ready", session, error: "wallet refused" });
  });

  it("stays proving until overlapping logins have all settled", async () => {
    let finish = () => {};
    const slow = provide().login(() => new Promise((resolve) => { finish = () => resolve(session); }));
    await provide().login(async () => session);
    expect(provide().status).toBe("proving");
    finish();
    await slow;
    expect(provide().status).toBe("ready");
  });

  it("reports a failed initialization and retries it on the next call", async () => {
    vi.spyOn(GhostLink, "init").mockRejectedValueOnce(new Error("indexer unreachable"));
    await expect(provide().ensureClient()).rejects.toThrow("indexer unreachable");
    expect(provide()).toMatchObject({ client: null, status: "error", error: "indexer unreachable" });
    const client = await provide().ensureClient();
    expect(provide()).toMatchObject({ client, status: "ready", error: null });
  });
});

describe("outside a provider", () => {
  it("throws a helpful error instead of silently doing nothing", () => {
    expect(() => useGhostLink()).toThrow("must be rendered inside <GhostLinkProvider>");
    expect(() => render(ContinueWithGhostLink, { onLogin: vi.fn() })).toThrow("must be rendered inside <GhostLinkProvider>");
  });
});

describe("ContinueWithGhostLink", () => {
  it("runs the app's flow through the provider and shows its failure to the user", async () => {
    const login = vi.fn(async () => { throw new Error("proof failed"); });
    hooks.context = { login };
    const onLogin = vi.fn();
    const children = () => render(ContinueWithGhostLink, { onLogin }).props.children as ReactElement<Record<string, any>>[];
    const [button] = children();
    expect(button!.props).toMatchObject({ type: "button", "aria-busy": false, "aria-disabled": false, children: "Continue with GhostLink" });
    await button!.props.onClick();
    expect(login).toHaveBeenCalledWith(onLogin);
    expect(children()[1]!.props).toMatchObject({ role: "alert", children: "proof failed" });
  });

  it("announces the busy state with aria-busy and a custom busy label, and ignores a second click", async () => {
    let finish!: (s: GhostLinkSession) => void;
    const login = vi.fn(() => new Promise<GhostLinkSession>((resolve) => { finish = resolve; }));
    hooks.context = { login };
    const onLogin = vi.fn();
    const button = (props: { busyLabel?: string } = {}) =>
      (render(ContinueWithGhostLink, { onLogin, ...props }).props.children as ReactElement<Record<string, any>>[])[0]!;

    const first = button().props.onClick();
    expect(button({ busyLabel: "Verificando…" }).props).toMatchObject({
      "aria-busy": true,
      "aria-disabled": true,
      children: "Verificando…",
    });
    expect(button().props.children).toBe("Proving…");

    await button().props.onClick();
    expect(login).toHaveBeenCalledTimes(1);

    finish(session);
    await first;
    expect(button().props).toMatchObject({ "aria-busy": false, "aria-disabled": false, children: "Continue with GhostLink" });
  });
});

describe("Next.js App Router", () => {
  it('starts the entry with the "use client" directive, ahead of every import', async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
    // A directive only counts as the first statement; comments may precede it.
    const body = source.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    expect(body.startsWith('"use client";')).toBe(true);
  });
});
