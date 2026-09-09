import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  cleanControlText, clipControlSpans, clipControlText, controlWidth, NEUTRAL_CONTROL_THEME,
  type ControlRole, type ControlSpan, type ControlTheme,
} from "./control-presentation.js";

export interface SelectionListItem {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  /** Consecutive items share a heading; headings do not consume selectedIndex. */
  readonly group?: string;
  readonly badge?: string;
  readonly tone?: "success" | "accent";
  readonly checked?: boolean;
  readonly kind?: "radio" | "multi";
}
export interface ChoiceRowOptions {
  readonly width?: number;
  readonly selected?: boolean;
  readonly focused?: boolean;
}
export interface SelectionListModel {
  readonly items: readonly SelectionListItem[];
  readonly selectedIndex: number;
  readonly height: number;
  readonly focused?: boolean;
  readonly emptyMessage?: string;
}

/** The same pure row projection is consumed by the list and legacy text hosts. */
export function projectChoiceRow(item: SelectionListItem, options: ChoiceRowOptions = {}): readonly ControlSpan[] {
  const width = controlWidth(options.width);
  const checked = item.checked === undefined ? "" : item.kind === "multi" ? item.checked ? "☑ " : "☐ " : item.checked ? "◉ " : "○ ";
  const prefix = (options.selected ? "› " : "  ") + checked;
  const disabled = item.disabled ? " · 不可用" : "";
  const badge = item.badge ? " " + clipControlText(cleanControlText(item.badge), Math.max(0, width - visibleWidth(prefix + disabled) - 8)) : "";
  const available = Math.max(0, width - visibleWidth(prefix + disabled + badge) - 2);
  const labelText = cleanControlText(item.label);
  const labelMinimum = Math.min(visibleWidth(labelText), Math.ceil(available / 2));
  const value = item.value ? "  " + clipControlText(cleanControlText(item.value), available - labelMinimum) : "";
  const label = clipControlText(labelText, Math.max(0, width - visibleWidth(prefix + disabled + value + badge)));
  const role: ControlRole = item.disabled ? "disabled" : options.selected ? options.focused === false ? "selected" : "focus" : "text";
  return clipControlSpans([
    { role, text: prefix + label + disabled + value },
    ...(badge ? [{ role: item.tone ?? "muted", text: badge } as ControlSpan] : []),
  ], width);
}

type ListLine = { readonly kind: "heading" | "item" | "description"; readonly index: number };

/** Bounded viewport: only visible rows are formatted and painted. */
export class SelectionList implements Component {
  constructor(private model: SelectionListModel, private theme: ControlTheme = NEUTRAL_CONTROL_THEME) {}
  setModel(model: SelectionListModel): void { this.model = model; }
  setTheme(theme: ControlTheme): void { this.theme = theme; }
  invalidate(): void {}
  render(width: number): string[] {
    width = controlWidth(width);
    const height = controlWidth(this.model.height);
    if (height === 0 || width === 0) return [];
    const { items } = this.model;
    if (!items.length) return [this.theme.paint("muted", clipControlText(cleanControlText(this.model.emptyMessage ?? "没有可选项"), width))];
    const selectedIndex = Math.max(0, Math.min(items.length - 1, Math.floor(this.model.selectedIndex) || 0));
    const entries: ListLine[] = [];
    let selectedTop = 0;
    let selectedHeight = 1;
    for (const [index, item] of items.entries()) {
      if (item.group && item.group !== items[index - 1]?.group) entries.push({ kind: "heading", index });
      if (index === selectedIndex) { selectedTop = entries.length; selectedHeight = item.description && height > 1 ? 2 : 1; }
      entries.push({ kind: "item", index });
      if (item.description && height > 1) entries.push({ kind: "description", index });
    }
    const startFor = (budget: number): number => Math.max(0, selectedTop + Math.min(selectedHeight, budget) - budget);
    let start = startFor(height);
    let budget = height;
    let sticky: string | undefined;
    const first = entries[start]!;
    if (height > 1 && start > 0 && first.kind !== "heading" && items[first.index]!.group) {
      budget--;
      start = startFor(budget);
      const top = entries[start]!;
      if (top.kind !== "heading") sticky = items[top.index]!.group;
      else budget++;
    }
    if (entries[start]?.kind === "description" && start < selectedTop) start++;
    const lines = sticky ? [this.theme.paint("muted", clipControlText(cleanControlText(sticky), width))] : [];
    for (const entry of entries.slice(start, start + budget)) {
      const item = items[entry.index]!;
      if (entry.kind === "heading") lines.push(this.theme.paint("muted", clipControlText(cleanControlText(item.group!), width)));
      else if (entry.kind === "description") lines.push(this.theme.paint("muted", clipControlText("  " + cleanControlText(item.description!), width)));
      else lines.push(projectChoiceRow(item, { width, selected: entry.index === selectedIndex, focused: this.model.focused ?? true })
        .map((span) => this.theme.paint(span.role, span.text)).join(""));
    }
    return lines.slice(0, height);
  }
}
