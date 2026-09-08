import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MotionHost,
  SHIMMER_TICK_MS,
  SHIMMER_VELOCITIES,
  ShimmerText,
  shimmerPosition,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("shimmer timeline", () => {
  it("separates direction, loop mode, and soft endpoint easing", () => {
    const sweep = 1_000;

    expect(shimmerPosition(0, sweep, "left-to-right", "wrap", "linear")).toEqual({
      position: 0,
      finished: false,
    });
    expect(shimmerPosition(500, sweep, "left-to-right", "wrap", "linear").position)
      .toBeCloseTo(0.5, 8);
    expect(shimmerPosition(500, sweep, "right-to-left", "wrap", "linear").position)
      .toBeCloseTo(0.5, 8);
    expect(shimmerPosition(250, sweep, "right-to-left", "wrap", "linear").position)
      .toBeCloseTo(0.75, 8);
    expect(shimmerPosition(sweep, sweep, "left-to-right", "wrap", "linear").position)
      .toBeCloseTo(0, 8);

    expect(shimmerPosition(sweep, sweep, "left-to-right", "ping-pong", "soft").position)
      .toBeCloseTo(1, 8);
    expect(shimmerPosition(sweep * 1.5, sweep, "left-to-right", "ping-pong", "soft").position)
      .toBeCloseTo(0.5, 4);
    expect(shimmerPosition(sweep * 2, sweep, "left-to-right", "ping-pong", "soft").position)
      .toBeCloseTo(0, 8);

    expect(shimmerPosition(sweep, sweep, "left-to-right", "once", "soft")).toEqual({
      position: 1,
      finished: true,
    });
  });
});

