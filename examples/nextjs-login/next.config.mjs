import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository root: the workspace packages this example imports live there.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `same-origin-allow-popups` isolates this site from windows that open it
 * while keeping the link to the sign-in popup it opens itself; plain
 * `same-origin` would cut that link and every sign-in would end as "closed".
 * The site is never framed, so its button cannot be clicked through.
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
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
};

export default nextConfig;
