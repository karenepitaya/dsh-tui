import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  colorizeOrbGlyph,
  colorizeThemeText,
  orbColorAtEnergy,
  ORB_THEMES,
  ORB_THEME_NAMES,
} from "../src/index.js";

describe("Orb themes", () => {
  it("provides complete activity, text, and error tokens for every theme", () => {
    expect(ORB_THEME_NAMES).toEqual(["catppuccin", "github", "claude", "openai", "clay"]);
    for (const name of ORB_THEME_NAMES) {
      const theme = ORB_THEMES[name];
      for (const color of [
        theme.background,
        theme.low,
        theme.medium,
        theme.high,
        theme.core,
        theme.label,
        theme.muted,
        theme.error,
      ]) {
        expect(color).toMatch(/^#[\dA-F]{6}$/u);
      }
    }
  });

  it("interpolates the full theme ramp from the continuous breathing energy", () => {
    const theme = ORB_THEMES.catppuccin;
    expect(orbColorAtEnergy(theme, 0)).toBe("#494060");
    expect(orbColorAtEnergy(theme, 0.35)).toBe("#726090");
    expect(orbColorAtEnergy(theme, 0.70)).toBe("#9d82c2");
    expect(orbColorAtEnergy(theme, 1)).toBe("#cba6f7");

    const glyph = colorizeOrbGlyph("●", 1, theme);
    expect(stripTerminalSequences(glyph)).toBe("●");
    expect(glyph).toContain("\x1b[38;2;203;166;247m");

    const muted = colorizeThemeText("Thinking", "muted", theme);
    expect(stripTerminalSequences(muted)).toBe("Thinking");
    expect(muted).toContain("\x1b[38;2;166;173;200m");
  });
});
