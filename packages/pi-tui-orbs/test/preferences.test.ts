import { describe, expect, it } from "vitest";
import { resolveColorPreference, resolveGlyphPreference, resolveMotionPreference } from "../src/index.js";

describe("terminal preferences", () => {
  it("reduces motion for non-interactive, dumb, and CI terminals", () => {
    expect(resolveMotionPreference("auto", { env: {}, isTTY: false })).toBe("reduced");
    expect(resolveMotionPreference("auto", { env: { TERM: "dumb" }, isTTY: true })).toBe("reduced");
    expect(resolveMotionPreference("auto", { env: { CI: "1" }, isTTY: true })).toBe("reduced");
    expect(resolveMotionPreference("auto", { env: { CI: "false" }, isTTY: true })).toBe("full");
    expect(resolveMotionPreference("full", { env: { CI: "1" }, isTTY: false })).toBe("full");
  });

  it("falls back to ASCII only when the terminal or locale requires it", () => {
    expect(resolveGlyphPreference("auto", { env: { TERM: "dumb" }, isTTY: true })).toBe("ascii");
    expect(resolveGlyphPreference("auto", { env: { LANG: "C" }, isTTY: true })).toBe("ascii");
    expect(resolveGlyphPreference("auto", { env: { LANG: "C.UTF-8" }, isTTY: true })).toBe("unicode");
    expect(resolveGlyphPreference("unicode", { env: { TERM: "dumb" }, isTTY: true })).toBe("unicode");
  });

  it("honors NO_COLOR while allowing an explicit truecolor override", () => {
    expect(resolveColorPreference("auto", { env: { NO_COLOR: "" }, isTTY: true })).toBe("never");
    expect(resolveColorPreference("auto", { env: {}, isTTY: false })).toBe("never");
    expect(resolveColorPreference("auto", { env: { TERM: "dumb" }, isTTY: true })).toBe("never");
    expect(resolveColorPreference("always", { env: { NO_COLOR: "1" }, isTTY: false })).toBe("always");
  });
});
