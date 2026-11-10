import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository root: the workspace packages this example imports live there.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The identity app must never be framed: a framed consent screen could be
 * covered by another page and clicked through (clickjacking). It must also
 * keep `window.opener` (no Cross-Origin-Opener-Policy of same-origin):
 * without its opener it cannot learn which site is asking, and the site
 * would see the window as closed at once.
 * @type {import("next").NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root },
  outputFileTracingRoot: root,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Cross-Origin-Opener-Policy", value: "unsafe-none" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ],
    }];
  },
};

export default nextConfig;
