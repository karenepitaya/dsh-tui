import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRequestRuntime,
  AgentRequestStatus,
  createAgentRequestRuntime,
  MotionHost,
} from "../src/agent-request.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentRequestRuntime", () => {
  it("offers a narrow runtime with one shared motion host", () => {
    vi.useFakeTimers();
    const runtime = createAgentRequestRuntime({
      requestRender: vi.fn(),
      theme: "claude",
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });

    expect(runtime).toBeInstanceOf(AgentRequestRuntime);
    expect(runtime.host).toBeInstanceOf(MotionHost);
    const first = runtime.createAgentRequestStatus({ description: "First prompt" });
    const second = runtime.createAgentRequestStatus({
      phase: "succeeded",
      description: "Earlier prompt",
    });
    expect(first).toBeInstanceOf(AgentRequestStatus);
    expect(first.theme).toBe("claude");
    expect(second.theme).toBe("claude");
    expect(vi.getTimerCount()).toBe(1);

    first.setPhase("succeeded");
    expect(vi.getTimerCount()).toBe(0);
    runtime.dispose();
  });

  it("updates inherited themes, preserves pinned themes, and owns disposal", () => {
    vi.useFakeTimers();
    const runtime = createAgentRequestRuntime({
      requestRender: () => {},
      theme: "openai",
      motion: "full",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const following = runtime.createAgentRequestStatus();
    const pinned = runtime.createAgentRequestStatus({ theme: "github" });

    runtime.setTheme("clay");
    expect(following.theme).toBe("clay");
    expect(pinned.theme).toBe("github");
    expect(runtime.destroy(following)).toBe(true);
    expect(runtime.destroy(following)).toBe(false);
    expect(following.running).toBe(false);
    expect(pinned.running).toBe(true);

    runtime.dispose();
    runtime.dispose();
    expect(runtime.disposed).toBe(true);
    expect(runtime.host.disposed).toBe(true);
    expect(pinned.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => runtime.createAgentRequestStatus()).toThrow(/disposed/u);
  });
});
