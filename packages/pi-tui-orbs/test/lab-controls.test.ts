import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ChoiceControl,
  ControlPanel,
  SliderControl,
  ToggleControl,
  type ControlAdjustment,
  type LabControl,
  type LabControlColor,
  type LabControlGlyphs,
  type LabControlOptions,
  type ControlPanelOptions,
} from "../src/lab-controls.js";
import { ORB_THEMES, type OrbTheme, type OrbThemeName } from "../src/themes.js";

class CustomControl implements LabControl {
  focused = false;
  theme: OrbThemeName | OrbTheme = "openai";
  glyphs: LabControlGlyphs = "unicode";
  color: LabControlColor = "always";
  adjustment: ControlAdjustment | undefined;
  activations = 0;

  invalidate(): void {}

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  setTheme(theme: OrbThemeName | OrbTheme): void {
    this.theme = theme;
  }

  setGlyphs(glyphs: LabControlGlyphs): void {
    this.glyphs = glyphs;
  }

  setColor(color: LabControlColor): void {
    this.color = color;
  }

  adjust(direction: ControlAdjustment): void {
    this.adjustment = direction;
  }

  activate(): void {
    this.activations += 1;
  }

  render(width: number): string[] {
    return ["custom".slice(0, Math.max(0, width))];
  }
}

describe("lab control public shape", () => {
  it("exports shared construction options without exposing panel layout internals", () => {
    expectTypeOf<LabControlOptions>().toMatchTypeOf<{
      readonly label: string;
      readonly focused?: boolean;
    }>();
    expectTypeOf<"labelWidth" extends keyof LabControl ? true : false>()
      .toEqualTypeOf<false>();
    expectTypeOf<"setLabelWidth" extends keyof LabControl ? true : false>()
      .toEqualTypeOf<false>();
    expectTypeOf<ControlPanelOptions>().toMatchTypeOf<{
      readonly requestRender?: () => void;
    }>();
  });
});

