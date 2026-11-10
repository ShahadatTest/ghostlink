/** The starter's whole look: system fonts and colours, inline. Replace with your own design. */
import type { CSSProperties } from "react";

export const body: CSSProperties = {
  margin: 0, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', lineHeight: 1.5,
  background: "Canvas", color: "CanvasText", colorScheme: "light dark",
};
export const main: CSSProperties = { maxWidth: 560, margin: "0 auto", padding: "48px 16px" };
export const button: CSSProperties = {
  fontFamily: "inherit", fontSize: "inherit", fontWeight: 600, padding: "10px 18px", borderRadius: 6, border: "1px solid CanvasText",
  background: "CanvasText", color: "Canvas", cursor: "pointer", minHeight: 44,
};
export const secondary: CSSProperties = { ...button, background: "Canvas", color: "CanvasText", fontWeight: 400 };
export const code: CSSProperties = { fontFamily: "ui-monospace, Menlo, Consolas, monospace", wordBreak: "break-all" };
export const muted: CSSProperties = { opacity: 0.8 };
