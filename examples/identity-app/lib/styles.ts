/**
 * The whole visual design: a few typed style objects. System fonts and
 * system colours, which follow the user's light or dark setting; no
 * stylesheet, no images, no web fonts. Focus rings are the browser's own.
 */
import type { CSSProperties } from "react";

const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const s = {
  body: { margin: 0, fontFamily: font, fontSize: 16, lineHeight: 1.5, background: "Canvas", color: "CanvasText", colorScheme: "light dark" },
  main: { maxWidth: 640, margin: "0 auto", padding: "24px 16px 48px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 12, marginBottom: 16 },
  appName: { fontSize: 20, fontWeight: 600, margin: 0 },
  h1: { fontSize: 24, lineHeight: 1.25, margin: "0 0 8px" },
  h2: { fontSize: 18, margin: "0 0 8px" },
  muted: { opacity: 0.8, margin: "4px 0" },
  section: { border: "1px solid GrayText", borderRadius: 8, padding: 16, margin: "16px 0" },
  origin: { fontFamily: mono, fontSize: 18, fontWeight: 600, wordBreak: "break-all", padding: "8px 10px", borderRadius: 6, border: "2px solid CanvasText", display: "block", margin: "8px 0" },
  code: { fontFamily: mono, fontSize: 14, wordBreak: "break-all" },
  list: { margin: "8px 0", paddingLeft: 20 },
  row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 12 },
  button: { fontFamily: "inherit", fontSize: "inherit", fontWeight: 600, padding: "10px 16px", borderRadius: 6, border: "1px solid CanvasText", background: "CanvasText", color: "Canvas", cursor: "pointer", minHeight: 44 },
  secondary: { fontFamily: "inherit", fontSize: "inherit", padding: "10px 16px", borderRadius: 6, border: "1px solid CanvasText", background: "Canvas", color: "CanvasText", cursor: "pointer", minHeight: 44 },
  input: { fontFamily: "inherit", fontSize: "inherit", padding: "8px 10px", borderRadius: 6, border: "1px solid GrayText", background: "Field", color: "FieldText", width: "100%", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, margin: "12px 0 4px" },
  error: { border: "2px solid #b3261e", borderRadius: 6, padding: 12, margin: "12px 0" },
  note: { borderLeft: "4px solid GrayText", padding: "4px 12px", margin: "12px 0" },
  status: { margin: "8px 0", fontWeight: 600 },
  dl: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: "8px 0" },
} satisfies Record<string, CSSProperties>;

/** Looks disabled but stays focusable: pair it with aria-disabled, never `disabled`. */
export const dimmed = (style: CSSProperties, off: boolean): CSSProperties => (off ? { ...style, opacity: 0.5, cursor: "not-allowed" } : style);
