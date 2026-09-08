import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REQUEST_PHASES,
  AGENT_REQUEST_TICK_MS,
  AgentRequestStatus,
  MotionHost,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentRequestStatus", () => {
  it("defines the complete request lifecycle without assistant-specific payload states", () => {
    expect(AGENT_REQUEST_PHASES).toEqual([
      "submitted",
      "waiting",
      "reasoning",
      "tool",
      "responding",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });

  it("starts visible motion immediately when a request is submitted", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });

    const status = new AgentRequestStatus(host, {
      description: "Prompt accepted",
    });

    expect(status.phase).toBe("submitted");
    expect(status.running).toBe(true);
    expect(status.render(80)).toEqual(["· Submitted   Prompt accepted"]);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    requestRender.mockClear();
    vi.advanceTimersByTime(AGENT_REQUEST_TICK_MS - 1);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledOnce();

    status.dispose();
    host.dispose();
  });

  it("updates active stages atomically while retaining the shared motion lease", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "full",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const status = new AgentRequestStatus(host);
    requestRender.mockClear();

    const activeStages = [
      ["waiting", "Waiting for model capacity"],
      ["reasoning", "Planning the next step"],
      ["tool", "Reading project files"],
      ["responding", "Writing the answer"],
    ] as const;
    for (const [phase, description] of activeStages) {
      status.update({ phase, description });
      expect(status.phase).toBe(phase);
      expect(status.description).toBe(description);
      expect(status.running).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    }

    expect(requestRender).toHaveBeenCalledTimes(activeStages.length);
    expect(status.render(80)).toEqual([". Responding  Writing the answer"]);

    status.dispose();
    host.dispose();
  });

  it.each([
    ["succeeded", "✓", "+", "Done"],
    ["failed", "×", "x", "Failed"],
    ["cancelled", "—", "-", "Cancelled"],
  ] as const)(
    "settles %s with a stable icon and releases motion",
    (phase, unicodeIcon, asciiIcon, label) => {
      vi.useFakeTimers();
      for (const [glyphs, icon] of [
        ["unicode", unicodeIcon],
        ["ascii", asciiIcon],
      ] as const) {
        const host = new MotionHost(() => {}, {
          motion: "full",
          glyphs,
          color: "never",
          isTTY: true,
        });
        const status = new AgentRequestStatus(host, { phase: "reasoning" });

        status.update({ phase, description: "Request finished" });

        expect(status.running).toBe(false);
        expect(status.render(80)).toEqual([`${icon} ${label.padEnd(10)}  Request finished`]);
        expect(vi.getTimerCount()).toBe(0);

        status.dispose();
        host.dispose();
      }
    },
  );

  it("sanitizes descriptions and remains a single compact line at narrow widths", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const status = new AgentRequestStatus(host, {
      phase: "tool",
      description: "\u001b[31mReading\u001b[0m\n  src/index.ts",
    });

    expect(status.description).toBe("Reading src/index.ts");
    expect(status.render(80)).toEqual(["• Working     Reading src/index.ts"]);
    for (let width = 0; width <= 24; width += 1) {
      const lines = status.render(width);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\x1b");
      expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
    }

    status.dispose();
    host.dispose();
  });

  it("uses the error token only for failed requests", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const status = new AgentRequestStatus(host, {
      phase: "succeeded",
      theme: "github",
    });

    expect(stripTerminalSequences(status.render(80)[0] ?? "")).toBe("✓ Done");
    status.setPhase("failed");
    expect(stripTerminalSequences(status.render(80)[0] ?? "")).toBe("× Failed");
    expect(status.render(80).join("")).toContain("\x1b[38;2;248;81;73m");

    status.dispose();
    host.dispose();
  });

  it("still requests the settled frame after motion was paused explicitly", () => {
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, {
      motion: "reduced",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const status = new AgentRequestStatus(host);
    status.stop();
    requestRender.mockClear();

    status.setPhase("cancelled");

    expect(requestRender).toHaveBeenCalledOnce();
    expect(status.render(80)).toEqual(["— Cancelled"]);
    status.dispose();
    host.dispose();
  });
});
