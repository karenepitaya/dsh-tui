import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionHost, TodoList } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TodoList", () => {
  it("preserves the accepted checkbox visual as a public component", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const todos = new TodoList(host, {
      items: [
        { title: "Inspect API", state: "complete" },
        { title: "Build preview", state: "active" },
        { title: "Verify output", state: "pending" },
      ],
    });

    expect(todos.render(80).map(stripTerminalSequences)).toEqual([
      "Todos · 1/3",
      "  [✓] Complete Inspect API",
      "  [·] Active   Build preview",
      "  [□] Pending  Verify output",
    ]);
    expect(vi.getTimerCount()).toBe(1);

    todos.setItems([
      { title: "Inspect API", state: "complete" },
      { title: "Build preview", state: "complete" },
      { title: "Verify output", state: "complete" },
    ]);
    expect(todos.render(80)[0]).toBe("Todos · 3/3");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects ambiguous lists with more than one active item", () => {
    const host = new MotionHost(() => {}, { motion: "reduced" });
    expect(() => new TodoList(host, {
      items: [
        { title: "First", state: "active" },
        { title: "Second", state: "active" },
      ],
    })).toThrow(RangeError);
  });

  it("remains readable in ASCII, without color, and at narrow widths", () => {
    const host = new MotionHost(() => {}, {
      motion: "reduced",
      glyphs: "ascii",
      color: "never",
      isTTY: true,
    });
    const todos = new TodoList(host, {
      items: [{ title: "Verify terminal width", state: "pending" }],
    });

    expect(todos.render(80)).toEqual([
      "Todos · 0/1",
      "  [ ] Pending  Verify terminal width",
    ]);
    for (const line of todos.render(14)) expect(visibleWidth(line)).toBeLessThanOrEqual(14);
  });
});
