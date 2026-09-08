import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GradientBar,
  GRADIENT_BAR_PERIODS,
  GRADIENT_BAR_TICK_MS,
  gradientBarPosition,
  MotionHost,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("GradientBar", () => {
  it("moves one continuous truecolor beam across a fixed-width half-block track", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const bar = new GradientBar(host, {
      cells: 8,
      autoplay: true,
      theme: "github",
      speed: "normal",
    });

    const left = bar.render(80)[0] ?? "";
    expect(stripTerminalSequences(left)).toBe("▄".repeat(8));
    expect(visibleWidth(left)).toBe(8);
    expect(left).toContain("\x1b[38;2;");
    expect(vi.getTimerCount()).toBe(1);

    now = GRADIENT_BAR_PERIODS.normal / 2;
    const right = bar.render(80)[0] ?? "";
    expect(stripTerminalSequences(right)).toBe("▄".repeat(8));
    expect(right).not.toBe(left);

    now = GRADIENT_BAR_PERIODS.normal;
    expect(bar.render(80)[0]).toBe(left);

    bar.dispose();
    host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the host ticker across several bars", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const first = new GradientBar(host, { autoplay: true });
    const second = new GradientBar(host, { autoplay: true });

    expect(vi.getTimerCount()).toBe(1);
    expect(GRADIENT_BAR_TICK_MS).toBe(50);

    first.dispose();
    second.dispose();
    host.dispose();
  });

  it("keeps the density beam moving without color and stops it for reduced motion", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "ascii",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
      now: () => now,
    });
    const bar = new GradientBar(host, { cells: 8, autoplay: true });
    const first = bar.render(80)[0] ?? "";

    expect(first).toMatch(/^[ .:=+#]{8}$/u);
    expect(first).not.toContain("\x1b");
    expect(vi.getTimerCount()).toBe(1);

    now = GRADIENT_BAR_PERIODS.normal / 2;
    expect(bar.render(80)[0]).not.toBe(first);
    expect(visibleWidth(bar.render(5)[0] ?? "")).toBe(5);

    bar.dispose();
    host.dispose();

    const reducedHost = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const reduced = new GradientBar(reducedHost, { cells: 8, autoplay: true });
    expect(reduced.render(80)[0]).toBe(reduced.render(80)[0]);
    expect(vi.getTimerCount()).toBe(0);
    reduced.dispose();
    reducedHost.dispose();
  });

  it("uses a cosine ping-pong path with eased, continuous endpoints", () => {
    const period = GRADIENT_BAR_PERIODS.normal;
    expect(gradientBarPosition(0, period)).toBeCloseTo(0, 8);
    expect(gradientBarPosition(period * 0.25, period)).toBeCloseTo(0.5, 8);
    expect(gradientBarPosition(period * 0.5, period)).toBeCloseTo(1, 8);
    expect(gradientBarPosition(period * 0.75, period)).toBeCloseTo(0.5, 8);
    expect(gradientBarPosition(period, period)).toBeCloseTo(0, 8);
  });

  it("rejects track sizes that would not read as a compact loader", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    expect(() => new GradientBar(host, { cells: 3 })).toThrow(RangeError);
    expect(() => new GradientBar(host, { cells: 33 })).toThrow(RangeError);
  });
});
