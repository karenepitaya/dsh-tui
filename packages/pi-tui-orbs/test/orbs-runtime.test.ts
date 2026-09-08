import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatus } from "../src/agent-status.js";
import { AgentRequestStatus } from "../src/agent-request-status.js";
import { AnimatedFrames } from "../src/animated-frames.js";
import { EffortMeter } from "../src/effort-meter.js";
import { ExecutionStatus } from "../src/execution-status.js";
import { GradientBar } from "../src/gradient-bar.js";
import { ChoiceControl, ControlPanel, SliderControl, ToggleControl } from "../src/lab-controls.js";
import { MotionHost } from "../src/motion-host.js";
import { ModelStatusline } from "../src/model-statusline.js";
import { Orb } from "../src/orb.js";
import { createOrbsRuntime, OrbsRuntime } from "../src/orbs-runtime.js";
import { ShimmerText } from "../src/shimmer-text.js";
import { StreamingText } from "../src/streaming-text.js";
import { ORB_THEMES } from "../src/themes.js";
import { TodoList } from "../src/todo-list.js";

afterEach(() => {
  vi.useRealTimers();
});

function foregroundSequence(hex: string): string {
  return `\x1b[38;2;${Number.parseInt(hex.slice(1, 3), 16)};${
    Number.parseInt(hex.slice(3, 5), 16)
  };${Number.parseInt(hex.slice(5, 7), 16)}m`;
}

