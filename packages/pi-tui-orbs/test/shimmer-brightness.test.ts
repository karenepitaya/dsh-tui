import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorizeHexText,
  interpolateHexColor,
  MotionHost,
  ORB_THEMES,
  ShimmerText,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ShimmerText brightness controls", () => {
  it("uses independent base and shimmer defaults", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    const shimmer = new ShimmerText(host, { text: "defaults" });

    expect(shimmer.baseBrightness).toBe(0.10);
    expect(shimmer.shimmerBrightness).toBe(0.90);
    expect(shimmer.intensity).toBe(0.90);

    shimmer.dispose();
    host.dispose();
  });

  it("keeps intensity as an alias while preferring shimmerBrightness", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    const legacy = new ShimmerText(host, { intensity: 0.35 });
    const explicit = new ShimmerText(host, {
      baseBrightness: 0.25,
      shimmerBrightness: 0.72,
      intensity: 2,
    });

    expect(legacy.shimmerBrightness).toBe(0.35);
    expect(legacy.intensity).toBe(0.35);
    expect(explicit.baseBrightness).toBe(0.25);
    expect(explicit.shimmerBrightness).toBe(0.72);
    expect(explicit.intensity).toBe(0.72);

    legacy.dispose();
    explicit.dispose();
    host.dispose();
  });

  it("validates both constructor controls and their live setters", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    expect(() => new ShimmerText(host, { baseBrightness: -0.01 })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { baseBrightness: 1.01 })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { shimmerBrightness: Number.NaN })).toThrow(RangeError);
    expect(() => new ShimmerText(host, { shimmerBrightness: Number.POSITIVE_INFINITY }))
      .toThrow(RangeError);

    const shimmer = new ShimmerText(host);
    shimmer.setBaseBrightness(0);
    shimmer.setShimmerBrightness(0);
    expect(shimmer.baseBrightness).toBe(0);
    expect(shimmer.shimmerBrightness).toBe(0);
    shimmer.setBaseBrightness(1);
    shimmer.setShimmerBrightness(1);
    expect(shimmer.baseBrightness).toBe(1);
    expect(shimmer.shimmerBrightness).toBe(1);
    shimmer.setIntensity(0.4);
    expect(shimmer.shimmerBrightness).toBe(0.4);
    expect(shimmer.intensity).toBe(0.4);

    expect(() => shimmer.setBaseBrightness(-0.01)).toThrow(RangeError);
    expect(() => shimmer.setBaseBrightness(1.01)).toThrow(RangeError);
    expect(() => shimmer.setShimmerBrightness(-0.01)).toThrow(RangeError);
    expect(() => shimmer.setShimmerBrightness(1.01)).toThrow(RangeError);
    expect(() => shimmer.setIntensity(Number.NaN)).toThrow(RangeError);

    shimmer.dispose();
    host.dispose();
  });

  it("renders the configured dark base without retaining an animation lease", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const shimmer = new ShimmerText(host, {
      text: "static base",
      active: true,
      theme: "github",
      loop: "once",
      baseBrightness: 0.10,
      shimmerBrightness: 0,
    });
    const expectedBase = interpolateHexColor(
      ORB_THEMES.github.muted,
      ORB_THEMES.github.label,
      0.10,
    );
    const first = shimmer.render(80);

    expect(first).toEqual([colorizeHexText("static base", expectedBase)]);
    expect(stripTerminalSequences(first[0] ?? "")).toBe("static base");
    expect(vi.getTimerCount()).toBe(0);

    now = 50_000;
    expect(shimmer.render(80)).toEqual(first);
    expect(shimmer.state).toBe("running");
    expect(vi.getTimerCount()).toBe(0);

    shimmer.setShimmerBrightness(0.9);
    expect(shimmer.state).toBe("running");
    expect(vi.getTimerCount()).toBe(1);

    shimmer.dispose();
    host.dispose();
  });

  it("keeps reduced motion and NO_COLOR as plain static text", () => {
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
      text: "reduced",
      active: true,
      baseBrightness: 0.8,
      shimmerBrightness: 0,
    });
    const noColor = new ShimmerText(noColorHost, {
      text: "\x1b[31mno color\x1b[0m",
      active: true,
      baseBrightness: 0.8,
      shimmerBrightness: 0,
    });

    expect(reduced.render(80)).toEqual(["reduced"]);
    expect(noColor.render(80)).toEqual(["no color"]);
    expect(vi.getTimerCount()).toBe(0);

    reduced.dispose();
    noColor.dispose();
    reducedHost.dispose();
    noColorHost.dispose();
  });
});
