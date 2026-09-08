import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_EFFORTS,
  MODEL_STATUS_PHASES,
  ModelStatusline,
  type ModelEffort,
  type ModelStatusPhase,
} from "../src/model-statusline.js";
import { MotionHost } from "../src/motion-host.js";
import { ORB_SPEEDS } from "../src/presets/orbs.js";
import { ORB_THEMES } from "../src/themes.js";

afterEach(() => {
  vi.useRealTimers();
});

function createPlainStatusline(
  overrides: Partial<ConstructorParameters<typeof ModelStatusline>[1]> = {},
): { host: MotionHost; statusline: ModelStatusline } {
  const host = new MotionHost(() => {}, {
    motion: "reduced",
    glyphs: "unicode",
    color: "never",
    isTTY: true,
  });
  const statusline = new ModelStatusline(host, {
    mode: "Build",
    model: "GPT-5.6",
    effort: "high",
    context: { used: 42_000, limit: 100_000 },
    status: { phase: "complete", label: "Done" },
    ...overrides,
  });
  return { host, statusline };
}

describe("ModelStatusline", () => {
  it("publishes the intentionally small effort and phase vocabularies", () => {
    expect(MODEL_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(MODEL_STATUS_PHASES).toEqual(["idle", "active", "complete", "error"]);
  });

  it("renders all five slots on one full-width, right-aligned line", () => {
    const { host, statusline } = createPlainStatusline();
    const line = statusline.render(80)[0] ?? "";

    expect(line).toMatch(/^Build · GPT-5\.6 · \[━━━─\] high/u);
    expect(line).toMatch(/ctx ━━━───\s+42k\/100k\s+42% · ✓ Done$/u);
    expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(statusline.render(80)).toHaveLength(1);

    statusline.dispose();
    host.dispose();
  });

  it("progressively compacts context, effort, status, and model", () => {
    const { host, statusline } = createPlainStatusline();
    const full = statusline.render(80)[0] ?? "";
    const compact = statusline.render(50)[0] ?? "";
    const tiny = statusline.render(20)[0] ?? "";

    expect(full).toContain("42k/100k");
    expect(full).toContain("[━━━─] high");
    expect(full).toContain("✓ Done");
    expect(compact).not.toContain("42k/100k");
    expect(compact).toMatch(/ · \[━━━─\]\s/u);
    expect(compact).not.toContain("Done");
    expect(tiny).toContain("GPT-5.6");
    expect(tiny).not.toContain("Build");
    expect(tiny).not.toContain(" high");
    expect(tiny).toMatch(/GPT-5\.6\s+· 42%/u);
    expect(tiny).toMatch(/42% · ✓$/u);
    for (const [width, line] of [[50, compact], [20, tiny]] as const) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }

    statusline.dispose();
    host.dispose();
  });

  it.each([80, 50])(
    "keeps its responsive tier and ctx/status anchors stable at %i columns",
    (width) => {
      const { host, statusline } = createPlainStatusline({
        context: { used: 9, limit: 100 },
        status: { phase: "idle", label: "Ready" },
      });
      let ctxAnchor: number | undefined;
      let statusAnchor: number | undefined;
      const samples = [
        { context: { used: 9, limit: 100 }, status: { phase: "idle", label: "Ready" } },
        { context: { used: 70, limit: 100 }, status: { phase: "active", label: "Thinking" } },
        { context: { used: 99, limit: 100 }, status: { phase: "complete", label: "Done" } },
        {
          context: { used: 200, limit: 100 },
          status: { phase: "error", label: "An unexpectedly long failure label" },
        },
      ] as const;

      for (const sample of samples) {
        statusline.update(sample);
        const line = statusline.render(width)[0] ?? "";
        const nextCtxAnchor = line.indexOf("ctx");
        const nextStatusAnchor = statusGlyphIndex(line);
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(nextCtxAnchor).toBeGreaterThanOrEqual(0);
        expect(nextStatusAnchor).toBeGreaterThan(nextCtxAnchor);
        ctxAnchor ??= nextCtxAnchor;
        statusAnchor ??= nextStatusAnchor;
        expect(nextCtxAnchor).toBe(ctxAnchor);
        expect(nextStatusAnchor).toBe(statusAnchor);

        if (width >= 72) {
          expect(line).toContain("[━━━─] high");
          expect(line).toContain(`${sample.context.used}/${sample.context.limit}`);
        } else {
          expect(line).toMatch(/ · \[━━━─\]\s/u);
          expect(line).not.toContain("Thinking");
          expect(line).not.toContain("Done");
        }
      }

      statusline.dispose();
      host.dispose();
    },
  );

  it.each([20, 40, 80, 120])("never exceeds a %i-column viewport", (width) => {
    const { host, statusline } = createPlainStatusline({
      mode: "Analyze a very long request",
      model: "供应商/GPT-5.6-super-long-model-name",
      status: { phase: "error", label: "A very long failure explanation" },
    });
    const lines = statusline.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
    statusline.dispose();
    host.dispose();
  });

  it("returns one empty line at zero width and stays safe at every tiny width", () => {
    const { host, statusline } = createPlainStatusline();
    expect(statusline.render(0)).toEqual([""]);
    for (let width = 1; width <= 19; width += 1) {
      const lines = statusline.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
    }
    statusline.dispose();
    host.dispose();
  });

  it("keeps the framed horizontal effort meter in full and compact tiers", () => {
    const expected = {
      unicode: { low: "[━───]", medium: "[━━──]", high: "[━━━─]", xhigh: "[━━━━]" },
      ascii: { low: "[=---]", medium: "[==--]", high: "[===-]", xhigh: "[====]" },
    } as const;
    for (const effort of MODEL_EFFORTS) {
      for (const glyphs of ["unicode", "ascii"] as const) {
        const host = new MotionHost(() => {}, {
          motion: "reduced",
          glyphs,
          color: "never",
          isTTY: true,
        });
        const statusline = new ModelStatusline(host, {
          mode: "Build",
          model: "GPT",
          effort,
          context: { used: 1, limit: 2 },
          status: { phase: "idle" },
        });
        const full = statusline.render(120)[0] ?? "";
        const compact = statusline.render(50)[0] ?? "";
        expect(full).toContain(`${expected[glyphs][effort]} ${effort}`);
        expect(compact).toContain(` · ${expected[glyphs][effort]}`);
        expect(compact).not.toContain(`] ${effort}`);
        statusline.dispose();
        host.dispose();
      }
    }
  });

  it("uses distinct idle, active, complete, and error status marks", () => {
    const expected: Readonly<Record<ModelStatusPhase, RegExp>> = {
      idle: /○ Idle$/u,
      active: /• Working$/u,
      complete: /✓ Done$/u,
      error: /! Error$/u,
    };
    for (const phase of MODEL_STATUS_PHASES) {
      const { host, statusline } = createPlainStatusline({ status: { phase } });
      expect((statusline.render(120)[0] ?? "").trimEnd()).toMatch(expected[phase]);
      expect(statusline.running).toBe(phase === "active");
      statusline.dispose();
      host.dispose();
    }
  });

  it("renders determinate six-cell context thresholds and keeps over-limit percentage truthful", () => {
    const { host, statusline } = createPlainStatusline({
      context: { used: 0, limit: 100 },
    });
    expect(statusline.render(120)[0]).toMatch(/ctx ──────\s+0\/100\s+0%/u);

    statusline.update({ context: { used: 50, limit: 100 } });
    expect(statusline.render(120)[0]).toMatch(/ctx ━━━───\s+50\/100\s+50%/u);

    statusline.update({ context: { used: 200, limit: 100 } });
    expect(statusline.render(120)[0]).toMatch(/ctx ━━━━━━\s+200\/100\s+200%/u);

    statusline.dispose();
    host.dispose();
  });

  it("changes context color at warning and critical thresholds", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "GPT",
      effort: "medium",
      context: { used: 69, limit: 100 },
      status: { phase: "idle" },
      theme: "github",
    });
    const normal = statusline.render(120).join("");
    statusline.update({ context: { used: 70, limit: 100 } });
    const warning = statusline.render(120).join("");
    statusline.update({ context: { used: 90, limit: 100 } });
    const critical = statusline.render(120).join("");

    expect(normal).toContain(hexSequence(ORB_THEMES.github.high));
    expect(warning).toContain(hexSequence(ORB_THEMES.github.core));
    expect(critical).toContain(hexSequence(ORB_THEMES.github.error));

    statusline.dispose();
    host.dispose();
  });

  it("validates context atomically while allowing used to exceed limit", () => {
    const { host, statusline } = createPlainStatusline();
    expect(() => statusline.update({ context: { used: -1, limit: 10 } })).toThrow(RangeError);
    expect(() => statusline.update({ context: { used: 1, limit: 0 } })).toThrow(RangeError);
    expect(() => statusline.update({ context: { used: Number.NaN, limit: 10 } })).toThrow(RangeError);
    expect(() => statusline.update({ context: { used: 1, limit: Number.POSITIVE_INFINITY } }))
      .toThrow(RangeError);
    expect(statusline.context).toEqual({ used: 42_000, limit: 100_000 });
    expect(() => statusline.update({ context: { used: 11, limit: 10 } })).not.toThrow();
    statusline.dispose();
    host.dispose();
  });

  it("shares one host ticker and starts or stops its Orb with active phase", () => {
    vi.useFakeTimers();
    let now = 0;
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
      now: () => now,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "GPT",
      effort: "high",
      context: { used: 1, limit: 2 },
      status: { phase: "active" },
    });

    expect(statusline.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(statusline.render(120)[0]?.trimEnd()).toMatch(/· Working$/u);
    now = ORB_SPEEDS.normal * 0.3;
    expect(statusline.render(120)[0]?.trimEnd()).toMatch(/● Working$/u);

    requestRender.mockClear();
    statusline.update({ status: { phase: "complete" } });
    expect(statusline.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(requestRender).toHaveBeenCalledTimes(1);

    requestRender.mockClear();
    statusline.update({ status: { phase: "active", label: "Thinking" } });
    expect(statusline.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(1);

    statusline.dispose();
    host.dispose();
  });

  it("coalesces a multi-field update into one render request and ignores no-ops", () => {
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "GPT",
      effort: "low",
      context: { used: 1, limit: 10 },
      status: { phase: "idle" },
    });

    statusline.update({
      mode: "Analyze",
      model: "GPT-5.6",
      effort: "xhigh",
      context: { used: 2, limit: 10 },
      status: { phase: "complete", label: "Ready" },
    });
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(statusline.snapshot).toEqual({
      mode: "Analyze",
      model: "GPT-5.6",
      effort: "xhigh",
      context: { used: 2, limit: 10 },
      status: { phase: "complete", label: "Ready" },
    });

    requestRender.mockClear();
    statusline.update({
      mode: "Analyze",
      context: { used: 2, limit: 10 },
      status: { phase: "complete", label: "Ready" },
    });
    expect(requestRender).not.toHaveBeenCalled();

    statusline.dispose();
    host.dispose();
  });

  it("switches theme and speed without changing visible content", () => {
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "GPT",
      effort: "xhigh",
      context: { used: 2, limit: 10 },
      status: { phase: "complete" },
      theme: "catppuccin",
      speed: "slow",
    });
    const before = statusline.render(120)[0] ?? "";

    requestRender.mockClear();
    statusline.setTheme("clay");
    statusline.setSpeed("fast");
    const after = statusline.render(120)[0] ?? "";
    expect(statusline.theme).toBe("clay");
    expect(statusline.speed).toBe("fast");
    expect(stripTerminalSequences(after)).toBe(stripTerminalSequences(before));
    expect(after).toContain(hexSequence(ORB_THEMES.clay.core));
    expect(requestRender).toHaveBeenCalledTimes(2);

    statusline.dispose();
    host.dispose();
  });

  it("sanitizes ANSI and controls while preserving CJK display width", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "\x1b[31m构建\n模式\x1b[0m",
      model: "\x1b[32m模型-超长中文名称\x1b[0m",
      effort: "medium",
      context: { used: 12, limit: 100 },
      status: { phase: "idle", label: "\x1b[35m等待\t输入\x1b[0m" },
    });

    expect(statusline.mode).toBe("构建 模式");
    expect(statusline.model).toBe("模型-超长中文名称");
    expect(statusline.status).toEqual({ phase: "idle", label: "等待 输入" });
    for (const width of [12, 20, 40, 80]) {
      const line = statusline.render(width)[0] ?? "";
      expect(line).not.toContain("\x1b");
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }

    statusline.dispose();
    host.dispose();
  });

  it("uses ASCII progress, effort, and status glyphs with color disabled", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "GPT",
      effort: "xhigh",
      context: { used: 50, limit: 100 },
      status: { phase: "complete" },
    });
    const line = statusline.render(120)[0] ?? "";
    expect(line).toContain("[====] xhigh");
    expect(line).toMatch(/ctx ===---\s+50\/100\s+50%/u);
    expect(line.trimEnd()).toMatch(/\+ Done$/u);
    expect(line).not.toContain("\x1b");
    statusline.dispose();
    host.dispose();
  });

  it("returns defensive snapshot copies and disposes idempotently", () => {
    const { host, statusline } = createPlainStatusline({ status: { phase: "active" } });
    const snapshot = statusline.snapshot;
    (snapshot.context as { used: number }).used = 0;
    expect(statusline.context.used).toBe(42_000);

    statusline.dispose();
    statusline.dispose();
    expect(statusline.running).toBe(false);
    expect(() => statusline.start()).toThrow("Motion component has been disposed.");
    host.dispose();
  });
});

function hexSequence(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function statusGlyphIndex(line: string): number {
  return Math.max(...["○", "•", "●", "✓", "!", ".", "+"]
    .map((glyph) => line.lastIndexOf(glyph)));
}
