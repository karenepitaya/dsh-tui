import { type Component } from "@earendil-works/pi-tui";
import {
  cleanControlText, clipControlText, controlWidth, NEUTRAL_CONTROL_THEME,
  type ControlRole, type ControlSpan, type ControlTheme,
} from "./control-presentation.js";

/** Activation is owned by the host, just as it is for FormWorkspace. */
export interface ButtonModel {
  readonly label: string;
  readonly focused?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly intent?: "primary" | "danger";
  readonly appearance?: "button" | "plain" | "action";
}

/** Pure text and semantic state: usable without ANSI or a Component tree. */
export function projectButton(model: ButtonModel, width?: number): ControlSpan {
  const columns = controlWidth(width);
  const role: ControlRole = model.disabled || model.busy ? "disabled" : model.intent === "danger" ? "error"
    : model.intent === "primary" ? "primary" : model.focused ? "focus" : "button";
  const label = cleanControlText(model.label);
  const suffix = model.busy ? " …" : "";
  const appearance = model.appearance ?? "button";
  const marker = model.focused ? "› " : "";
  const [before, after] = appearance === "button" ? [marker + "[ ", " ]"] : appearance === "action" ? [model.focused ? "› " : "  ", ""] : [model.focused ? "›" : " ", " "];
  const content = clipControlText(label, Math.max(0, columns - before.length - after.length - suffix.length));
  return { role, text: clipControlText(before + content + after + suffix, columns) };
}

export function renderButton(model: ButtonModel, width?: number, theme: ControlTheme = NEUTRAL_CONTROL_THEME): string {
  const span = projectButton(model, width);
  const painted = theme.paint(span.role, span.text);
  return model.appearance === "plain" ? theme.paint("button", painted) : painted;
}

export class Button implements Component {
  constructor(private model: ButtonModel, private theme: ControlTheme = NEUTRAL_CONTROL_THEME) {}
  setModel(model: ButtonModel): void { this.model = model; }
  setTheme(theme: ControlTheme): void { this.theme = theme; }
  invalidate(): void {}
  render(width: number): string[] { return [renderButton(this.model, width, this.theme)]; }
}
