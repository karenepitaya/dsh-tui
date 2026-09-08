import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_STATUS_KINDS,
  AgentStatus,
  MotionHost,
  ORB_SPEEDS,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentStatus", () => {
  it("contains status lines only, never peer roles or response content", () => {
    expect(AGENT_STATUS_KINDS).toEqual(["loading", "thinking", "tool"]);
  });

  it("renders an active one-cell Orb followed by an aligned semantic label", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
      now: () => now,
    });
    const status = new AgentStatus(host, {
      kind: "thinking",
      detail: "Planning the next step…",
    });

    expect(status.render(80)).toEqual(["· Thinking  Planning the next step…"]);
    now = ORB_SPEEDS.normal * 0.3;
    expect(status.render(80)[0]).toMatch(/^● Thinking {2}/u);
    expect(vi.getTimerCount()).toBe(1);

    status.dispose();
    host.dispose();
  });

  it("uses stable, non-animated completion and error prefixes", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const status = new AgentStatus(host, {
      kind: "tool",
      phase: "complete",
      detail: "read README.md · 84 ms",
      theme: "github",
    });

    expect(stripTerminalSequences(status.render(80)[0] ?? "")).toBe(
      "✓ Tool Call read README.md · 84 ms",
    );
    expect(vi.getTimerCount()).toBe(0);

    status.setPhase("error");
    expect(stripTerminalSequences(status.render(80)[0] ?? "")).toBe(
      "! Tool Call read README.md · 84 ms",
    );
    expect(status.render(80).join("")).toContain("\x1b[38;2;248;81;73m");
  });

  it.each(["loading", "thinking", "tool"] as const)(
    "uses an unambiguous success mark when %s completes",
    (kind) => {
      const unicodeHost = new MotionHost(() => {}, {
        motion: "reduced",
        glyphs: "unicode",
        color: "never",
        isTTY: true,
      });
      const asciiHost = new MotionHost(() => {}, {
        motion: "reduced",
        glyphs: "ascii",
        color: "never",
        isTTY: true,
      });

      expect(new AgentStatus(unicodeHost, { kind, phase: "complete" }).render(80)[0])
        .toMatch(/^✓ /u);
      expect(new AgentStatus(asciiHost, { kind, phase: "complete" }).render(80)[0])
        .toMatch(/^\+ /u);
    },
  );

  it("remains understandable without color and respects narrow widths", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "ascii",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
    });
    const status = new AgentStatus(host, {
      kind: "loading",
      phase: "complete",
      detail: "Done",
    });

    expect(status.render(80)).toEqual(["+ Loading   Done"]);
    for (let width = 0; width <= 14; width += 1) {
      const line = status.render(width)[0] ?? "";
      expect(line).not.toContain("\x1b");
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("wraps long agent payloads underneath the fixed inline prefix", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const status = new AgentStatus(host, {
      kind: "thinking",
      detail: "运行 pnpm run verify，它会依次执行类型检查、测试和构建。",
    });

    const lines = status.render(28);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^• Thinking {2}/u);
    expect(lines[1]?.startsWith(" ".repeat(12))).toBe(true);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
  });
});