describe("ShimmerText", () => {
  it("keeps visible text stable while the full-text light band moves", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const text = "Assistant 正在整理工具结果 ✨";
    const shimmer = new ShimmerText(host, {
      text,
      active: true,
      theme: "catppuccin",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "soft",
      bandWidth: 8,
      intensity: 0.86,
    });

    const start = shimmer.render(80).join("\n");
    expect(stripTerminalSequences(start)).toBe("Assistant 正在整理工具结果 ✨");
    expect(vi.getTimerCount()).toBe(1);

    const travelMs = ((visibleWidth(text) + 24) / SHIMMER_VELOCITIES.normal) * 1_000;
    now = travelMs / 2;
    const middle = shimmer.render(80).join("\n");
    expect(stripTerminalSequences(middle)).toBe("Assistant 正在整理工具结果 ✨");
    expect(middle).not.toBe(start);
    expect(middle).toContain("\x1b[38;2;");

    shimmer.dispose();
    host.dispose();
  });

  it("pauses on the exact ANSI frame and resumes from that position", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const baselineHost = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const paused = new ShimmerText(host, { text: "continuous phase", active: true });
    const baseline = new ShimmerText(baselineHost, { text: "continuous phase", active: true });
    paused.render(80);
    baseline.render(80);

    now = 320;
    paused.pause();
    const frozen = paused.render(80);
    expect(paused.state).toBe("paused");
    expect(vi.getTimerCount()).toBe(1);

    now = 1_320;
    expect(paused.render(80)).toEqual(frozen);
    paused.resume();
    now = 1_520;
    const resumed = paused.render(80);

    now = 520;
    expect(resumed).toEqual(baseline.render(80));

    paused.dispose();
    baseline.dispose();
    host.dispose();
    baselineHost.dispose();
  });

  it("preserves beam position when speed changes", () => {
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const text = "speed without teleporting";
    const shimmer = new ShimmerText(host, {
      text,
      active: true,
      speed: "normal",
    });

    now = (((visibleWidth(text) + 24) / SHIMMER_VELOCITIES.normal) * 1_000) / 2;
    const before = shimmer.render(80);
    shimmer.setSpeed("fast");
    expect(shimmer.render(80)).toEqual(before);

    now += 250;
    expect(shimmer.render(80)).not.toEqual(before);
    shimmer.dispose();
    host.dispose();
  });

  it("settles a once sweep and releases its shared motion lease", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const text = "One clean pass";
    const shimmer = new ShimmerText(host, {
      text,
      active: true,
      loop: "once",
      speed: "normal",
    });

    const travelMs = ((visibleWidth(text) + 24) / SHIMMER_VELOCITIES.normal) * 1_000;
    now = travelMs - 1;
    shimmer.render(80);
    expect(shimmer.state).toBe("running");
    expect(vi.getTimerCount()).toBe(1);

    now = travelMs;
    expect(shimmer.render(80)).toEqual([text]);
    expect(shimmer.state).toBe("finished");
    expect(shimmer.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    shimmer.restart();
    expect(shimmer.state).toBe("running");
    expect(vi.getTimerCount()).toBe(1);
    shimmer.dispose();
    host.dispose();
  });

  it("shares one host ticker and releases it only after every specimen stops", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
    });
    const first = new ShimmerText(host, { text: "first", active: true });
    const second = new ShimmerText(host, { text: "second", active: true });
    first.render(80);
    second.render(80);

    expect(vi.getTimerCount()).toBe(1);
    expect(SHIMMER_TICK_MS).toBe(50);
    first.pause();
    expect(vi.getTimerCount()).toBe(1);
    second.pause();
    expect(vi.getTimerCount()).toBe(0);

    first.dispose();
    second.dispose();
    host.dispose();
  });

  it("finishes once from the shared deadline even when the component becomes hidden", () => {
    vi.useFakeTimers();
    let now = 0;
    const text = "hidden once";
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const shimmer = new ShimmerText(host, {
      text,
      active: true,
      loop: "once",
      speed: "fast",
      curve: "linear",
    });

    expect(vi.getTimerCount()).toBe(0);
    shimmer.render(80);
    expect(vi.getTimerCount()).toBe(1);
    const travelMs = ((visibleWidth(text) + 24) / SHIMMER_VELOCITIES.fast) * 1_000;
    now = travelMs;
    vi.advanceTimersByTime(SHIMMER_TICK_MS);

    expect(shimmer.state).toBe("finished");
    expect(vi.getTimerCount()).toBe(0);

    shimmer.restart();
    expect(vi.getTimerCount()).toBe(1);
    now += travelMs;
    vi.advanceTimersByTime(SHIMMER_TICK_MS);
    expect(shimmer.state).toBe("finished");
    expect(vi.getTimerCount()).toBe(0);

    shimmer.dispose();
    host.dispose();
  });

  it("settles once immediately when no animated frame can be displayed", () => {
    vi.useFakeTimers();
    const reducedHost = new MotionHost(() => {}, {
      motion: "reduced",
      color: "always",
      isTTY: true,
    });
    const zeroWidthHost = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
    });
    const reduced = new ShimmerText(reducedHost, {
      text: "reduced once",
      active: true,
      loop: "once",
    });
    const zeroWidth = new ShimmerText(zeroWidthHost, {
      text: "zero width once",
      active: true,
      loop: "once",
    });

    expect(reduced.render(80)).toEqual(["reduced once"]);
    expect(zeroWidth.render(0)).toEqual([""]);
    expect(reduced.state).toBe("finished");
    expect(zeroWidth.state).toBe("finished");
    expect(vi.getTimerCount()).toBe(0);

    reduced.dispose();
    zeroWidth.dispose();
    reducedHost.dispose();
    zeroWidthHost.dispose();
  });

  it("renders static plain text without a ticker for reduced motion and NO_COLOR", () => {
    vi.useFakeTimers();
    const reducedHost = new MotionHost(() => {}, {
      motion: "reduced",
      color: "always",
      isTTY: true,
    });
    const noColorHost = new MotionHost(() => {}, {
      motion: "full",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
    });
    const reduced = new ShimmerText(reducedHost, {
      text: "静态 reduced motion",
      active: true,
    });
    const noColor = new ShimmerText(noColorHost, {
      text: "\x1b[31mNO_COLOR\x1b[0m",
      active: true,
    });

    expect(reduced.render(80)).toEqual(["静态 reduced motion"]);
    expect(noColor.render(80)).toEqual(["NO_COLOR"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wraps CJK and emoji without changing visible content or terminal width", () => {
    const host = new MotionHost(() => {}, { motion: "reduced", color: "always" });
    const shimmer = new ShimmerText(host, {
      text: "中文闪光👨‍💻e\u0301组合字符保持完整",
      active: true,
    });
    const lines = shimmer.render(8);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
    expect(lines.join("")).toBe("中文闪光👨‍💻e\u0301组合字符保持完整");
    expect(shimmer.render(0)).toEqual([""]);
    shimmer.dispose();
    host.dispose();
  });

  it("validates visual controls instead of silently accepting unusable values", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    expect(() => new ShimmerText(host, { bandWidth: 0 })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { bandWidth: 33 })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { intensity: -0.1 })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { intensity: 1.1 })).toThrow(RangeError);
  });
});
