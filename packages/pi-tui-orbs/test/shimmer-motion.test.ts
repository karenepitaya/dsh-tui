import { describe, expect, it } from "vitest";
import {
  SHIMMER_PERIODS,
  SHIMMER_VELOCITIES,
  shimmerDirectionalEnergyAt,
  shimmerEnergyAt,
  shimmerFrameAt,
  shimmerPosition,
  shimmerWeight,
  type ShimmerFrameOptions,
} from "../src/presets/shimmer.js";

const BASE_FRAME: ShimmerFrameOptions = {
  trackWidth: 10,
  velocity: 10,
  coreWidth: 2,
  trailLength: 4,
  holdMs: 200,
  direction: "left-to-right",
  loop: "wrap",
  curve: "linear",
};

function frameAt(elapsedMs: number, update: Partial<ShimmerFrameOptions> = {}) {
  return shimmerFrameAt(elapsedMs, { ...BASE_FRAME, ...update });
}

describe("Shimmer v2 motion kernel", () => {
  it("keeps the legacy period, position, energy, and weight contracts intact", () => {
    expect(SHIMMER_PERIODS).toEqual({ slow: 1_400, normal: 1_000, fast: 760 });
    expect(shimmerPosition(500, 1_000, "left-to-right", "wrap", "linear"))
      .toEqual({ position: 0.5, finished: false });
    expect(shimmerEnergyAt(0.5, 0.5, 0.2)).toBe(1);
    expect(shimmerWeight(1)).toBe(0.86);
  });

  it("provides cell velocities that remain visually distinct across presets", () => {
    expect(SHIMMER_VELOCITIES).toEqual({ slow: 12, normal: 20, fast: 32 });
  });

  it("wraps only after traversing the common offscreen extent and holding", () => {
    // Common extent is max(coreWidth, trailLength) = 4. The beam travels
    // from -4 to 14: 18 cells at 10 cells/s, so one pass takes 1,800 ms.
    expect(frameAt(0)).toEqual({
      beamCenter: -4,
      heading: 1,
      active: true,
      finished: false,
    });
    expect(frameAt(900).beamCenter).toBeCloseTo(5, 8);
    expect(frameAt(1_799).beamCenter).toBeGreaterThan(13.98);
    expect(frameAt(1_800)).toEqual({
      beamCenter: 14,
      heading: 1,
      active: false,
      finished: false,
    });
    expect(frameAt(1_999)).toEqual({
      beamCenter: 14,
      heading: 1,
      active: false,
      finished: false,
    });
    expect(frameAt(2_000)).toEqual({
      beamCenter: -4,
      heading: 1,
      active: true,
      finished: false,
    });
  });

  it("mirrors wrap geometry for a right-to-left heading", () => {
    expect(frameAt(0, { direction: "right-to-left" })).toEqual({
      beamCenter: 14,
      heading: -1,
      active: true,
      finished: false,
    });
    expect(frameAt(900, { direction: "right-to-left" }).beamCenter).toBeCloseTo(5, 8);
    expect(frameAt(1_800, { direction: "right-to-left" })).toEqual({
      beamCenter: -4,
      heading: -1,
      active: false,
      finished: false,
    });
  });

  it("reverses the true heading after every held ping-pong leg without jumping centers", () => {
    const pingPong = { loop: "ping-pong" } as const;
    expect(frameAt(0, pingPong).heading).toBe(1);
    expect(frameAt(1_800, pingPong)).toEqual({
      beamCenter: 14,
      heading: 1,
      active: false,
      finished: false,
    });
    expect(frameAt(2_000, pingPong)).toEqual({
      beamCenter: 14,
      heading: -1,
      active: true,
      finished: false,
    });
    expect(frameAt(2_900, pingPong).beamCenter).toBeCloseTo(5, 8);
    expect(frameAt(3_800, pingPong)).toEqual({
      beamCenter: -4,
      heading: -1,
      active: false,
      finished: false,
    });
    expect(frameAt(4_000, pingPong)).toEqual({
      beamCenter: -4,
      heading: 1,
      active: true,
      finished: false,
    });
  });

  it("starts a reversed ping-pong in the requested direction", () => {
    const options = { loop: "ping-pong", direction: "right-to-left" } as const;
    expect(frameAt(0, options).heading).toBe(-1);
    expect(frameAt(0, options).beamCenter).toBe(14);
    expect(frameAt(2_000, options).heading).toBe(1);
    expect(frameAt(2_000, options).beamCenter).toBe(-4);
  });

  it("finishes a once sweep at the far offscreen endpoint", () => {
    const once = { loop: "once" } as const;
    expect(frameAt(1_799, once).finished).toBe(false);
    expect(frameAt(1_800, once)).toEqual({
      beamCenter: 14,
      heading: 1,
      active: false,
      finished: true,
    });
    expect(frameAt(20_000, once)).toEqual(frameAt(1_800, once));

    expect(frameAt(1_800, { ...once, direction: "right-to-left" })).toEqual({
      beamCenter: -4,
      heading: -1,
      active: false,
      finished: true,
    });
  });

  it("applies the selected curve without changing the velocity-derived duration", () => {
    const linearQuarter = frameAt(450).beamCenter;
    const softQuarter = frameAt(450, { curve: "soft" }).beamCenter;
    const linearThreeQuarter = frameAt(1_350).beamCenter;
    const softThreeQuarter = frameAt(1_350, { curve: "soft" }).beamCenter;

    expect(softQuarter).toBeLessThan(linearQuarter);
    expect(softThreeQuarter).toBeGreaterThan(linearThreeQuarter);
    expect(frameAt(1_800, { curve: "soft" }).finished).toBe(false);
  });

  it("clamps negative elapsed time but rejects invalid timeline geometry", () => {
    expect(frameAt(-1)).toEqual(frameAt(0));
    expect(() => frameAt(Number.NaN)).toThrow(RangeError);
    expect(() => frameAt(Number.POSITIVE_INFINITY)).toThrow(RangeError);

    const invalid = (update: Partial<ShimmerFrameOptions>) => (
      () => shimmerFrameAt(0, { ...BASE_FRAME, ...update })
    );
    expect(invalid({ trackWidth: 0 })).toThrow(RangeError);
    expect(invalid({ velocity: 0 })).toThrow(RangeError);
    expect(invalid({ coreWidth: 0 })).toThrow(RangeError);
    expect(invalid({ trailLength: -1 })).toThrow(RangeError);
    expect(invalid({ holdMs: -1 })).toThrow(RangeError);
    expect(invalid({ trackWidth: Number.NaN })).toThrow(RangeError);
    expect(invalid({ velocity: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(invalid({ coreWidth: Number.NaN })).toThrow(RangeError);
    expect(invalid({ trailLength: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(invalid({ holdMs: Number.NaN })).toThrow(RangeError);
    expect(invalid({ direction: "sideways" as never })).toThrow(TypeError);
    expect(invalid({ loop: "forever" as never })).toThrow(TypeError);
    expect(invalid({ curve: "spring" as never })).toThrow(TypeError);
  });
});

describe("directional shimmer energy", () => {
  it("keeps substantially more energy on the trailing side than ahead", () => {
    const trailing = shimmerDirectionalEnergyAt(-0.5, 0, 1, 2, 4, "linear");
    const ahead = shimmerDirectionalEnergyAt(0.5, 0, 1, 2, 4, "linear");
    expect(trailing).toBeGreaterThan(ahead + 0.3);
    expect(trailing).toBeCloseTo(0.875, 8);
    expect(ahead).toBeCloseTo(0.5, 8);
  });

  it("mirrors the asymmetric band exactly when heading reverses", () => {
    for (const position of [-5, -2, -0.5, 0, 0.5, 1, 5]) {
      const forward = shimmerDirectionalEnergyAt(position, 0, 1, 2, 4, "soft");
      const reversedMirror = shimmerDirectionalEnergyAt(-position, 0, -1, 2, 4, "soft");
      expect(reversedMirror).toBeCloseTo(forward, 12);
    }
  });

  it("becomes symmetric without a trail and reaches zero at both extents", () => {
    expect(shimmerDirectionalEnergyAt(-0.5, 0, 1, 2, 0, "linear"))
      .toBeCloseTo(shimmerDirectionalEnergyAt(0.5, 0, 1, 2, 0, "linear"), 12);
    expect(shimmerDirectionalEnergyAt(0, 0, 1, 2, 4, "linear")).toBe(1);
    expect(shimmerDirectionalEnergyAt(1, 0, 1, 2, 4, "linear")).toBe(0);
    expect(shimmerDirectionalEnergyAt(-5, 0, 1, 2, 4, "linear")).toBe(0);
    expect(shimmerDirectionalEnergyAt(20, 0, 1, 2, 4, "linear")).toBe(0);
  });

  it("supports a softer falloff while preserving all validation boundaries", () => {
    const linear = shimmerDirectionalEnergyAt(0.25, 0, 1, 2, 4, "linear");
    const soft = shimmerDirectionalEnergyAt(0.25, 0, 1, 2, 4, "soft");
    expect(soft).not.toBeCloseTo(linear, 4);

    expect(() => shimmerDirectionalEnergyAt(Number.NaN, 0, 1, 2, 4, "linear"))
      .toThrow(RangeError);
    expect(() => shimmerDirectionalEnergyAt(0, Number.POSITIVE_INFINITY, 1, 2, 4, "linear"))
      .toThrow(RangeError);
    expect(() => shimmerDirectionalEnergyAt(0, 0, 0 as never, 2, 4, "linear"))
      .toThrow(TypeError);
    expect(() => shimmerDirectionalEnergyAt(0, 0, 1, 0, 4, "linear"))
      .toThrow(RangeError);
    expect(() => shimmerDirectionalEnergyAt(0, 0, 1, 2, -1, "linear"))
      .toThrow(RangeError);
    expect(() => shimmerDirectionalEnergyAt(0, 0, 1, 2, 4, "spring" as never))
      .toThrow(TypeError);
  });
});
