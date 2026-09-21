import {
  Box, HStack, ScrollView, Text, TruncatedText, VStack,
  stripTerminalSequences, truncateToWidth, visibleWidth,
  wrapTextWithAnsi, type Component,
} from "@earendil-works/pi-tui";
import { Orb } from "./orb.js";
import type { MotionHost } from "./motion-host.js";
import { ChoiceControl, ToggleControl } from "./lab-controls.js";
import { Button, projectButton, renderButton } from "./button.js";
import { SelectionList } from "./selection-list.js";
import { cleanControlText } from "./control-presentation.js";
import {
  NEUTRAL_FORM_WORKSPACE_THEME,
  type FormWorkspaceConfirmation, type FormWorkspaceCursor,
  type FormWorkspaceField, type FormWorkspaceForm, type FormWorkspaceModel, type FormWorkspaceRole,
  type FormWorkspaceTheme, type FormWorkspaceModal,
} from "./form-workspace-model.js";

const clean = cleanControlText;
const size = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const pad = (text: string, width: number): string => {
  const measured = visibleWidth(text);
  if (measured <= width) return text + " ".repeat(width - measured);
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const noop = (): void => {};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function inputWindow(text: string, cursor: number, width: number): { text: string; column: number } {
  const value = clean(text);
  const segments = [...graphemes.segment(value)].map((entry) => entry.segment);
  let column = visibleWidth(clean(text.slice(0, Math.max(0, cursor))));
  let start = 0;
  while (column >= width && start < segments.length) column -= visibleWidth(segments[start++]!);
  return { text: truncateToWidth(segments.slice(start).join(""), width, ""), column: Math.max(0, column) };
}

/** A decorative panel. Layout, padding and background are delegated to pi-tui Box. */
class Panel implements Component {
  readonly #box: Box;
  constructor(child: Component, readonly theme: FormWorkspaceTheme, readonly role: FormWorkspaceRole = "panel") {
    this.#box = new Box(1, 0, (text) => theme.paint(role, text));
    this.#box.addChild(child);
  }
  invalidate(): void { this.#box.invalidate(); }
  render(width: number): string[] {
    if (width < 4) return this.#box.render(width).map((line) => truncateToWidth(line, width, ""));
    const border = this.theme.paint("border", `┌${"─".repeat(width - 2)}┐`);
    const bottom = this.theme.paint("border", `└${"─".repeat(width - 2)}┘`);
    return [border, ...this.#box.render(width - 2).map((line) => `${this.theme.paint("border", "│")}${line}${this.theme.paint("border", "│")}`), bottom];
  }
}

/** ScrollView's standalone render returns content; this adapter supplies its viewport. */
class ScrollViewport implements Component {
  readonly scroll: ScrollView;
  constructor(readonly child: Component, readonly height: number, readonly selected: { top: number; height: number } | undefined, readonly initialTop: number) {
    this.scroll = new ScrollView(child, { scrollbar: "hidden", overscroll: "contain" });
  }
  invalidate(): void { this.child.invalidate(); }
  render(width: number): string[] {
    const all = this.scroll.render(width);
    this.scroll.updateLayout(all.length, this.height, noop);
    this.scroll.scrollTo(this.initialTop);
    const selected = this.selected;
    if (selected) {
      if (selected.top < this.scroll.scrollTop) this.scroll.scrollTo(selected.top);
      else if (selected.top + selected.height > this.scroll.scrollTop + this.height) {
        this.scroll.scrollTo(Math.min(selected.top, selected.top + selected.height - this.height));
      }
    }
    const result = all.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
    while (result.length < this.height) result.push("");
    return result;
  }
}

class Field implements Component {
  constructor(readonly field: FormWorkspaceField, readonly focused: boolean, readonly theme: FormWorkspaceTheme, readonly form = false) {}
  invalidate(): void {}
  render(width: number): string[] {
    const { field, focused, theme } = this;
    const text = (role: FormWorkspaceRole, value: string): string => theme.paint(role, clean(value));
    const status = this.form ? "" : field.pending ? " · 处理中" : field.readonly ? " · 只读" : field.changed ? " ·" : "";
    const inputWidth = Math.min(Math.max(14, Math.ceil(width * 0.39)), Math.max(14, width - 13));
    const labelWidth = width < 28 ? width : width - inputWidth - 2;
    const labelText = text("text", field.label) + text("muted", status);
    const badge = field.badge ? text(field.tone ?? "muted", field.badge) : "";
    const label = badge ? new RenderedLines(visibleWidth(badge) + Math.min(12, visibleWidth(labelText)) + 1 <= labelWidth
      ? [truncateToWidth(labelText, labelWidth - visibleWidth(badge) - 1, "…") + " " + badge]
      : [labelText, badge]) : new TruncatedText(labelText, 0, 0);
    const description = new Text(text("muted", field.description ?? ""), 0, 0);
    const details = new VStack([...(this.form ? [] : [description]), ...(field.error ? [new Text(text("error", field.error), 0, 0)] : [])]);
    const labels = new VStack([label, details]);
    const control = field.control;
    const paint = (value: string, token: string): string => {
      const role = field.readonly || field.pending ? "disabled" : token === "high" ? (focused ? "focus" : "selected") : "control";
      const styled = theme.paint(role, value);
      return focused && !field.readonly && !field.pending ? theme.paint("control", styled) : styled;
    };
    let input: Component;
    const options = { label: clean(field.label) || "Value", focused, valueOnly: true, color: "never" as const, paint };
    if (control.kind === "action") {
      const button = { label: control.value || field.label, focused, disabled: Boolean(field.readonly || field.pending),
        ...(field.intent ? { intent: field.intent } : {}), appearance: "plain" as const };
      if (this.form && control.value === field.label) return new RenderedLines([renderButton(button, Math.max(0, width - visibleWidth(badge) - Number(Boolean(badge))), theme) + (badge ? " " + badge : "")]).render(width);
      input = new Button(button, theme);
    } else if (this.form && control.kind === "text") {
      const slotWidth = width < 28 ? width : inputWidth;
      const value = pad(truncateToWidth(clean(control.value) || "—", Math.max(0, slotWidth - 6), "…"), Math.max(0, slotWidth - 6));
      input = new TruncatedText(paint(`│ ${value} ✎ │`, focused ? "high" : "label"), 0, 0);
    } else if (control.kind === "toggle") {
      input = new ToggleControl({ ...options, value: control.checked ?? false, appearance: "switch", onLabel: clean(control.value), offLabel: clean(control.value) });
    } else if (control.kind === "select" || control.kind === "segmented") {
      const choices = control.choices?.length ? control.choices.map((choice) => ({ value: clean(choice.value), label: clean(choice.label) || "—" })) : [{ value: clean(control.value), label: clean(control.value) || "—" }];
      if (!choices.some((choice) => choice.value === clean(control.value))) choices.push({ value: clean(control.value), label: clean(control.value) || "—" });
      input = new ChoiceControl({ ...options, choices, value: clean(control.value), appearance: control.kind });
    } else {
      input = new TruncatedText(paint(`  ${clean(control.value) || "—"}  `, focused ? "high" : "label"), 0, 0);
    }
    if (width < 28) return new VStack([label, input, details]).render(width);
    return new HStack([
      { component: labels, basis: width - inputWidth - 2, shrink: 0 },
      { component: input, basis: inputWidth, shrink: 0 },
    ], { gap: 2 }).render(width);
  }
}

function modalWidth(width: number): number { return Math.max(1, Math.min(width - (width >= 44 ? 6 : 0), 76)); }
function confirmationContent(modal: FormWorkspaceConfirmation, width: number): string[] {
  return modal.lines.flatMap((line) => wrapTextWithAnsi(clean(line), Math.max(1, width)));
}

function modalHelp(modal: FormWorkspaceModal, width: number): string[] {
  const hint = modal.hint;
  const columns = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const action of clean(hint).trim().split(/ {2,}/u)) {
    if (visibleWidth(action) > columns) {
      if (line) lines.push(line);
      const wrapped = wrapTextWithAnsi(action, columns);
      lines.push(...wrapped.slice(0, -1));
      line = wrapped.at(-1) ?? "";
    } else if (line && visibleWidth(line + "  " + action) > columns) {
      lines.push(line);
      line = action;
    } else line += (line ? "  " : "") + action;
  }
  return [...lines, line];
}

/** The same fit predicate must gate the reducer's confirm action. No content may be hidden. */
export function fitsFormConfirmation(width: number, height: number, modal: FormWorkspaceConfirmation): boolean {
  const inner = modalWidth(size(width)) - 4;
  if (inner < 20 || size(height) < 7) return false;
  const actions = modal.actions.map((action, index) => projectButton({ label: action.label, appearance: "plain", focused: index === modal.selectedIndex }).text).join("  ");
  const titleHeight = wrapTextWithAnsi(clean(modal.title), inner).length;
  return visibleWidth(actions) <= inner
    && confirmationContent(modal, inner).length + titleHeight + 3 + modalHelp(modal, size(width)).length <= size(height);
}

/** Presentation-only form surface composed from pi-tui containers and Orbs inputs. */
export class FormWorkspace implements Component {
  #model: FormWorkspaceModel;
  #theme: FormWorkspaceTheme;
  #cursor: FormWorkspaceCursor | undefined;
  #scrollTop = 0;
  #loading: Orb | undefined;
  constructor(model: FormWorkspaceModel, theme: FormWorkspaceTheme = NEUTRAL_FORM_WORKSPACE_THEME, readonly motion?: MotionHost) {
    this.#model = model;
    this.#theme = theme;
    this.#syncLoading();
  }
  dispose(): void { this.#loading?.dispose(); this.#loading = undefined; }
  #syncLoading(): void {
    const modal = this.#model.modal;
    const running = modal?.kind === "form" && modal.pending && modal.feedback?.tone === "accent";
    if (running && this.motion && !this.#loading) this.#loading = new Orb(this.motion, { autoplay: true });
    if (!running) this.dispose();
  }
  setModel(model: FormWorkspaceModel): void {
    if (model.activeCategoryId !== this.#model.activeCategoryId) this.#scrollTop = 0;
    this.#model = model;
    this.#syncLoading();
    this.invalidate();
  }
  setTheme(theme: FormWorkspaceTheme): void { this.#theme = theme; this.invalidate(); }
  getCursor(): FormWorkspaceCursor | undefined { return this.#cursor; }
  invalidate(): void { this.#cursor = undefined; }
  #line(value: string, role: FormWorkspaceRole = "text"): Component {
    return new TruncatedText(this.#theme.paint(role, clean(value)), 0, 0);
  }
  #actions(width: number, compact: boolean, maxHeight: number): Component {
    const model = this.#model;
    const state = model.pending ? "处理中" : model.dirtyCount > 0 ? `${model.dirtyCount} 项未保存` : "";
    const reason = model.disabledReason ?? (model.writable === false ? "只读" : "");
    const notice = clean(model.message ?? state);
    const message = `${notice}${reason && !notice.includes(reason) ? `${notice ? " · " : ""}${clean(reason)}` : ""}`;
    if (model.actions.length === 0) return model.message || reason
      ? new Text(this.#theme.paint(model.messageTone ?? "muted", clean(model.message ?? reason)), 0, 0)
      : new RenderedLines([]);
    const actions = model.actions.map((action, index) => renderButton({ label: action.label, appearance: "plain", disabled: Boolean(action.disabled),
      focused: model.focus === "actions" && (model.actionIndex ?? 0) === index, ...(action.id === "reset" ? { intent: "danger" as const } : action.id === "save" ? { intent: "primary" as const } : {}),
    }, undefined, this.#theme)).join(" ");
    const stateRole = model.message ? model.messageTone ?? "warning" : model.dirtyCount > 0 ? "warning" : "muted";
    if (width < visibleWidth(actions) + visibleWidth(message) + 3 && maxHeight > 1) {
      const wrapped = new Text(this.#theme.paint(stateRole, message), 0, 0).render(width);
      const limit = Math.max(1, maxHeight - 1);
      const visible = wrapped.slice(0, limit);
      if (wrapped.length > limit) {
        const suffix = "… 放大查看";
        visible[limit - 1] = truncateToWidth(visible[limit - 1] ?? "", Math.max(0, width - visibleWidth(suffix)), "") + this.#theme.paint(stateRole, suffix);
      }
      return new RenderedLines([...visible, actions]);
    }
    const stateWidth = Math.max(0, width - visibleWidth(actions) - 2);
    const label = truncateToWidth(message, stateWidth, "…");
    const line = `${this.#theme.paint(stateRole, label)}${" ".repeat(Math.max(2, width - visibleWidth(label) - visibleWidth(actions)))}${actions}`;
    return new TruncatedText(line, 0, 0);
  }
  #fields(width: number, height: number, compact: boolean): ScrollViewport {
    const entries: Component[] = [];
    let top = 0;
    let selected: { top: number; height: number } | undefined;
    for (const group of this.#model.groups) {
      if (group.fields.length === 0) continue;
      if (!compact) { entries.push(this.#line(group.title, "accent")); top += 1; }
      const fields: Component[] = [];
      let fieldTop = 0;
      for (const field of group.fields) {
        const component = new Field(field, this.#model.focus === "content" && field.id === this.#model.selectedFieldId, this.#theme);
        const fieldLines = component.render(compact ? width : Math.max(1, width - 4));
        const fieldHeight = fieldLines.length;
        if (field.id === this.#model.selectedFieldId) selected = { top: top + (compact ? 0 : 1) + fieldTop, height: fieldHeight };
        fields.push(new RenderedLines(fieldLines));
        fieldTop += fieldHeight + (compact ? 0 : 1);
      }
      const content = new VStack(fields, { gap: compact ? 0 : 1 });
      const panel = compact ? content : new Panel(content, this.#theme);
      const panelLines = panel.render(width);
      entries.push(new RenderedLines(panelLines));
      top += panelLines.length;
      if (!compact) { entries.push(this.#line("")); top += 1; }
    }
    if (!entries.length) entries.push(this.#line(this.#model.emptyMessage ?? "", "muted"));
    const content = new VStack(entries).render(width);
    return new ScrollViewport(new RenderedLines(content), Math.min(height, content.length), selected, this.#scrollTop);
  }
  #search(width: number): Component {
    const search = this.#model.search;
    const value = search?.text ? inputWindow(search.text, search.cursor, Math.max(1, width - 4)).text : "";
    return new TruncatedText(this.#theme.paint(this.#model.focus === "search" ? "focus" : "control", `  ${pad(value, Math.max(0, width - 4))}  `), 0, 0);
  }
  render(width: number): string[] {
    width = size(width);
    const height = size(this.#model.height);
    this.#cursor = undefined;
    if (width === 0) return Array.from({ length: height }, () => "");
    if (height === 0) return [];
    if (this.#model.modal) return this.#renderModal(width, height);
    const model = this.#model;
    const compact = height < 10;
    const wide = width >= 100 && !compact;
    const headerAction = model.headerAction?.label ?? "q / Esc 返回";
    const heading = new HStack([
      { component: this.#line(model.header ?? "", "title"), grow: 1 },
      { component: this.#line(headerAction, model.headerAction ? "accent" : "muted"), basis: Math.max(14, visibleWidth(clean(headerAction))), shrink: 0 },
    ]);
    const header = compact ? heading : new VStack([heading, this.#line("─".repeat(width), "border")]);
    const headerHeight = compact ? 1 : 2;
    const footer = this.#line(model.help ?? "", "muted");
    const bodyHeight = Math.max(0, height - headerHeight - 1);
    const contentWidth = wide ? width - 23 : width;
    const contentInnerWidth = Math.max(1, contentWidth - (compact ? 0 : 2));
    const categories = model.categories.map((category) => this.#theme.paint(category.id === model.activeCategoryId ? "accent" : "muted", `${category.id === model.activeCategoryId ? "▸" : ""}${clean(category.label)}`)).join("  ");
    const titleLines = wide ? [] : [new TruncatedText(categories, 0, 0), ...(model.searchHidden ? [] : [this.#search(contentInnerWidth)])];
    const top: Component = compact ? new VStack() : new VStack(titleLines);
    const topHeight = compact ? 0 : titleLines.length;
    const actionBudget = Math.max(1, bodyHeight - topHeight - 2);
    const actionWidth = contentInnerWidth;
    const actionLines = this.#actions(actionWidth, compact, actionBudget).render(actionWidth);
    const actionHeight = actionLines.length;
    const fieldsHeight = Math.max(0, bodyHeight - (wide ? Math.max(topHeight, actionHeight) : topHeight + actionHeight));
    const fields = this.#fields(contentInnerWidth, fieldsHeight, compact);
    const toolbar = new VStack([top, new RenderedLines(actionLines)]);
    const form = new VStack([toolbar, fields]);
    let body: Component;
    if (wide) {
      const list = new SelectionList({ items: model.categories, selectedIndex: Math.max(0, model.categories.findIndex((category) => category.id === model.activeCategoryId)),
        height: Math.max(1, Math.min(model.categories.length, bodyHeight - 3)), focused: model.focus === "navigation" }, this.#theme);
      const sidebar = new Box(1, 0, (text) => this.#theme.paint("sidebar", text));
      sidebar.addChild(new VStack([...(model.searchHidden ? [] : [this.#search(20), this.#line("")]), list], { }));
      const sidebarLines = sidebar.render(22);
      const paddedSidebar = new RenderedLines([...sidebarLines, ...Array.from({ length: Math.max(0, bodyHeight - sidebarLines.length) }, () => this.#theme.paint("sidebar", " ".repeat(22)))]);
      const content = new Box(1, 0, (text) => this.#theme.paint("canvas", text));
      content.addChild(form);
      body = new HStack([{ component: paddedSidebar, basis: 22, shrink: 0 }, { component: content, basis: contentWidth, shrink: 0 }], { gap: 1 });
      if (model.focus === "search" && !model.searchHidden && !model.pending) this.#cursor = { row: headerHeight, column: 3 + inputWindow(model.search?.text ?? "", model.search?.cursor ?? 0, 16).column };
    } else {
      const content = new Box(compact ? 0 : 1, 0, (text) => this.#theme.paint("canvas", text));
      content.addChild(form);
      body = content;
      if (model.focus === "search" && !model.searchHidden && !compact && !model.pending) this.#cursor = { row: headerHeight + 1, column: Math.min(width - 1, 3 + inputWindow(model.search?.text ?? "", model.search?.cursor ?? 0, Math.max(1, contentInnerWidth - 4)).column) };
    }
    const bodyLines = body.render(width);
    const result = new VStack([header, new RenderedLines([...bodyLines, ...Array.from({ length: Math.max(0, bodyHeight - bodyLines.length) }, () => this.#theme.paint("canvas", " ".repeat(width)))]), footer]).render(width);
    this.#scrollTop = fields.scroll.scrollTop;
    return this.#finish(result, width, height);
  }
  #finish(lines: string[], width: number, height: number): string[] {
    const result = lines.slice(0, height).map((line) => this.#theme.paint("canvas", pad(
      this.#theme === NEUTRAL_FORM_WORKSPACE_THEME ? stripTerminalSequences(line) : line, width,
    )));
    while (result.length < height) result.push(this.#theme.paint("canvas", " ".repeat(width)));
    return result;
  }
  #formContent(modal: FormWorkspaceForm, width: number, height: number): Component {
    const selectedFeedback = modal.feedback !== undefined && modal.feedback.afterFieldId === modal.selectedFieldId;
    const message = modal.message && height >= (selectedFeedback ? 3 : 2) ? truncateToWidth(clean(modal.message), width, "…") : undefined;
    const viewportHeight = Math.max(1, height - Number(message !== undefined));
    const rows: string[] = [];
    const starts = new Set([0]);
    let selected: { top: number; height: number } | undefined;
    for (const group of modal.groups) {
      if (group.fields.length === 0) continue;
      if (rows.length > 0) rows.push("");
      starts.add(rows.length);
      const title = truncateToWidth(clean(group.title), width, "…");
      rows.push(this.#theme.paint("title", title) + this.#theme.paint("border", " " + "─".repeat(Math.max(0, width - visibleWidth(title) - 1))));
      for (const field of group.fields) {
        const top = rows.length;
        starts.add(top);
        const focused = this.#model.focus !== "actions" && field.id === modal.selectedFieldId;
        const component = new Field(modal.pending ? { ...field, pending: true } : field, focused, this.#theme, true);
        const fieldLines = component.render(width);
        rows.push(...fieldLines);
        const feedback = modal.feedback;
        if (feedback?.afterFieldId === field.id) {
          const symbol = { success: "✓", error: "✕", warning: "!", accent: "…" }[feedback.tone];
          const limit = Math.max(1, Math.min(3, viewportHeight - fieldLines.length));
          const detail = feedback.detail ? wrapTextWithAnsi(clean(feedback.detail), Math.max(1, width - 2)) : [];
          const lines = [truncateToWidth(this.#loading ? `  ${this.#loading.render(2)[0]!.trim()} ${clean(feedback.title)}` : `  ${symbol} ${clean(feedback.title)}`, width, "…"), ...detail.slice(0, limit - 1).map((line) => "  " + line)];
          if (detail.length > limit - 1) {
            const suffix = "… 放大查看";
            lines[lines.length - 1] = truncateToWidth(lines.at(-1)!, Math.max(0, width - visibleWidth(suffix)), "") + suffix;
          }
          rows.push(...lines.map((line, index) => index === 0
            ? this.#theme.paint(feedback.tone, `\x1b[1m${line}\x1b[22m`)
            : this.#theme.paint("muted", line)));
        }
        if (focused) selected = { top, height: rows.length - top };
      }
    }
    if (rows.length === 0) rows.push(this.#theme.paint("muted", this.#model.emptyMessage ?? ""));
    const viewport = new ScrollViewport(new RenderedLines(rows), Math.min(viewportHeight, rows.length), selected, 0);
    const visible = viewport.render(width);
    let trim = 0;
    while (trim < visible.length && !starts.has(viewport.scroll.scrollTop + trim)) trim++;
    return new VStack([
      new RenderedLines([...visible.slice(trim), ...Array.from({ length: trim }, () => "")]),
      ...(message ? [this.#line(message, modal.messageTone ?? "muted")] : []),
    ]);
  }
  #renderModal(width: number, height: number): string[] {
    const modal = this.#model.modal!;
    const panelWidth = modal.kind === "form" ? Math.max(1, width - 2) : modalWidth(width);
    const innerWidth = Math.max(1, panelWidth - 4);
    const blocked = modal.kind === "confirmation" && !fitsFormConfirmation(width, height, modal);
    const help = (blocked ? wrapTextWithAnsi("Esc / q 取消", width) : modalHelp(modal, width)).slice(-height);
    const bodyHeight = Math.max(0, height - help.length);
    const finish = (body: string[]): string[] => this.#finish([
      ...body.slice(0, bodyHeight), ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ""),
      ...help.map((line) => this.#theme.paint("muted", line)),
    ], width, height);
    const children: Component[] = [];
    let cursor: FormWorkspaceCursor | undefined;
    if (modal.kind === "confirmation" && blocked) {
      const cancel = modal.actions[0]?.label ?? "取消";
      const warning = new VStack([this.#line("请放大终端以阅读完整确认内容", "warning"), new Button({ label: cancel, appearance: "plain", focused: true }, this.#theme)]);
      return finish(warning.render(width));
    }
    if (modal.kind !== "form" || height < 10) children.push(modal.kind === "confirmation" ? new Text(this.#theme.paint("title", clean(modal.title)), 0, 0) : this.#line(modal.title, "title"));
    if (modal.kind === "confirmation") {
      children.push(...confirmationContent(modal, innerWidth).map((line) => this.#line(line)));
      const actions = modal.actions.map((action, index) => renderButton({ label: action.label, appearance: "plain", focused: index === modal.selectedIndex }, undefined, this.#theme)).join("  ");
      children.push(new TruncatedText(actions, 0, 0));
    } else if (modal.kind === "form") {
      children.push(this.#formContent(modal, innerWidth, Math.max(1, bodyHeight - (height >= 10 ? 6 : 3))));
    } else if (modal.kind === "dialog") {
      const panelHeight = Math.min(24, bodyHeight);
      const status = modal.message ? wrapTextWithAnsi(clean(modal.message), innerWidth) : [];
      const statusBudget = Math.max(0, panelHeight - 4 - Number(modal.search !== undefined));
      const statusLines = status.slice(0, Math.min(2, statusBudget));
      if (status.length > statusLines.length && statusLines.length > 0) {
        statusLines[statusLines.length - 1] = truncateToWidth(statusLines.at(-1)!, Math.max(0, innerWidth - 1), "") + "…";
      }
      const remaining = panelHeight - 3 - statusLines.length - Number(modal.search !== undefined);
      if (modal.description && remaining > 2) children.push(this.#line(modal.description, "muted"));
      if (modal.search) {
        const inputWidth = Math.max(1, innerWidth - 4);
        const view = inputWindow(modal.search.text, modal.search.cursor, inputWidth);
        if (modal.searchFocused) cursor = { row: children.length + 1, column: 4 + view.column };
        const value = modal.search.text === "" ? clean(modal.search.placeholder ?? "搜索…") : view.text;
        children.push(this.#line(`  ${pad(value, inputWidth)}  `, modal.searchFocused ? "focus" : "control"));
      }
      const listHeight = Math.max(1, Math.min(18, panelHeight - 2 - children.length - statusLines.length));
      children.push(new SelectionList({ items: modal.rows, selectedIndex: modal.selectedIndex, height: listHeight, focused: !modal.searchFocused }, this.#theme));
      children.push(...statusLines.map((line) => this.#line(line, modal.messageTone ?? "muted")));
    } else if (modal.kind === "picker") {
      const showDescription = modal.description && bodyHeight >= 7;
      if (showDescription) children.push(this.#line(modal.description!, "muted"));
      children.push(new SelectionList({ items: modal.options.map((option) => ({ id: option.value, label: option.label, ...(option.description ? { description: option.description } : {}) })),
        selectedIndex: modal.selectedIndex, height: Math.max(1, Math.min(18, bodyHeight - (showDescription ? 5 : 4))) }, this.#theme));
    } else {
      if (modal.description && bodyHeight >= 7) children.push(this.#line(modal.description, "muted"));
      const inputWidth = Math.max(1, innerWidth - 4);
      const view = inputWindow(modal.text, modal.cursor, inputWidth);
      cursor = { row: children.length + 1, column: 4 + view.column };
      children.push(this.#line(`  ${pad(view.text, inputWidth)}  `, "focus"));
      if (modal.error) children.push(this.#line(modal.error, "error"));
    }
    const panel = new Panel(new VStack(children), this.#theme);
    const lines = panel.render(panelWidth);
    if (modal.kind === "form" && height >= 10) {
      const header = this.#theme.paint("title", truncateToWidth(clean(modal.title), width, "…"));
      const toolbar = this.#actions(panelWidth, false, 1).render(panelWidth);
      const body = [header, this.#theme.paint("border", "─".repeat(width)), toolbar[0] ?? "", ...lines.map(line => " " + line)];
      return finish(body);
    }
    const y = Math.max(0, Math.floor((bodyHeight - lines.length) / 2));
    const x = Math.max(0, Math.floor((width - panelWidth) / 2));
    if (cursor && !this.#model.pending && cursor.row + y < bodyHeight) this.#cursor = { row: cursor.row + y, column: Math.min(width - 1, cursor.column + x) };
    return finish([...Array.from({ length: y }, () => ""), ...lines.map((line) => " ".repeat(x) + line)]);
  }
}

class RenderedLines implements Component {
  constructor(readonly lines: readonly string[]) {}
  invalidate(): void {}
  render(width: number): string[] { return this.lines.map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, "")); }
}
