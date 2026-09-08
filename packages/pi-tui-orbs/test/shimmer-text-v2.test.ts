import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "../src/index.js";
import {
  interpolateHexColor,
  MotionHost,
  ORB_THEMES,
  ShimmerText,
  type ShimmerTextOptions,
} from "../src/index.js";

type Speed = "slow" | "normal" | "fast";
type Rgb = readonly [red: number, green: number, blue: number];

interface ShimmerV2Options extends ShimmerTextOptions {
  readonly trailLength?: number;
  readonly holdMs?: number;
}

interface ShimmerV2Controls {
  readonly trailLength: number;
  readonly holdMs: number;
  setTrailLength(trailLength: number): void;
  setHoldMs(holdMs: number): void;
}

const FALLBACK_VELOCITIES: Readonly<Record<Speed, number>> = {
  slow: 12,
  normal: 20,
  fast: 32,
};

const TRUECOLOR_SEGMENT = /\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S]*?)\x1b\[39m/gu;

class FakeClock {
  now = 0;
  readonly host: MotionHost;

  constructor(options: {
    readonly motion?: "full" | "reduced";
    readonly color?: "always" | "never";
  } = {}) {
    this.host = new MotionHost(() => {}, {
      motion: options.motion ?? "full",
      color: options.color ?? "always",
      isTTY: true,
      now: () => this.now,
    });
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ShimmerText v2 public controls", () => {
  it("publishes cell velocities in increasing speed order", () => {
    const velocities = exportedVelocities();

    expect(velocities, "SHIMMER_VELOCITIES must be part of the public API").toBeDefined();
    expect(velocities?.slow).toBeGreaterThan(0);
    expect(velocities?.normal).toBeGreaterThan(velocities?.slow ?? Number.POSITIVE_INFINITY);
    expect(velocities?.fast).toBeGreaterThan(velocities?.normal ?? Number.POSITIVE_INFINITY);
  });

  it("validates and exposes core width, directional trail, and wrap hold", () => {
    const clock = new FakeClock({ motion: "reduced" });

    const minimum = createShimmer(clock.host, {
      bandWidth: 1,
      trailLength: 2,
      holdMs: 0,
    });
    const maximum = createShimmer(clock.host, {
      bandWidth: 8,
      trailLength: 32,
      holdMs: 2_000,
    });

    expect(minimum.bandWidth).toBe(1);
    expect(v2Controls(minimum).trailLength).toBe(2);
    expect(v2Controls(minimum).holdMs).toBe(0);
    expect(maximum.bandWidth).toBe(8);
    expect(v2Controls(maximum).trailLength).toBe(32);
    expect(v2Controls(maximum).holdMs).toBe(2_000);

    v2Controls(minimum).setTrailLength(7);
    v2Controls(minimum).setHoldMs(450);
    expect(v2Controls(minimum).trailLength).toBe(7);
    expect(v2Controls(minimum).holdMs).toBe(450);

    expect(() => createShimmer(clock.host, { bandWidth: 0 })).toThrow(RangeError);
    expect(() => createShimmer(clock.host, { bandWidth: 9 })).toThrow(RangeError);
    expect(() => createShimmer(clock.host, { trailLength: 1 })).toThrow(RangeError);
    expect(() => createShimmer(clock.host, { trailLength: 33 })).toThrow(RangeError);
    expect(() => createShimmer(clock.host, { holdMs: -1 })).toThrow(RangeError);
    expect(() => createShimmer(clock.host, { holdMs: 2_001 })).toThrow(RangeError);

    minimum.dispose();
    maximum.dispose();
    clock.host.dispose();
  });
});

describe("ShimmerText v2 rendering", () => {
  it("uses a quiet label-tinted base instead of raw muted text", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const text = "0123456789".repeat(6);
    const shimmer = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 2,
      trailLength: 6,
      holdMs: 0,
    });

    const rendered = shimmer.render(100)[0] ?? "";
    const colors = cellColors(rendered);
    const expectedBase = rgbFromHex(interpolateHexColor(
      ORB_THEMES.openai.muted,
      ORB_THEMES.openai.label,
      0.1,
    ));

    expect(stripTerminalSequences(rendered)).toBe(text);
    expect(colors).toHaveLength(visibleWidth(text));
    expect(colorDistance(colors.at(-1) ?? [0, 0, 0], expectedBase)).toBeLessThanOrEqual(3);

    shimmer.dispose();
    clock.host.dispose();
  });

  it("keeps a directional trail behind the bright core", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const base = openAiBase();
    const leftToRight = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 8,
      holdMs: 0,
    });
    const rightToLeft = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "right-to-left",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 8,
      holdMs: 0,
    });

    const sample = findInteriorFrame(leftToRight, clock, base, 12, text.length - 13);
    const reverseColors = cellColors(rightToLeft.render(100)[0] ?? "");
    const reversePeak = peakColumn(reverseColors, base);

    expect(highlightScore(sample.colors[sample.peak - 3], base))
      .toBeGreaterThan(highlightScore(sample.colors[sample.peak + 3], base));
    expect(highlightScore(reverseColors[reversePeak + 3], base))
      .toBeGreaterThan(highlightScore(reverseColors[reversePeak - 3], base));

    leftToRight.dispose();
    rightToLeft.dispose();
    clock.host.dispose();
  });

  it("uses one beam cell coordinate for every line, based on the maximum line width", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const shimmer = createShimmer(clock.host, {
      text: "ABCDEFGHIJKLMNOPQRST\nabcdefghijkl",
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 4,
      holdMs: 0,
    });
    const base = openAiBase();
    let observed: { readonly longPeak: number; readonly shortPeak: number } | undefined;

    for (clock.now = 0; clock.now <= 10_000; clock.now += 20) {
      const lines = shimmer.render(80);
      if (lines.length !== 2) continue;
      const longColors = cellColors(lines[0] ?? "");
      const shortColors = cellColors(lines[1] ?? "");
      const longPeak = peakColumn(longColors, base);
      if (!hasHighlight(longColors, base) || longPeak < 5 || longPeak > 8) continue;
      observed = { longPeak, shortPeak: peakColumn(shortColors, base) };
      break;
    }

    expect(observed, "expected to observe the beam inside both lines").toBeDefined();
    expect(Math.abs((observed?.longPeak ?? 0) - (observed?.shortPeak ?? 99)))
      .toBeLessThanOrEqual(1);

    shimmer.dispose();
    clock.host.dispose();
  });

  it("leaves a timer-backed, highlight-free hold between wrap sweeps", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const shimmer = createShimmer(clock.host, {
      text: "wrap hold remains semantically active",
      active: true,
      theme: "openai",
      speed: "fast",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 4,
      holdMs: 600,
    });
    const base = openAiBase();
    let sawHighlight = false;
    let holdStartedAt: number | undefined;

    for (clock.now = 0; clock.now <= 15_000; clock.now += 20) {
      const colors = cellColors(shimmer.render(80)[0] ?? "");
      if (hasHighlight(colors, base)) sawHighlight = true;
      else if (sawHighlight) {
        holdStartedAt = clock.now;
        break;
      }
    }

    expect(holdStartedAt, "expected a no-highlight frame after the first sweep").toBeDefined();
    clock.now = (holdStartedAt ?? 0) + 300;
    const held = cellColors(shimmer.render(80)[0] ?? "");
    expect(hasHighlight(held, base)).toBe(false);
    expect(shimmer.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    shimmer.dispose();
    clock.host.dispose();
  });

  it("restarts a changed direction from its opposite offscreen origin", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const text = "0123456789".repeat(6);
    const shimmer = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 5,
      holdMs: 100,
    });
    const base = openAiBase();
    const velocity = velocitiesForExercise().normal;
    const before = findInteriorFrame(shimmer, clock, base, 15, 35);

    shimmer.setDirection("right-to-left");
    const reset = cellColors(shimmer.render(100)[0] ?? "");
    expect(shimmer.direction).toBe("right-to-left");
    expect(reset).not.toEqual(before.colors);
    expect(hasHighlight(reset, base)).toBe(false);

    const offscreenExtent = Math.max(shimmer.bandWidth, v2Controls(shimmer).trailLength);
    clock.advance(((offscreenExtent - 0.25) / velocity) * 1_000);
    expect(hasHighlight(cellColors(shimmer.render(100)[0] ?? ""), base)).toBe(false);

    clock.advance((0.5 / velocity) * 1_000);
    const reentry = cellColors(shimmer.render(100)[0] ?? "");
    expect(hasHighlight(reentry, base)).toBe(true);
    expect(peakColumn(reentry, base)).toBeGreaterThan(text.length * 0.65);

    shimmer.dispose();
    clock.host.dispose();
  });
});

