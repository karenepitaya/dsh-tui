import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionStatus, MotionHost } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionStatus", () => {
  it("composes command metadata with an interruptible gradient bar", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const status = new ExecutionStatus(host, {
      label: "Build",
      detail: "pi-tui-orbs · high",
      interruptible: true,
      cells: 8,
      theme: "github",
    });

    const active = status.render(80).map(stripTerminalSequences);
    expect(active).toEqual([
      "Build · pi-tui-orbs · high",
      `  · ${"▄".repeat(8)} · esc interrupt`,
    ]);
    expect(vi.getTimerCount()).toBe(1);

    now = 8_600;
    status.setPhase("complete");
    expect(status.render(80).map(stripTerminalSequences)).toEqual([
      "✓ Build · pi-tui-orbs · high · 8.6 s",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes error and cancellation without relying on color", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const status = new ExecutionStatus(host, {
      label: "Build",
      detail: "preview",
      phase: "error",
      elapsedMs: 1_250,
    });

    expect(status.render(80)).toEqual(["× Build · preview · error · 1.3 s"]);
    status.setPhase("cancelled");
    expect(status.render(80)).toEqual(["— Build · preview · cancelled · 1.3 s"]);
  });

  it("shrinks the track before hiding the interrupt hint on narrow terminals", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const status = new ExecutionStatus(host, {
      label: "Build",
      detail: "A deliberately long execution detail",
      interruptible: true,
      cells: 8,
    });

    for (let width = 1; width <= 24; width += 1) {
      for (const line of status.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(status.render(12).join("\n")).not.toContain("esc interrupt");
  });
});