describe("OrbsRuntime", () => {
  it("resolves one host and injects theme, glyph, and color defaults", () => {
    const requestRender = vi.fn();
    const runtime = createOrbsRuntime({
      requestRender,
      theme: "claude",
      motion: "full",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });

    expect(runtime).toBeInstanceOf(OrbsRuntime);
    expect(runtime.host).toBeInstanceOf(MotionHost);
    expect(runtime.host.motion).toBe("full");
    expect(runtime.host.glyphs).toBe("ascii");
    expect(runtime.host.color).toBe("never");
    expect(runtime.theme).toBe("claude");

    const orb = runtime.createOrb();
    const shimmer = runtime.createShimmerText();
    const gradient = runtime.createGradientBar();
    const streaming = runtime.createStreamingText();
    const status = runtime.createAgentStatus({ kind: "thinking" });
    const requestStatus = runtime.createAgentRequestStatus();
    const effort = runtime.createEffortMeter({ effort: "high" });
    expect([
      orb.theme,
      shimmer.theme,
      gradient.theme,
      streaming.theme,
      status.theme,
      requestStatus.theme,
      effort.theme,
    ]).toEqual(["claude", "claude", "claude", "claude", "claude", "claude", "claude"]);
    expect(effort.render(80)[0]).toBe("[===-] high");

    const toggle = runtime.createToggleControl({ label: "Effect", value: true, focused: true });
    expect(stripTerminalSequences(toggle.render(80)[0] ?? "")).toBe("> Effect  [x] On");
    expect(toggle.render(80)[0]).not.toContain("\x1b[");

    const customToggle = runtime.createToggleControl({
      label: "Effect",
      value: true,
      focused: true,
      glyphs: "unicode",
      color: "always",
    });
    expect(stripTerminalSequences(customToggle.render(80)[0] ?? "")).toBe("› Effect  ● On");
    expect(customToggle.render(80)[0]).toContain("\x1b[38;2;");
    runtime.dispose();
  });

  it("updates only components and controls that did not pin a theme", () => {
    const runtime = createOrbsRuntime({
      requestRender: () => {},
      theme: "openai",
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const followingOrb = runtime.createOrb();
    const pinnedOrb = runtime.createOrb({ theme: "github" });
    const followingStatusline = runtime.createModelStatusline({
      mode: "Build",
      model: "GPT-5",
      effort: "high",
      context: { used: 21, limit: 100 },
      status: { phase: "idle" },
    });
    const pinnedStatusline = runtime.createModelStatusline({
      mode: "Build",
      model: "GPT-5",
      effort: "high",
      context: { used: 21, limit: 100 },
      status: { phase: "idle" },
      theme: "github",
    });
    const followingEffort = runtime.createEffortMeter({ effort: "high" });
    const pinnedEffort = runtime.createEffortMeter({ effort: "high", theme: "github" });
    const followingRequest = runtime.createAgentRequestStatus();
    const pinnedRequest = runtime.createAgentRequestStatus({ theme: "github" });
    const followingControl = runtime.createToggleControl({
      label: "Motion",
      value: true,
      focused: true,
    });
    const pinnedControl = runtime.createToggleControl({
      label: "Motion",
      value: true,
      focused: true,
      theme: "github",
    });

    runtime.setTheme("clay");

    expect(runtime.theme).toBe("clay");
    expect(followingOrb.theme).toBe("clay");
    expect(pinnedOrb.theme).toBe("github");
    expect(followingStatusline.theme).toBe("clay");
    expect(pinnedStatusline.theme).toBe("github");
    expect(followingEffort.theme).toBe("clay");
    expect(pinnedEffort.theme).toBe("github");
    expect(followingRequest.theme).toBe("clay");
    expect(pinnedRequest.theme).toBe("github");
    expect(followingControl.render(80)[0])
      .toContain(foregroundSequence(ORB_THEMES.clay.high));
    expect(pinnedControl.render(80)[0])
      .toContain(foregroundSequence(ORB_THEMES.github.high));
    expect(pinnedControl.render(80)[0])
      .not.toContain(foregroundSequence(ORB_THEMES.clay.high));
    runtime.dispose();
  });

  it("requests a render when a global theme change only affects controls", () => {
    const requestRender = vi.fn();
    const runtime = createOrbsRuntime({
      requestRender,
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    runtime.createToggleControl({ label: "Motion", value: true });

    runtime.setTheme("github");

    expect(requestRender).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("wires control panel interactions to the runtime render request", () => {
    const requestRender = vi.fn();
    const runtime = createOrbsRuntime({
      requestRender,
      motion: "reduced",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const first = runtime.createToggleControl({ label: "Motion", value: true });
    const second = runtime.createToggleControl({ label: "Compare", value: false });
    const panel = runtime.createControlPanel([first, second]);

    panel.focusNext();

    expect(panel.focusedIndex).toBe(1);
    expect(requestRender).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("constructs every public component and the reusable control panel", () => {
    const runtime = createOrbsRuntime({
      requestRender: () => {},
      motion: "reduced",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const animated = runtime.createAnimatedFrames({
      frames: { unicode: ["◐", "◓"], ascii: ["o", "O"] },
    });
    const execution = runtime.createExecutionStatus({ label: "Build" });
    const requestStatus = runtime.createAgentRequestStatus({ description: "Prompt accepted" });
    const effort = runtime.createEffortMeter({ effort: "high" });
    const modelStatusline = runtime.createModelStatusline({
      mode: "Build",
      model: "GPT-5",
      effort: "high",
      context: { used: 21, limit: 100 },
      status: { phase: "idle" },
    });
    const todos = runtime.createTodoList({
      items: [{ title: "Inspect", state: "active" }],
    });
    const choice = runtime.createChoiceControl({
      label: "Speed",
      choices: [
        { value: "slow", label: "Slow" },
        { value: "fast", label: "Fast" },
      ],
      value: "slow",
    });
    const slider = runtime.createSliderControl({
      label: "Brightness",
      min: 0,
      max: 1,
      step: 0.1,
      value: 0.8,
    });
    const toggle = runtime.createToggleControl({ label: "Effect", value: true });
    const panel = runtime.createControlPanel([choice, slider, toggle]);

    expect(animated).toBeInstanceOf(AnimatedFrames);
    expect(execution).toBeInstanceOf(ExecutionStatus);
    expect(requestStatus).toBeInstanceOf(AgentRequestStatus);
    expect(effort).toBeInstanceOf(EffortMeter);
    expect(modelStatusline).toBeInstanceOf(ModelStatusline);
    expect(todos).toBeInstanceOf(TodoList);
    expect(choice).toBeInstanceOf(ChoiceControl);
    expect(slider).toBeInstanceOf(SliderControl);
    expect(toggle).toBeInstanceOf(ToggleControl);
    expect(panel).toBeInstanceOf(ControlPanel);
    expect(panel.controls).toEqual([choice, slider, toggle]);
    runtime.dispose();
  });

  it("shares one ticker and exposes its host for DIY components", () => {
    vi.useFakeTimers();
    const runtime = createOrbsRuntime({
      requestRender: vi.fn(),
      motion: "full",
      glyphs: "ascii",
      color: "always",
      isTTY: true,
    });
    const orb = runtime.createOrb({ autoplay: true });
    const gradient = runtime.createGradientBar({ autoplay: true });
    const diyOrb = new Orb(runtime.host, { autoplay: true });

    expect(orb.running).toBe(true);
    expect(gradient.running).toBe(true);
    expect(diyOrb.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    diyOrb.dispose();
    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can destroy an owned component early without retaining or revisiting it", () => {
    const runtime = createOrbsRuntime({
      requestRender: () => {},
      motion: "reduced",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const owned = runtime.createOrb();
    const external = new Orb(runtime.host);
    const disposeOwned = vi.spyOn(owned, "dispose");
    const setOwnedTheme = vi.spyOn(owned, "setTheme");
    const disposeExternal = vi.spyOn(external, "dispose");

    expect(runtime.destroy(external)).toBe(false);
    expect(disposeExternal).not.toHaveBeenCalled();
    expect(runtime.destroy(owned)).toBe(true);
    expect(runtime.destroy(owned)).toBe(false);
    expect(disposeOwned).toHaveBeenCalledOnce();

    runtime.setTheme("github");
    expect(setOwnedTheme).not.toHaveBeenCalled();
    runtime.dispose();
    expect(disposeOwned).toHaveBeenCalledOnce();
    external.dispose();
  });

  it("disposes every owned motion component and itself idempotently", () => {
    vi.useFakeTimers();
    const runtime = createOrbsRuntime({
      requestRender: () => {},
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
    });
    const components = [
      runtime.createAnimatedFrames({
        frames: { unicode: ["◐", "◓"], ascii: ["o", "O"] },
        autoplay: true,
      }),
      runtime.createOrb({ autoplay: true }),
      runtime.createShimmerText({ text: "Working", active: true }),
      runtime.createGradientBar({ autoplay: true }),
      runtime.createStreamingText({ text: "Reply", active: true }),
      runtime.createAgentStatus({ kind: "loading" }),
      runtime.createAgentRequestStatus(),
      runtime.createModelStatusline({
        mode: "Build",
        model: "GPT-5",
        effort: "high",
        context: { used: 21, limit: 100 },
        status: { phase: "active" },
      }),
      runtime.createExecutionStatus({ label: "Build" }),
      runtime.createTodoList({ items: [{ title: "Test", state: "active" }] }),
    ] satisfies readonly (
      | AnimatedFrames
      | Orb
      | ShimmerText
      | GradientBar
      | StreamingText
      | AgentStatus
      | AgentRequestStatus
      | ModelStatusline
      | ExecutionStatus
      | TodoList
    )[];

    expect(components.every((component) => component.running)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    runtime.dispose();
    runtime.dispose();

    expect(runtime.disposed).toBe(true);
    expect(runtime.host.disposed).toBe(true);
    expect(components.every((component) => !component.running)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => runtime.createOrb()).toThrow(/disposed/u);
    expect(() => runtime.setTheme("github")).toThrow(/disposed/u);
  });
});
