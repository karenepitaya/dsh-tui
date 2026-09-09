import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Semantic tokens shared by ANSI components and plain-text presentation hosts. */
export type ControlRole = "text" | "muted" | "focus" | "selected" | "disabled"
  | "button" | "primary" | "error" | "accent" | "success";
export interface ControlSpan { readonly text: string; readonly role: ControlRole }
export interface ControlTheme { readonly paint: (role: ControlRole, text: string) => string }
export const NEUTRAL_CONTROL_THEME: ControlTheme = { paint: (_role, text) => text };

export function cleanControlText(value: string): string {
  return stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

export function controlWidth(width?: number): number {
  return width === undefined ? Infinity : Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

export function clipControlText(text: string, width: number): string {
  return width === Infinity ? text : stripTerminalSequences(truncateToWidth(text, Math.max(0, width), "…"));
}

/** Clips before painting so semantic fragments stay free of terminal sequences. */
export function clipControlSpans(spans: readonly ControlSpan[], width: number): ControlSpan[] {
  let remaining = width;
  return spans.flatMap((span) => {
    if (remaining <= 0) return [];
    const text = clipControlText(span.text, remaining);
    remaining -= visibleWidth(text);
    return text ? [{ ...span, text }] : [];
  });
}
