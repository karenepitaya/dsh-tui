import {
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  colorizeThemeText,
  ORB_THEMES,
  type OrbTheme,
  type OrbThemeName,
  type OrbThemeTextToken,
} from "./themes.js";

export type LabControlGlyphs = "unicode" | "ascii";
export type LabControlColor = "always" | "never";
export type LabControlTheme = OrbThemeName | OrbTheme;
export type ControlAdjustment = -1 | 1;

export interface LabControl extends Component {
  readonly focused: boolean;
  setFocused(focused: boolean): void;
  setTheme(theme: LabControlTheme): void;
  setGlyphs(glyphs: LabControlGlyphs): void;
  setColor(color: LabControlColor): void;
  adjust(direction: ControlAdjustment): void;
  activate(): void;
}

export interface LabControlOptions {
  readonly label: string;
  readonly focused?: boolean;
  readonly theme?: LabControlTheme;
  readonly glyphs?: LabControlGlyphs;
  readonly color?: LabControlColor;
  /** Render only the input surface when the enclosing form owns its label. */
  readonly valueOnly?: boolean;
  readonly paint?: (text: string, token: OrbThemeTextToken) => string;
}

export interface ChoiceItem<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface ChoiceControlOptions<T extends string> extends LabControlOptions {
  readonly choices: readonly ChoiceItem<T>[];
  readonly value: T;
  readonly onChange?: (value: T) => void;
  readonly appearance?: "radio" | "select" | "segmented";
}

export interface SliderControlOptions extends LabControlOptions {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly formatValue?: (value: number) => string;
  readonly onChange?: (value: number) => void;
}

export interface ToggleControlOptions extends LabControlOptions {
  readonly value: boolean;
  readonly onLabel?: string;
  readonly offLabel?: string;
  readonly onChange?: (value: boolean) => void;
  readonly appearance?: "indicator" | "switch";
}

export interface ControlPanelOptions {
  readonly requestRender?: () => void;
}

const SLIDER_TRACK_WIDTH = 8;
const CONTROL_LABEL_WIDTH = Symbol("controlLabelWidth");
const CONTROL_RENDER = Symbol("controlRender");

interface LabControlRenderContext {
  readonly labelWidth: number;
}

interface InternallyRenderedLabControl extends LabControl {
  readonly [CONTROL_LABEL_WIDTH]: number;
  [CONTROL_RENDER](width: number, context: LabControlRenderContext): string[];
}

function sanitizeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveTheme(theme: LabControlTheme): OrbTheme {
  return typeof theme === "string" ? ORB_THEMES[theme] : theme;
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function assertAdjustment(direction: number): asserts direction is ControlAdjustment {
  if (direction !== -1 && direction !== 1) {
    throw new RangeError("Control adjustment must be -1 or 1.");
  }
}

abstract class BaseControl implements LabControl {
  readonly #label: string;
  #focused: boolean;
  #theme: OrbTheme;
  #glyphs: LabControlGlyphs;
  #color: LabControlColor;
  readonly #valueOnly: boolean;
  readonly #paint: LabControlOptions["paint"];

  protected constructor(options: LabControlOptions) {
    const label = sanitizeInline(options.label);
    if (label.length === 0) throw new RangeError("Control label cannot be empty.");
    this.#label = label;
    this.#focused = options.focused ?? false;
    this.#theme = resolveTheme(options.theme ?? "openai");
    this.#glyphs = options.glyphs ?? "unicode";
    this.#color = options.color ?? "always";
    this.#valueOnly = options.valueOnly ?? false;
    this.#paint = options.paint;
  }

  get focused(): boolean {
    return this.#focused;
  }

  protected get glyphs(): LabControlGlyphs {
    return this.#glyphs;
  }

  get [CONTROL_LABEL_WIDTH](): number {
    return visibleWidth(this.#label);
  }

  invalidate(): void {
    // Controls are small value objects and render directly from current state.
  }

  setFocused(focused: boolean): void {
    this.#focused = focused;
  }

  setTheme(theme: LabControlTheme): void {
    this.#theme = resolveTheme(theme);
  }

  setGlyphs(glyphs: LabControlGlyphs): void {
    this.#glyphs = glyphs;
  }

  setColor(color: LabControlColor): void {
    this.#color = color;
  }

  render(width: number): string[] {
    return this[CONTROL_RENDER](width, { labelWidth: this[CONTROL_LABEL_WIDTH] });
  }

  [CONTROL_RENDER](width: number, context: LabControlRenderContext): string[] {
    const available = safeWidth(width);
    if (available === 0) return [""];
    if (this.#valueOnly) return [truncateToWidth(this.renderValue(available), available, "")];
    const rawPrefix = this.#focused
      ? (this.#glyphs === "ascii" ? ">" : "›")
      : " ";
    const prefix = this.style(rawPrefix, this.#focused ? "high" : "muted");
    const padding = Math.max(0, context.labelWidth - this[CONTROL_LABEL_WIDTH]);
    const label = this.style(
      `${this.#label}${" ".repeat(padding)}`,
      this.#focused ? "high" : "label",
    );
    return [truncateToWidth(`${prefix} ${label}  ${this.renderValue()}`, available, "")];
  }

  abstract adjust(direction: ControlAdjustment): void;
  abstract activate(): void;

  protected abstract renderValue(width?: number): string;

  protected style(text: string, token: OrbThemeTextToken): string {
    if (this.#paint) return this.#paint(text, token);
    return this.#color === "always" ? colorizeThemeText(text, token, this.#theme) : text;
  }
}

export class ChoiceControl<T extends string> extends BaseControl {
  readonly #choices: readonly ChoiceItem<T>[];
  readonly #onChange: ((value: T) => void) | undefined;
  #value: T;
  readonly #appearance: NonNullable<ChoiceControlOptions<T>["appearance"]>;

  constructor(options: ChoiceControlOptions<T>) {
    super(options);
    if (options.choices.length === 0) {
      throw new RangeError("ChoiceControl requires at least one choice.");
    }
    const seen = new Set<T>();
    this.#choices = options.choices.map((choice) => {
      if (seen.has(choice.value)) {
        throw new RangeError(`Duplicate ChoiceControl value: ${choice.value}`);
      }
      seen.add(choice.value);
      const label = sanitizeInline(choice.label);
      if (label.length === 0) throw new RangeError("Choice labels cannot be empty.");
      return { value: choice.value, label };
    });
    if (!seen.has(options.value)) {
      throw new RangeError("ChoiceControl value must match one of its choices.");
    }
    this.#value = options.value;
    this.#onChange = options.onChange;
    this.#appearance = options.appearance ?? "radio";
  }

  get value(): T {
    return this.#value;
  }

  setValue(value: T): void {
    if (value === this.#value) return;
    if (!this.#choices.some((choice) => choice.value === value)) {
      throw new RangeError("ChoiceControl value must match one of its choices.");
    }
    this.#value = value;
    this.#onChange?.(value);
  }

  adjust(direction: ControlAdjustment): void {
    assertAdjustment(direction);
    const index = this.#choices.findIndex((choice) => choice.value === this.#value);
    const nextIndex = (index + direction + this.#choices.length) % this.#choices.length;
    const next = this.#choices[nextIndex];
    if (next !== undefined) this.setValue(next.value);
  }

  activate(): void {
    // Radio choices are deliberately changed only with left/right adjustment.
  }

  protected renderValue(width?: number): string {
    if (this.#appearance !== "radio") {
      const current = this.#choices.find((choice) => choice.value === this.#value)!;
      const segments = this.#choices.map((choice) => {
        const selected = choice.value === this.#value;
        return this.style(selected ? ` ${this.glyphs === "ascii" ? ">" : "▸"} ${choice.label} ` : `   ${choice.label} `, selected ? "high" : "muted");
      }).join(this.glyphs === "ascii" ? "|" : "│");
      if (this.#appearance === "segmented" && (width === undefined || visibleWidth(segments) <= width)) {
        return segments;
      }
      const suffix = this.glyphs === "ascii" ? "  v " : "  ▾ ";
      const label = width === undefined ? current.label : truncateToWidth(current.label, Math.max(0, width - 6), "");
      const gap = width === undefined ? "" : " ".repeat(Math.max(0, width - 6 - visibleWidth(label)));
      return this.style(`  ${label}${gap}${suffix}`, this.focused ? "high" : "label");
    }
    return this.#choices.map((choice) => {
      const selected = choice.value === this.#value;
      const marker = this.glyphs === "ascii"
        ? (selected ? "(*)" : "( )")
        : (selected ? "●" : "○");
      return this.style(`${marker} ${choice.label}`, selected ? "high" : "muted");
    }).join("  ");
  }
}

export class SliderControl extends BaseControl {
  readonly #min: number;
  readonly #max: number;
  readonly #step: number;
  readonly #formatValue: (value: number) => string;
  readonly #onChange: ((value: number) => void) | undefined;
  #value: number;

  constructor(options: SliderControlOptions) {
    super(options);
    if (!Number.isFinite(options.min) || !Number.isFinite(options.max) || options.max <= options.min) {
      throw new RangeError("Slider maximum must be greater than its finite minimum.");
    }
    if (!Number.isFinite(options.step) || options.step <= 0) {
      throw new RangeError("Slider step must be a positive finite number.");
    }
    if (!Number.isFinite(options.value) || options.value < options.min || options.value > options.max) {
      throw new RangeError("Slider value must be inside its range.");
    }
    this.#min = options.min;
    this.#max = options.max;
    this.#step = options.step;
    this.#value = options.value;
    this.#formatValue = options.formatValue ?? ((value) => String(value));
    this.#onChange = options.onChange;
  }

  get min(): number {
    return this.#min;
  }

  get max(): number {
    return this.#max;
  }

  get step(): number {
    return this.#step;
  }

  get value(): number {
    return this.#value;
  }

  setValue(value: number): void {
    if (!Number.isFinite(value) || value < this.#min || value > this.#max) {
      throw new RangeError("Slider value must be inside its range.");
    }
    const normalized = Number(value.toFixed(12));
    if (normalized === this.#value) return;
    this.#value = normalized;
    this.#onChange?.(normalized);
  }

  adjust(direction: ControlAdjustment): void {
    assertAdjustment(direction);
    const next = Math.max(this.#min, Math.min(this.#max, this.#value + (direction * this.#step)));
    this.setValue(Number(next.toFixed(12)));
  }

  activate(): void {
    // Sliders are deliberately changed only with left/right adjustment.
  }

  protected renderValue(): string {
    const ratio = (this.#value - this.#min) / (this.#max - this.#min);
    const thumb = Math.round(ratio * (SLIDER_TRACK_WIDTH - 1));
    const track = Array.from({ length: SLIDER_TRACK_WIDTH }, (_, index) => {
      let glyph: string;
      if (this.glyphs === "ascii") {
        glyph = index < thumb ? "=" : index === thumb ? "|" : "-";
      } else {
        glyph = index < thumb ? "━" : index === thumb ? "●" : "─";
      }
      return this.style(glyph, index <= thumb ? "high" : "muted");
    }).join("");
    const formatted = sanitizeInline(this.#formatValue(this.#value));
    return `${track}  ${this.style(formatted, this.focused ? "high" : "label")}`;
  }
}

export class ToggleControl extends BaseControl {
  readonly #onLabel: string;
  readonly #offLabel: string;
  readonly #onChange: ((value: boolean) => void) | undefined;
  #value: boolean;
  readonly #appearance: NonNullable<ToggleControlOptions["appearance"]>;

  constructor(options: ToggleControlOptions) {
    super(options);
    this.#value = options.value;
    this.#onLabel = sanitizeInline(options.onLabel ?? "On");
    this.#offLabel = sanitizeInline(options.offLabel ?? "Off");
    if (this.#onLabel.length === 0 || this.#offLabel.length === 0) {
      throw new RangeError("Toggle labels cannot be empty.");
    }
    this.#onChange = options.onChange;
    this.#appearance = options.appearance ?? "indicator";
  }

  get value(): boolean {
    return this.#value;
  }

  setValue(value: boolean): void {
    if (value === this.#value) return;
    this.#value = value;
    this.#onChange?.(value);
  }

  adjust(direction: ControlAdjustment): void {
    assertAdjustment(direction);
    this.setValue(direction === 1);
  }

  activate(): void {
    this.setValue(!this.#value);
  }

  protected renderValue(): string {
    if (this.#appearance === "switch") {
      const thumb = this.glyphs === "ascii" ? "#" : "■";
      const track = this.#value ? `${this.glyphs === "ascii" ? "==" : "━━"}${thumb}` : `${thumb}${this.glyphs === "ascii" ? "--" : "──"}`;
      return `${this.style(track, this.focused || this.#value ? "high" : "muted")} ${this.style(this.#value ? this.#onLabel : this.#offLabel, "label")}`;
    }
    const marker = this.glyphs === "ascii"
      ? (this.#value ? "[x]" : "[ ]")
      : (this.#value ? "●" : "○");
    const label = this.#value ? this.#onLabel : this.#offLabel;
    return this.style(`${marker} ${label}`, this.#value ? "high" : "muted");
  }
}

export class ControlPanel implements Component {
  readonly #controls: readonly LabControl[];
  readonly #requestRender: (() => void) | undefined;
  #focusedIndex: number;

  constructor(controls: readonly LabControl[], options: ControlPanelOptions = {}) {
    this.#controls = [...controls];
    this.#requestRender = options.requestRender;
    this.#focusedIndex = this.#controls.length === 0 ? -1 : 0;
    this.#controls.forEach((control, index) => control.setFocused(index === this.#focusedIndex));
  }

  get controls(): readonly LabControl[] {
    return [...this.#controls];
  }

  get focusedIndex(): number {
    return this.#focusedIndex;
  }

  invalidate(): void {
    for (const control of this.#controls) control.invalidate();
  }

  setTheme(theme: LabControlTheme): void {
    for (const control of this.#controls) control.setTheme(theme);
  }

  setGlyphs(glyphs: LabControlGlyphs): void {
    for (const control of this.#controls) control.setGlyphs(glyphs);
  }

  setColor(color: LabControlColor): void {
    for (const control of this.#controls) control.setColor(color);
  }

  focusNext(): void {
    if (this.#focusedControl() === undefined) return;
    this.#moveFocus(1);
    this.#requestRender?.();
  }

  focusPrevious(): void {
    if (this.#focusedControl() === undefined) return;
    this.#moveFocus(-1);
    this.#requestRender?.();
  }

  adjust(direction: ControlAdjustment): void {
    assertAdjustment(direction);
    const control = this.#focusedControl();
    if (control === undefined) return;
    control.adjust(direction);
    this.#requestRender?.();
  }

  activate(): void {
    const control = this.#focusedControl();
    if (control === undefined) return;
    control.activate();
    this.#requestRender?.();
  }

  handleInput(data: string): boolean {
    if (this.#focusedControl() === undefined) return false;
    if (matchesKey(data, Key.up)) {
      this.focusPrevious();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.focusNext();
      return true;
    }
    if (matchesKey(data, Key.left)) {
      this.adjust(-1);
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.adjust(1);
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      this.activate();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const builtInControls = this.#controls.filter(isInternallyRenderedLabControl);
    const labelWidth = Math.max(
      0,
      ...builtInControls.map((control) => control[CONTROL_LABEL_WIDTH]),
    );
    const context = { labelWidth };
    return this.#controls.map((control) => {
      const lines = isInternallyRenderedLabControl(control)
        ? control[CONTROL_RENDER](width, context)
        : control.render(width);
      return lines[0] ?? "";
    });
  }

  #moveFocus(direction: ControlAdjustment): void {
    if (this.#controls.length === 0) return;
    const previous = this.#focusedIndex;
    this.#focusedIndex = (
      this.#focusedIndex + direction + this.#controls.length
    ) % this.#controls.length;
    this.#controls[previous]?.setFocused(false);
    this.#controls[this.#focusedIndex]?.setFocused(true);
  }

  #focusedControl(): LabControl | undefined {
    return this.#focusedIndex < 0 ? undefined : this.#controls[this.#focusedIndex];
  }
}

function isInternallyRenderedLabControl(
  control: LabControl,
): control is InternallyRenderedLabControl {
  return CONTROL_LABEL_WIDTH in control && CONTROL_RENDER in control;
}
