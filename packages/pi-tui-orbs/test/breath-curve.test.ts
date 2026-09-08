import { describe, expect, it } from "vitest";
import {
  breathEnergy,
  glyphForBreath,
  ORB_SPEEDS,
  ORB_TICK_MS,
} from "../src/index.js";

describe("breathing curve", () => {
  it("samples the designed cubic-bezier breath without overshoot", () => {
    const oracle = [
      [0.00, 0.000],
      [0.05, 0.000],
      [0.10, 0.000],
      [0.15, 0.087],
      [0.20, 0.408],
      [0.25, 0.698],
      [0.30, 0.860],
      [0.35, 0.946],
      [0.40, 0.988],
      [0.45, 1.000],
      [0.50, 1.000],
      [0.55, 0.979],
      [0.60, 0.918],
      [0.65, 0.820],
      [0.70, 0.691],
      [0.75, 0.541],
      [0.80, 0.384],
      [0.85, 0.235],
      [0.90, 0.112],
      [0.95, 0.029],
      [1.00, 0.000],
    ] as const;

    for (const [phase, expected] of oracle) {
      const actual = breathEnergy(phase * ORB_SPEEDS.normal, ORB_SPEEDS.normal);
      expect(actual).toBeGreaterThanOrEqual(0);
      expect(actual).toBeLessThanOrEqual(1);
      expect(actual).toBeCloseTo(expected, 2);
    }
  });

  it("uses faster full cycles while sharing one 20fps sampling cadence", () => {
    expect(ORB_SPEEDS).toEqual({ slow: 2_200, normal: 1_600, fast: 1_200 });
    expect(ORB_TICK_MS).toBe(50);
  });

  it("maps energy to round one-cell Unicode and ASCII glyphs", () => {
    expect(glyphForBreath(0.1, "unicode")).toBe("·");
    expect(glyphForBreath(0.5, "unicode")).toBe("•");
    expect(glyphForBreath(0.9, "unicode")).toBe("●");
    expect(glyphForBreath(0.1, "ascii")).toBe(".");
    expect(glyphForBreath(0.5, "ascii")).toBe("o");
    expect(glyphForBreath(0.9, "ascii")).toBe("O");
  });
});
