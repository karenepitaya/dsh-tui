import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  EFFORT_METER_COMPACT_WIDTH,
  EFFORT_METER_FULL_WIDTH,
  EffortMeter,
  MODEL_EFFORTS,
  type ModelEffort,
} from "../src/effort-meter.js";
import { MotionHost } from "../src/motion-host.js";
import { ORB_THEMES } from "../src/themes.js";

const UNICODE_METERS: Readonly<Record<ModelEffort, string>> = Object.freeze({
  low: "[━───]",
  medium: "[━━──]",
  high: "[━━━─]",
  xhigh: "[━━━━]",
});

const ASCII_METERS: Readonly<Record<ModelEffort, string>> = Object.freeze({
  low: "[=---]",
  medium: "[==--]",
  high: "[===-]",
  xhigh: "[====]",
});

describe("EffortMeter", () => {
  it.each([
    ["unicode", UNICODE_METERS],
    ["ascii", ASCII_METERS],
  ] as const)("renders an unambiguous framed horizontal %s meter", (glyphs, expected) => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs,
      color: "never",
      isTTY: true,
    });

    for (const effort of MODEL_EFFORTS) {
      const meter = new EffortMeter(host, { effort });
      expect(meter.render(EFFORT_METER_COMPACT_WIDTH)).toEqual([expected[effort]]);
    }

    host.dispose();
  });

  it("adds the effort label only in its fixed full-width tier", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    for (const effort of MODEL_EFFORTS) {
      const meter = new EffortMeter(host, { effort });
      expect(meter.render(EFFORT_METER_COMPACT_WIDTH)).toEqual([UNICODE_METERS[effort]]);
      expect(meter.render(EFFORT_METER_FULL_WIDTH - 1)).toEqual([UNICODE_METERS[effort]]);
      expect(meter.render(EFFORT_METER_FULL_WIDTH))
        .toEqual([`${UNICODE_METERS[effort]} ${effort}`]);
    }

    host.dispose();
  });

  it("never exceeds the viewport and keeps a closing frame whenever two cells fit", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const meter = new EffortMeter(host, { effort: "xhigh" });

    expect(meter.render(0)).toEqual([""]);
    for (let width = 1; width <= EFFORT_METER_FULL_WIDTH; width += 1) {
      const line = meter.render(width)[0] ?? "";
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 2 && width < EFFORT_METER_FULL_WIDTH) {
        expect(line).toMatch(/^\[.*\]$/u);
      }
    }

    host.dispose();
  });

  it("styles the frame, active level, empty track, and label without changing geometry", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const meter = new EffortMeter(host, { effort: "medium", theme: "github" });
    const compact = meter.render(EFFORT_METER_COMPACT_WIDTH)[0] ?? "";
    const full = meter.render(EFFORT_METER_FULL_WIDTH)[0] ?? "";

    expect(stripTerminalSequences(compact)).toBe("[━━──]");
    expect(stripTerminalSequences(full)).toBe("[━━──] medium");
    expect(compact).toContain(hexSequence(ORB_THEMES.github.muted));
    expect(compact).toContain(hexSequence(ORB_THEMES.github.medium));
    expect(compact).toContain(hexSequence(ORB_THEMES.github.low));
    expect(visibleWidth(full)).toBe(13);

    host.dispose();
  });

  it("updates effort and theme with one render request per real change", () => {
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "reduced",
      glyphs: "ascii",
      color: "always",
      isTTY: true,
    });
    const meter = new EffortMeter(host, { effort: "low", theme: "openai" });

    meter.setEffort("xhigh");
    expect(meter.effort).toBe("xhigh");
    expect(requestRender).toHaveBeenCalledTimes(1);
    meter.setEffort("xhigh");
    expect(requestRender).toHaveBeenCalledTimes(1);

    meter.setTheme("clay");
    expect(meter.theme).toBe("clay");
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(stripTerminalSequences(meter.render(EFFORT_METER_FULL_WIDTH)[0] ?? ""))
      .toBe("[====] xhigh");

    host.dispose();
  });

  it("rejects unknown runtime effort values without changing the meter", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    const meter = new EffortMeter(host, { effort: "low" });

    expect(() => meter.setEffort("maximum" as ModelEffort)).toThrow(RangeError);
    expect(meter.effort).toBe("low");
    expect(() => new EffortMeter(host, { effort: "maximum" as ModelEffort })).toThrow(RangeError);

    host.dispose();
  });
});

function hexSequence(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}