describe("ShimmerText v2 timeline and fallbacks", () => {
  it("moves by cells per second and preserves the physical beam position when speed changes", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const text = "0123456789".repeat(10);
    const shimmer = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: 1,
      trailLength: 4,
      holdMs: 0,
    });
    const base = openAiBase();
    const before = findInteriorFrame(shimmer, clock, base, 20, 45);

    shimmer.setSpeed("fast");
    expect(cellColors(shimmer.render(120)[0] ?? "")).toEqual(before.colors);

    const expectedTravel = 4;
    clock.advance((expectedTravel / velocitiesForExercise().fast) * 1_000);
    const after = cellColors(shimmer.render(120)[0] ?? "");
    expect(peakColumn(after, base) - before.peak).toBeGreaterThanOrEqual(expectedTravel - 1);
    expect(peakColumn(after, base) - before.peak).toBeLessThanOrEqual(expectedTravel + 1);

    shimmer.dispose();
    clock.host.dispose();
  });

  it("freezes on pause, resumes spatially, and shares one host ticker", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const firstText = "pause and resume without teleporting";
    const coreWidth = 1;
    const trailLength = 5;
    const first = createShimmer(clock.host, {
      text: firstText,
      active: true,
      theme: "openai",
      speed: "normal",
      direction: "left-to-right",
      loop: "wrap",
      curve: "linear",
      bandWidth: coreWidth,
      trailLength,
      holdMs: 0,
    });
    const second = createShimmer(clock.host, {
      text: "shared ticker",
      active: true,
      theme: "openai",
    });
    first.render(80);
    second.render(80);

    const velocity = velocitiesForExercise().normal;
    const offscreenExtent = Math.max(coreWidth, trailLength);
    const comfortablyVisibleAt = ((offscreenExtent + 2) / velocity) * 1_000;
    clock.now = comfortablyVisibleAt;
    first.pause();
    const frozen = first.render(80);
    const frozenColors = cellColors(frozen[0] ?? "");
    const frozenPeak = peakColumn(frozenColors, openAiBase());
    expect(hasHighlight(frozenColors, openAiBase())).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    clock.advance(2_000);
    expect(first.render(80)).toEqual(frozen);

    second.pause();
    expect(vi.getTimerCount()).toBe(0);
    first.resume();
    expect(vi.getTimerCount()).toBe(1);
    const expectedTravel = 3;
    clock.advance((expectedTravel / velocity) * 1_000);
    const resumed = cellColors(first.render(80)[0] ?? "");
    expect(peakColumn(resumed, openAiBase()) - frozenPeak)
      .toBeGreaterThanOrEqual(expectedTravel - 1);
    expect(peakColumn(resumed, openAiBase()) - frozenPeak)
      .toBeLessThanOrEqual(expectedTravel + 1);

    first.dispose();
    second.dispose();
    clock.host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes one cell-driven pass and releases its lease", () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const text = "one pass has a geometry-dependent duration";
    const shimmer = createShimmer(clock.host, {
      text,
      active: true,
      theme: "openai",
      speed: "fast",
      direction: "left-to-right",
      loop: "once",
      curve: "linear",
      bandWidth: 2,
      trailLength: 6,
      holdMs: 0,
    });
    let finalFrame: string[] | undefined;

    for (clock.now = 0; clock.now <= 20_000; clock.now += 25) {
      finalFrame = shimmer.render(80);
      if (shimmer.state === "finished") break;
    }

    expect(shimmer.state).toBe("finished");
    expect(shimmer.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(stripTerminalSequences((finalFrame ?? []).join("\n"))).toBe(text);

    shimmer.dispose();
    clock.host.dispose();
  });

  it("stays plain and timer-free for reduced motion, NO_COLOR, and narrow wrapping", () => {
    vi.useFakeTimers();
    const reducedClock = new FakeClock({ motion: "reduced" });
    const noColorHost = new MotionHost(() => {}, {
      motion: "full",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
    });
    const text = "中文闪光👨‍💻e\u0301窄宽保持完整";
    const reduced = createShimmer(reducedClock.host, {
      text,
      active: true,
      trailLength: 7,
      holdMs: 400,
    });
    const noColor = createShimmer(noColorHost, {
      text: `\x1b[31m${text}\x1b[0m`,
      active: true,
      trailLength: 7,
      holdMs: 400,
    });

    const reducedLines = reduced.render(8);
    const noColorLines = noColor.render(8);
    for (const line of [...reducedLines, ...noColorLines]) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(8);
      expect(line).not.toContain("\x1b");
    }
    expect(reducedLines.join("")).toBe(text);
    expect(noColorLines.join("")).toBe(text);
    expect(vi.getTimerCount()).toBe(0);

    reduced.dispose();
    noColor.dispose();
    reducedClock.host.dispose();
    noColorHost.dispose();
  });
});

