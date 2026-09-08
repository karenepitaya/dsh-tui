import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MotionHost,
  Orb,
  ORB_SPEEDS,
  ORB_THEME_NAMES,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Orb", () => {
  it("stays a round one-cell prefix with its label fixed at column three", () => {
    for (const glyphs of ["unicode", "ascii"] as const) {
      let now = 0;
      const host = new MotionHost(() => {}, {
        motion: "full",
        glyphs,
        color: "never",
        isTTY: true,
        now: () => now,
      });
      const orb = new Orb(host, { label: "Thinking", autoplay: true });

      for (const phase of [0, 0.2, 0.3, 0.7, 0.9]) {
        now = phase * ORB_SPEEDS.normal;
        const line = orb.render(80)[0] ?? "";
        expect(visibleWidth(line.slice(0, 1))).toBe(1);
        expect(line.slice(1)).toBe(" Thinking");
        if (glyphs === "ascii") expect(line[0]).toMatch(/[.oO]/u);
        else expect(line[0]).toMatch(/[·•●]/u);
      }

      orb.dispose();
      host.dispose();
    }
  });

  it("renders every theme without changing the visible prefix", () => {
    const plainHost = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const plain = new Orb(plainHost, { label: "Thinking" }).render(80);
    const colorSignatures = new Set<string>();

    for (const theme of ORB_THEME_NAMES) {
      const host = new MotionHost(() => {}, {
        motion: "reduced",
        glyphs: "unicode",
        color: "always",
        isTTY: true,
      });
      const rendered = new Orb(host, { label: "Thinking", theme }).render(80);
      expect(rendered.join("")).toContain("\x1b[38;2;");
      expect(rendered.map(stripTerminalSequences)).toEqual(plain);
      colorSignatures.add(rendered.join(""));
      host.dispose();
    }

    expect(colorSignatures.size).toBe(ORB_THEME_NAMES.length);
    plainHost.dispose();
  });

  it("preserves normalized breathing phase when speed changes", () => {
    vi.useFakeTimers();
    let now = ORB_SPEEDS.normal * 0.3;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const orb = new Orb(host, { speed: "normal" });
    orb.start();
    now += ORB_SPEEDS.normal * 0.3;

    const before = orb.render(80);
    orb.setSpeed("fast");
    expect(orb.speed).toBe("fast");
    expect(orb.render(80)).toEqual(before);
    expect(vi.getTimerCount()).toBe(1);

    now += ORB_SPEEDS.fast * 0.35;
    expect(orb.render(80)).not.toEqual(before);
    orb.dispose();
    host.dispose();
  });

  it("accepts a bounded render cadence without changing the default", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });

    expect(() => new Orb(host, { tickMs: 15 })).toThrow(/tick interval/u);
    const orb = new Orb(host, { autoplay: true, tickMs: 100 });
    expect(orb.tickMs).toBe(100);
    requestRender.mockClear();

    vi.advanceTimersByTime(99);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledOnce();

    orb.dispose();
    host.dispose();
  });

  it("suppresses theme and custom ANSI styling when color is disabled", () => {
    const styleLine = vi.fn((line: string) => `\x1b[31m${line}\x1b[39m`);
    const styleLabel = vi.fn((label: string) => `\x1b[32m${label}\x1b[39m`);
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "ascii",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
    });
    const orb = new Orb(host, { label: "Thinking", styleLine, styleLabel });
    const rendered = orb.render(80).join("");
    expect(rendered).not.toContain("\x1b");
    expect(styleLine).not.toHaveBeenCalled();
    expect(styleLabel).not.toHaveBeenCalled();
  });

  it("sanitizes labels, switches themes, and never exceeds narrow widths", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const orb = new Orb(host, {
      label: "\x1b[31mThinking\nnow\x1b[0m",
      theme: "catppuccin",
    });
    expect(orb.label).toBe("Thinking now");
    orb.setTheme("clay");
    expect(orb.theme).toBe("clay");

    for (let width = 0; width <= 12; width += 1) {
      expect(visibleWidth(orb.render(width)[0] ?? "")).toBeLessThanOrEqual(width);
    }
  });
});
