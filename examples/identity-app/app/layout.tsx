import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { loadConfig } from "../lib/config";
import { s } from "../lib/styles";

// Configuration comes from the environment at request time, so one build serves any deployment.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { appName } = loadConfig();
  // No icon file: the browser shows its default.
  return { title: appName, description: `${appName}: approve sign-ins and manage your identity.`, robots: { index: false } };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={s.body}>{children}</body>
    </html>
  );
}