describe("ChoiceControl", () => {
  it("provides label-free select and segmented surfaces without changing value semantics", () => {
    const choices = [{ value: "a", label: "自动" }, { value: "b", label: "深色" }];
    const select = new ChoiceControl({ label: "主题", choices, value: "b", valueOnly: true, appearance: "select", color: "never" });
    expect(select.render(30)[0]).toMatch(/^  深色\s+▾ $/u);
    expect(visibleWidth(select.render(30)[0]!)).toBe(30);
    select.adjust(1);
    expect(select.value).toBe("a");
    const segmented = new ChoiceControl({ label: "主题", choices, value: "b", valueOnly: true, appearance: "segmented", color: "never" });
    expect(segmented.render(30)[0]).toContain("▸ 深色");
    expect(segmented.render(12)[0]).toMatch(/深色\s+▾/u);
  });
  it("renders a compact themed radio row and cycles in both directions", () => {
    const onChange = vi.fn();
    const control = new ChoiceControl({
      label: "Loop",
      choices: [
        { value: "wrap", label: "Wrap" },
        { value: "ping-pong", label: "Ping" },
        { value: "once", label: "Once" },
      ],
      value: "wrap",
      focused: true,
      theme: "github",
      glyphs: "unicode",
      onChange,
    });

    const rendered = control.render(80)[0] ?? "";
    expect(stripTerminalSequences(rendered)).toBe("› Loop  ● Wrap  ○ Ping  ○ Once");
    expect(rendered).toContain("\x1b[38;2;");

    control.adjust(-1);
    expect(control.value).toBe("once");
    expect(onChange).toHaveBeenLastCalledWith("once");
    control.adjust(1);
    expect(control.value).toBe("wrap");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("supports ASCII glyphs and theme palettes without changing interaction", () => {
    const control = new ChoiceControl({
      label: "Curve",
      choices: [
        { value: "linear", label: "Linear" },
        { value: "soft", label: "Soft" },
      ],
      value: "soft",
      focused: true,
      theme: ORB_THEMES.clay,
      glyphs: "ascii",
    });

    expect(stripTerminalSequences(control.render(80)[0] ?? ""))
      .toBe("> Curve  ( ) Linear  (*) Soft");
    control.setTheme("catppuccin");
    control.setGlyphs("unicode");
    expect(stripTerminalSequences(control.render(80)[0] ?? ""))
      .toBe("› Curve  ○ Linear  ● Soft");
  });
});

describe("SliderControl", () => {
  it("renders a fixed short track, formats values, and clamps step changes", () => {
    const onChange = vi.fn();
    const control = new SliderControl({
      label: "Speed",
      min: 8,
      max: 20,
      step: 2,
      value: 14,
      focused: true,
      theme: "openai",
      glyphs: "unicode",
      formatValue: (value) => `${value} cells/s`,
      onChange,
    });

    expect(stripTerminalSequences(control.render(80)[0] ?? ""))
      .toBe("› Speed  ━━━━●───  14 cells/s");
    control.adjust(1);
    expect(control.value).toBe(16);
    expect(onChange).toHaveBeenLastCalledWith(16);
    control.adjust(1);
    control.adjust(1);
    control.adjust(1);
    expect(control.value).toBe(20);
    expect(stripTerminalSequences(control.render(80)[0] ?? ""))
      .toContain("━━━━━━━●  20 cells/s");
  });

  it("uses an equally wide ASCII track", () => {
    const control = new SliderControl({
      label: "Trail",
      min: 2,
      max: 32,
      step: 1,
      value: 2,
      glyphs: "ascii",
    });
    const line = stripTerminalSequences(control.render(80)[0] ?? "");
    expect(line).toBe("  Trail  |-------  2");
    expect(visibleWidth(line.slice(line.indexOf("|") , line.indexOf("|") + 8))).toBe(8);
  });
});

describe("ToggleControl", () => {
  it.each([false, true])("uses the emphasis token for a focused standalone switch when value is %s", (value) => {
    const spans: { text: string; token: string }[] = [];
    const toggle = new ToggleControl({ label: "动画", value, focused: true, valueOnly: true, appearance: "switch", color: "never", paint: (text, token) => { spans.push({ text, token }); return text; } });
    toggle.render(30);
    expect(spans.find((span) => span.text.includes("■"))?.token).toBe("high");
  });
  it("renders a standalone switch with injectable palette while preserving toggle behavior", () => {
    const tokens: string[] = [];
    const toggle = new ToggleControl({ label: "动画", value: false, valueOnly: true, appearance: "switch", onLabel: "开启", offLabel: "关闭", paint: (text, token) => { tokens.push(token); return text; } });
    expect(toggle.render(30)).toEqual(["■── 关闭"]);
    toggle.activate();
    expect(toggle.render(30)).toEqual(["━━■ 开启"]);
    expect(tokens).toContain("high");
  });
  it("uses arrows as explicit off/on choices and activation as a toggle", () => {
    const onChange = vi.fn();
    const control = new ToggleControl({
      label: "Motion",
      value: false,
      focused: true,
      glyphs: "unicode",
      onChange,
    });

    expect(stripTerminalSequences(control.render(80)[0] ?? "")).toBe("› Motion  ○ Off");
    control.adjust(-1);
    expect(control.value).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    control.adjust(1);
    expect(control.value).toBe(true);
    expect(stripTerminalSequences(control.render(80)[0] ?? "")).toBe("› Motion  ● On");
    control.adjust(-1);
    expect(control.value).toBe(false);
    control.activate();
    expect(control.value).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe("ControlPanel", () => {
  it("wraps focus and delegates adjust and activate to the focused control", () => {
    const choice = new ChoiceControl({
      label: "Loop",
      choices: [
        { value: "wrap", label: "Wrap" },
        { value: "once", label: "Once" },
      ],
      value: "wrap",
      glyphs: "ascii",
    });
    const slider = new SliderControl({
      label: "Band",
      min: 1,
      max: 8,
      step: 1,
      value: 2,
      glyphs: "ascii",
    });
    const toggle = new ToggleControl({
      label: "Motion",
      value: false,
      glyphs: "ascii",
    });
    const panel = new ControlPanel([choice, slider, toggle]);

    expect(panel.focusedIndex).toBe(0);
    expect(stripTerminalSequences(panel.render(80)[0] ?? "")).toMatch(/^> Loop/u);
    panel.focusNext();
    expect(panel.focusedIndex).toBe(1);
    panel.adjust(1);
    expect(slider.value).toBe(3);
    panel.focusNext();
    panel.activate();
    expect(toggle.value).toBe(true);
    panel.focusNext();
    expect(panel.focusedIndex).toBe(0);
    panel.focusPrevious();
    expect(panel.focusedIndex).toBe(2);
  });

  it("requests one render for each direct interaction method", () => {
    const requestRender = vi.fn();
    const control = new CustomControl();
    const panel = new ControlPanel([control], { requestRender });

    for (const interact of [
      () => panel.focusNext(),
      () => panel.focusPrevious(),
      () => panel.adjust(1),
      () => panel.activate(),
    ]) {
      requestRender.mockClear();
      interact();
      expect(requestRender).toHaveBeenCalledTimes(1);
    }
  });

  it("requests exactly one render through handleInput without consuming Space", () => {
    const requestRender = vi.fn();
    const panel = new ControlPanel([
      new ToggleControl({ label: "Motion", value: false }),
      new SliderControl({ label: "Level", min: 0, max: 2, step: 1, value: 1 }),
    ], { requestRender });

    for (const data of ["\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\r"]) {
      requestRender.mockClear();
      expect(panel.handleInput(data)).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(1);
    }
    requestRender.mockClear();
    expect(panel.handleInput(" ")).toBe(false);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("keeps every ANSI-styled row inside narrow terminal widths", () => {
    const controls = [
      new ChoiceControl({
        label: "\x1b[31mDirection\nunsafe\x1b[0m",
        choices: [
          { value: "ltr", label: "Left to right" },
          { value: "rtl", label: "Right to left" },
        ],
        value: "ltr",
        focused: true,
        theme: "catppuccin",
      }),
      new SliderControl({
        label: "Intensity",
        min: 0,
        max: 1,
        step: 0.1,
        value: 0.9,
        theme: "catppuccin",
        formatValue: (value) => `\x1b[31m${Math.round(value * 100)}%\x1b[0m`,
      }),
      new ToggleControl({ label: "Compare", value: true, theme: "catppuccin" }),
    ];
    const panel = new ControlPanel(controls);

    for (const width of [0, 1, 4, 8, 16, 24]) {
      const lines = panel.render(width);
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(stripTerminalSequences(panel.render(80)[0] ?? "")).not.toContain("\n");
    expect(stripTerminalSequences(panel.render(80)[1] ?? "")).not.toContain("\x1b");
  });

  it("aligns built-in labels without adding layout methods to their public contract", () => {
    const panel = new ControlPanel([
      new ToggleControl({ label: "FX", value: true, glyphs: "ascii", color: "never" }),
      new SliderControl({
        label: "Brightness",
        min: 0,
        max: 1,
        step: 0.1,
        value: 0.5,
        glyphs: "ascii",
        color: "never",
      }),
    ]);

    const [toggle = "", slider = ""] = panel.render(80);
    expect(toggle.indexOf("[x]")).toBe(slider.indexOf("====|---"));
    expect("labelWidth" in panel.controls[0]!).toBe(false);
    expect("setLabelWidth" in panel.controls[0]!).toBe(false);
  });

  it("handles navigation and activation keys while leaving Space and unknown input alone", () => {
    const toggle = new ToggleControl({ label: "Motion", value: false, color: "never" });
    const slider = new SliderControl({
      label: "Level",
      min: 0,
      max: 2,
      step: 1,
      value: 1,
      color: "never",
    });
    const panel = new ControlPanel([toggle, slider]);

    expect(panel.handleInput("\x1b[B")).toBe(true);
    expect(panel.focusedIndex).toBe(1);
    expect(panel.handleInput("\x1b[C")).toBe(true);
    expect(slider.value).toBe(2);
    expect(panel.handleInput("\x1b[A")).toBe(true);
    expect(panel.focusedIndex).toBe(0);
    expect(panel.handleInput("\r")).toBe(true);
    expect(toggle.value).toBe(true);
    expect(panel.handleInput("\x1b[D")).toBe(true);
    expect(toggle.value).toBe(false);
    expect(panel.handleInput(" ")).toBe(false);
    expect(panel.handleInput("x")).toBe(false);
  });

  it("propagates presentation settings and interaction to a DIY custom control", () => {
    const custom = new CustomControl();
    const panel = new ControlPanel([custom]);

    expect(custom.focused).toBe(true);
    expect(panel.render(4)).toEqual(["cust"]);
    panel.setTheme("clay");
    panel.setGlyphs("ascii");
    panel.setColor("never");
    expect(custom.theme).toBe("clay");
    expect(custom.glyphs).toBe("ascii");
    expect(custom.color).toBe("never");
    expect(panel.handleInput("\x1b[C")).toBe(true);
    expect(custom.adjustment).toBe(1);
    expect(panel.handleInput("\r")).toBe(true);
    expect(custom.activations).toBe(1);
  });

  it("handles an empty panel as a safe no-op", () => {
    const requestRender = vi.fn();
    const panel = new ControlPanel([], { requestRender });
    panel.focusNext();
    panel.focusPrevious();
    panel.adjust(1);
    panel.activate();
    expect(panel.handleInput("\x1b[A")).toBe(false);
    expect(panel.handleInput("\r")).toBe(false);
    expect(panel.focusedIndex).toBe(-1);
    expect(panel.render(10)).toEqual([]);
    expect(requestRender).not.toHaveBeenCalled();
  });
});

describe("lab control validation", () => {
  it("rejects empty choices and invalid slider geometry", () => {
    expect(() => new ChoiceControl({
      label: "Empty",
      choices: [],
      value: "missing",
    })).toThrow(RangeError);
    expect(() => new SliderControl({
      label: "Invalid",
      min: 10,
      max: 1,
      step: 1,
      value: 5,
    })).toThrow(RangeError);
    expect(() => new SliderControl({
      label: "Invalid",
      min: 0,
      max: 1,
      step: 0,
      value: 0.5,
    })).toThrow(RangeError);
  });
});
