import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatedFrames, MotionHost } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AnimatedFrames", () => {
  it("derives frames from elapsed time without accumulating ticker drift", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "ascii",
      isTTY: true,
      now: () => now,
    });
    const animation = new AnimatedFrames(host, {
      frames: {
        unicode: ["A", "B", "C"],
        ascii: ["A", "B", "C"],
        reduced: { unicode: "R", ascii: "R" },
      },
      intervalMs: 80,
    });

    animation.start();
    expect(animation.render(1)).toEqual(["A"]);
    now = 79;
    expect(animation.render(1)).toEqual(["A"]);
    now = 80;
    expect(animation.render(1)).toEqual(["B"]);
    now = 800;
    expect(animation.render(1)).toEqual(["B"]);
    animation.stop();
    expect(animation.render(1)).toEqual(["R"]);
    host.dispose();
  });

  it("keeps output inside the width contract", () => {
    const host = new MotionHost(() => {}, { motion: "reduced", glyphs: "unicode", isTTY: true });
    const animation = new AnimatedFrames(host, {
      frames: { unicode: ["●●●"], ascii: ["OOO"] },
      styleLine: (line) => `\x1b[36m${line}\x1b[39m`,
    });
    expect(animation.render(2)).toEqual(["\x1b[36m●●\x1b[0m"]);
    expect(animation.render(0)).toEqual([""]);
  });

  it("does not enter a running state when its host is already disposed", () => {
    const host = new MotionHost(() => {}, { motion: "full", isTTY: true });
    const animation = new AnimatedFrames(host, {
      frames: { unicode: ["●"], ascii: ["O"] },
    });
    host.dispose();
    expect(() => animation.start()).toThrow(/disposed/u);
    expect(animation.running).toBe(false);
  });
});