function createShimmer(host: MotionHost, options: ShimmerV2Options = {}): ShimmerText {
  return new ShimmerText(host, options);
}

function v2Controls(shimmer: ShimmerText): ShimmerV2Controls {
  return shimmer as unknown as ShimmerV2Controls;
}

function exportedVelocities(): Readonly<Record<Speed, number>> | undefined {
  return (publicApi as unknown as {
    readonly SHIMMER_VELOCITIES?: Readonly<Record<Speed, number>>;
  }).SHIMMER_VELOCITIES;
}

function velocitiesForExercise(): Readonly<Record<Speed, number>> {
  return exportedVelocities() ?? FALLBACK_VELOCITIES;
}

function openAiBase(): Rgb {
  return rgbFromHex(interpolateHexColor(
    ORB_THEMES.openai.muted,
    ORB_THEMES.openai.label,
    0.1,
  ));
}

function rgbFromHex(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function cellColors(line: string): Rgb[] {
  const colors: Rgb[] = [];
  for (const match of line.matchAll(TRUECOLOR_SEGMENT)) {
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    const columns = visibleWidth(match[4] ?? "");
    for (let column = 0; column < columns; column += 1) {
      colors.push([red, green, blue]);
    }
  }
  return colors;
}

function colorDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function highlightScore(color: Rgb | undefined, base: Rgb): number {
  return color === undefined ? 0 : colorDistance(color, base);
}

function hasHighlight(colors: readonly Rgb[], base: Rgb): boolean {
  return colors.some((color) => highlightScore(color, base) > 4);
}

function peakColumn(colors: readonly Rgb[], base: Rgb): number {
  let peak = 0;
  let best = Number.NEGATIVE_INFINITY;
  colors.forEach((color, index) => {
    const score = highlightScore(color, base);
    if (score <= best) return;
    best = score;
    peak = index;
  });
  return peak;
}

function findInteriorFrame(
  shimmer: ShimmerText,
  clock: FakeClock,
  base: Rgb,
  minimumPeak: number,
  maximumPeak: number,
): { readonly colors: Rgb[]; readonly peak: number } {
  const start = clock.now;
  for (clock.now = start; clock.now <= start + 15_000; clock.now += 20) {
    const colors = cellColors(shimmer.render(160)[0] ?? "");
    const peak = peakColumn(colors, base);
    if (hasHighlight(colors, base) && peak >= minimumPeak && peak <= maximumPeak) {
      return { colors, peak };
    }
  }
  throw new Error(`Unable to observe a beam between cells ${minimumPeak} and ${maximumPeak}.`);
}
