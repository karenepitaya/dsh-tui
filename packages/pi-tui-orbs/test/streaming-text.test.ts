import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MotionHost,
  SHIMMER_PERIOD_MS,
  SHIMMER_PERIODS,
  SHIMMER_TICK_MS,
  StreamingText,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamingText", () => {
  it("shimmers only the live grapheme tail and settles to plain text", () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const text = new StreamingText(host, {
      text: "Stable prefix · 正在生成尾部",
      active: true,
      tailLength: 6,
      theme: "catppuccin",
    });

    const first = text.render(80).join("\n");
    expect(stripTerminalSequences(first)).toBe("Stable prefix · 正在生成尾部");
    expect(first.startsWith("Stable prefix · ")).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    now = SHIMMER_PERIOD_MS / 4;
    const highlighted = text.render(80).join("\n");
    expect(highlighted.startsWith("Stable prefix · ")).toBe(true);
    expect(highlighted).toContain("\x1b[38;2;");

    now = SHIMMER_PERIOD_MS / 2;
    expect(text.render(80).join("\n")).not.toBe(highlighted);

    text.setActive(false);
    expect(text.render(80)).toEqual(["Stable prefix · 正在生成尾部"]);
    expect(vi.getTimerCount()).toBe(0);
    host.dispose();
  });

  it("wraps CJK by terminal width while preserving the visible text", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      color: "always",
      isTTY: true,
    });
    const text = new StreamingText(host, {
      text: "它会依次执行类型检查、测试、构建和示例构建。",
      active: true,
    });
    const lines = text.render(18);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
    expect(lines.join("")).toBe("它会依次执行类型检查、测试、构建和示例构建。");
  });

  it("does not allocate a shimmer timer when color is unavailable", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, {
      motion: "full",
      color: "auto",
      env: { NO_COLOR: "" },
      isTTY: true,
    });
    const text = new StreamingText(host, {
      text: "\x1b[31mStreaming\x1b[0m",
      active: true,
    });

    expect(text.render(80)).toEqual(["Streaming"]);
    expect(text.render(80).join("")).not.toContain("\x1b");
    expect(vi.getTimerCount()).toBe(0);
    expect(SHIMMER_TICK_MS).toBe(50);
  });

  it("keeps one continuous sweep as new response chunks arrive", () => {
    let now = 0;
    const liveHost = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const expectedHost = new MotionHost(() => {}, {
      motion: "full",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const live = new StreamingText(liveHost, {
      text: "abcdefgh",
      active: true,
      speed: "normal",
    });
    const expected = new StreamingText(expectedHost, {
      text: "abcdefghij",
      active: true,
      speed: "normal",
    });

    now = SHIMMER_PERIOD_MS / 2;
    live.append("ij");
    expect(live.render(80)).toEqual(expected.render(80));

    live.dispose();
    expected.dispose();
    liveHost.dispose();
    expectedHost.dispose();
  });

  it("offers deliberately spaced shimmer speeds without changing the ticker", () => {
    expect(SHIMMER_PERIODS).toEqual({ slow: 1_400, normal: 1_000, fast: 760 });
    expect(SHIMMER_PERIOD_MS).toBe(SHIMMER_PERIODS.normal);
  });
});
