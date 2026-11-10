import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { body } from "../lib/styles";

export const metadata: Metadata = { title: "Starter site", description: "Sign in with a GhostLink identity app." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={body}>{children}</body>
    </html>
  );
}
