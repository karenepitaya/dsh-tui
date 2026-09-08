import {
  Box, HStack, ScrollView, SelectList, Text, TruncatedText, VStack,
  stripTerminalSequences, truncateToWidth, visibleWidth,
  wrapTextWithAnsi, type Component, type SelectListTheme,
} from "@earendil-works/pi-tui";
import { ChoiceControl, ToggleControl } from "./lab-controls.js";
import {
  NEUTRAL_SETTINGS_WORKSPACE_THEME,
  type SettingsWorkspaceConfirmation, type SettingsWorkspaceCursor,
  type SettingsWorkspaceField, type SettingsWorkspaceForm, type SettingsWorkspaceModel, type SettingsWorkspaceRole,
  type SettingsWorkspaceTheme, type SettingsWorkspaceModal,
} from "./settings-workspace-model.js";

const clean = (value: string): string => stripTerminalSequences(value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
const size = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const pad = (text: string, width: number): string => {
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
  constructor(child: Component, readonly theme: SettingsWorkspaceTheme, readonly role: SettingsWorkspaceRole = "panel") {
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
  constructor(readonly field: SettingsWorkspaceField, readonly focused: boolean, readonly theme: SettingsWorkspaceTheme, readonly form = false) {}
  invalidate(): void {}
  render(width: number): string[] {
    const { field, focused, theme } = this;
    const text = (role: SettingsWorkspaceRole, value: string): string => theme.paint(role, clean(value));
    const status = this.form ? "" : field.pending ? " · 处理中" : field.readonly ? " · 只读" : field.changed ? " ·" : "";
    const inputWidth = this.form ? Math.max(14, width - Math.min(22, Math.max(10, Math.ceil(width * 0.3))) - 2)
      : Math.min(Math.max(14, Math.ceil(width * 0.39)), Math.max(14, width - 13));
    const labelWidth = width < 28 ? width : width - inputWidth - 2;
    const prefix = this.form ? text(focused ? "focus" : "muted", focused ? "› " : "  ") : "";
    const labelText = prefix + text("text", field.label) + text("muted", status);
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
    if (this.form && control.kind === "action") {
      const role = field.readonly || field.pending ? "disabled" : field.intent === "danger" ? "error"
        : field.intent === "primary" ? "primary" : focused ? "focus" : "button";
      const button = text(role, `[ ${control.value || field.label} ]`);
      if (control.value === field.label) return new RenderedLines([prefix + button + (badge ? " " + badge : "")]).render(width);
      input = new TruncatedText(button, 0, 0);
    } else if (this.form && control.kind === "text") {
      const slotWidth = width < 28 ? width : inputWidth;
      const value = pad(truncateToWidth(clean(control.value) || "—", Math.max(0, slotWidth - 6), "…"), Math.max(0, slotWidth - 6));
      input = new TruncatedText(paint(`│ ${value} ✎ │`, focused ? "high" : "label"), 0, 0);
    } else if (control.kind === "toggle") {
      input = new ToggleControl({ ...options, value: control.checked ?? false, appearance: "switch", onLabel: clean(control.value) || "开启", offLabel: clean(control.value) || "关闭" });
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
function confirmationContent(modal: SettingsWorkspaceConfirmation, width: number): string[] {
  return modal.lines.flatMap((line) => wrapTextWithAnsi(clean(line), Math.max(1, width)));
}

function modalHelp(modal: SettingsWorkspaceModal, width: number): string[] {
  const hint = modal.hint ?? (modal.kind === "confirmation" ? "←→ 选择  Enter 确认  Esc / q 取消"
    : modal.kind === "picker" ? "↑↓ 选择  Enter 确定  Esc / q 取消" : "Enter 确定  Esc 取消");
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
export function fitsSettingsConfirmation(width: number, height: number, modal: SettingsWorkspaceConfirmation): boolean {
  const inner = modalWidth(size(width)) - 4;
  if (inner < 20 || size(height) < 7) return false;
  const actions = modal.actions.map((action) => ` ${clean(action.label)} `).join("  ");
  const titleHeight = wrapTextWithAnsi(clean(modal.title), inner).length;
  return visibleWidth(actions) <= inner
    && confirmationContent(modal, inner).length + titleHeight + 3 + modalHelp(modal, size(width)).length <= size(height);
}

/** Presentation-only settings surface composed from pi-tui containers and Orbs inputs. */
export class SettingsWorkspace implements Component {
  #model: SettingsWorkspaceModel;
  #theme: SettingsWorkspaceTheme;
  #cursor: SettingsWorkspaceCursor | undefined;
  #scrollTop = 0;
  constructor(model: SettingsWorkspaceModel, theme: SettingsWorkspaceTheme = NEUTRAL_SETTINGS_WORKSPACE_THEME) {
    this.#model = model;
    this.#theme = theme;
  }
  setModel(model: SettingsWorkspaceModel): void {
    if (model.activeCategoryId !== this.#model.activeCategoryId) this.#scrollTop = 0;
    this.#model = model;
    this.invalidate();
  }
  setTheme(theme: SettingsWorkspaceTheme): void { this.#theme = theme; this.invalidate(); }
  getCursor(): SettingsWorkspaceCursor | undefined { return this.#cursor; }
  invalidate(): void { this.#cursor = undefined; }
  #line(value: string, role: SettingsWorkspaceRole = "text"): Component {
    return new TruncatedText(this.#theme.paint(role, clean(value)), 0, 0);
  }
  #listTheme(): SelectListTheme {
    return {
      selectedPrefix: (value) => this.#theme.paint("accent", value),
      selectedText: (value) => this.#theme.paint("focus", value),
      description: (value) => this.#theme.paint("muted", value),
      scrollInfo: (value) => this.#theme.paint("muted", value),
      noMatch: (value) => this.#theme.paint("muted", value),
    };
  }
  #actions(width: number, compact: boolean, maxHeight: number): Component {
    const model = this.#model;
    const disabled = model.pending || model.writable === false;
    const state = model.pending ? "处理中" : model.dirtyCount > 0 ? `${model.dirtyCount} 项未保存` : model.actions === undefined ? "已保存" : "";
    const reason = model.disabledReason ?? (model.writable === false ? "只读" : "");
    const notice = clean(model.message ?? state);
    const message = `${notice}${reason && !notice.includes(reason) ? `${notice ? " · " : ""}${clean(reason)}` : ""}`;
    if (model.actions?.length === 0) return model.message || reason
      ? new Text(this.#theme.paint(model.messageTone ?? "muted", clean(model.message ?? reason)), 0, 0)
      : new RenderedLines([]);
    const actionEntries = model.actions ?? (compact ? ["保存", "取消", "重置"] : ["保存更改", "取消", "恢复默认"])
      .map((label, index) => ({ label, disabled: index === 0 && disabled }));
    const actions = actionEntries.map((action, index) => this.#theme.paint(
      action.disabled ? "disabled" : model.focus === "actions" && (model.actionIndex ?? 0) === index ? "focus" : index === 0 ? "primary" : index === 1 ? "button" : "muted",
      ` ${clean(action.label)} `,
    )).join(" ");
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
        const fieldHeight = component.render(compact ? width : Math.max(1, width - 4)).length;
        if (field.id === this.#model.selectedFieldId) selected = { top: top + (compact ? 0 : 1) + fieldTop, height: fieldHeight };
        fields.push(component);
        fieldTop += fieldHeight + (compact ? 0 : 1);
      }
      const content = new VStack(fields, { gap: compact ? 0 : 1 });
      const panel = compact ? content : new Panel(content, this.#theme);
      entries.push(panel);
      top += panel.render(width).length;
      if (!compact) { entries.push(this.#line("")); top += 1; }
    }
    if (!entries.length) entries.push(this.#line(this.#model.emptyMessage ?? "暂无可用设置", "muted"));
    const content = new VStack(entries);
    return new ScrollViewport(content, Math.min(height, content.render(width).length), selected, this.#scrollTop);
  }
  #search(width: number): Component {
    const search = this.#model.search;
    const value = search?.text ? inputWindow(search.text, search.cursor, Math.max(1, width - 4)).text : "/ 搜索设置";
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
      { component: this.#line(model.header ?? "设置", "title"), grow: 1 },
      { component: this.#line(headerAction, model.headerAction ? "accent" : "muted"), basis: Math.max(14, visibleWidth(clean(headerAction))), shrink: 0 },
    ]);
    const header = compact ? heading : new VStack([heading, this.#line("─".repeat(width), "border")]);
    const headerHeight = compact ? 1 : 2;
    const footer = this.#line(model.help ?? "↑↓ 移动  Enter 修改  Tab 切换  Ctrl+S 保存  q 退出", "muted");
    const bodyHeight = Math.max(0, height - headerHeight - 1);
    const contentWidth = wide ? width - 23 : width;
    const contentInnerWidth = Math.max(1, contentWidth - (compact ? 0 : 2));
    const title = new HStack([{ component: this.#line(model.title, "title"), grow: 1 }, { component: this.#line(model.scope ?? "", "muted"), basis: Math.min(12, Math.floor(contentInnerWidth / 3)) }]);
    const categories = model.categories.map((category) => this.#theme.paint(category.id === model.activeCategoryId ? "accent" : "muted", `${category.id === model.activeCategoryId ? "▸" : ""}${clean(category.label)}`)).join("  ");
    const top: Component = compact ? new VStack() : new VStack(wide ? [
      title, this.#line(model.subtitle ?? "调整当前分类的偏好设置", "muted"),
    ] : [new TruncatedText(categories, 0, 0), title, ...(model.searchHidden ? [] : [this.#search(contentInnerWidth)])]);
    const topHeight = compact ? 0 : wide ? 2 : model.searchHidden ? 2 : 3;
    const actionBorder = !compact && contentInnerWidth >= 48 && model.actions?.length !== 0 ? 2 : 0;
    const actionBudget = Math.max(1, bodyHeight - topHeight - 2 - actionBorder);
    const actions = this.#actions(contentInnerWidth - (actionBorder ? 4 : 0), compact, actionBudget);
    const actionArea = actionBorder ? new Panel(actions, this.#theme) : actions;
    const actionHeight = actionArea.render(contentInnerWidth).length;
    const fieldsHeight = Math.max(0, bodyHeight - topHeight - actionHeight);
    const fields = this.#fields(contentInnerWidth, fieldsHeight, compact);
    const form = new VStack([top, fields, actionArea]);
    let body: Component;
    if (wide) {
      const list = new SelectList(model.categories.map((category) => ({ value: clean(category.id), label: clean(category.label) })), Math.max(1, Math.min(model.categories.length, bodyHeight - 3)), this.#listTheme());
      list.setSelectedIndex(Math.max(0, model.categories.findIndex((category) => category.id === model.activeCategoryId)));
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
      if (model.focus === "search" && !model.searchHidden && !compact && !model.pending) this.#cursor = { row: headerHeight + 2, column: Math.min(width - 1, 3 + inputWindow(model.search?.text ?? "", model.search?.cursor ?? 0, Math.max(1, contentInnerWidth - 4)).column) };
    }
    const bodyLines = body.render(width);
    const result = new VStack([header, new RenderedLines([...bodyLines, ...Array.from({ length: Math.max(0, bodyHeight - bodyLines.length) }, () => this.#theme.paint("canvas", " ".repeat(width)))]), footer]).render(width);
    this.#scrollTop = fields.scroll.scrollTop;
    return this.#finish(result, width, height);
  }
  #finish(lines: string[], width: number, height: number): string[] {
    const result = lines.slice(0, height).map((line) => this.#theme.paint("canvas", pad(
      this.#theme === NEUTRAL_SETTINGS_WORKSPACE_THEME ? stripTerminalSequences(line) : line, width,
    )));
    while (result.length < height) result.push(this.#theme.paint("canvas", " ".repeat(width)));
    return result;
  }
  #formContent(modal: SettingsWorkspaceForm, width: number, height: number): Component {
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
        const focused = field.id === modal.selectedFieldId;
        const component = new Field(modal.pending ? { ...field, pending: true } : field, focused, this.#theme, true);
        const fieldLines = component.render(width);
        rows.push(...fieldLines);
        const feedback = modal.feedback;
        if (feedback?.afterFieldId === field.id) {
          const symbol = { success: "✓", error: "✕", warning: "!", accent: "…" }[feedback.tone];
          const limit = Math.max(1, Math.min(3, viewportHeight - fieldLines.length));
          const detail = feedback.detail ? wrapTextWithAnsi(clean(feedback.detail), Math.max(1, width - 2)) : [];
          const lines = [truncateToWidth(`  ${symbol} ${clean(feedback.title)}`, width, "…"), ...detail.slice(0, limit - 1).map((line) => "  " + line)];
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
    if (rows.length === 0) rows.push(this.#theme.paint("muted", this.#model.emptyMessage ?? "暂无可用设置"));
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
    const panelWidth = modalWidth(width);
    const innerWidth = Math.max(1, panelWidth - 4);
    const blocked = modal.kind === "confirmation" && !fitsSettingsConfirmation(width, height, modal);
    const help = (blocked ? wrapTextWithAnsi("Esc / q 取消", width) : modalHelp(modal, width)).slice(-height);
    const bodyHeight = Math.max(0, height - help.length);
    const finish = (body: string[]): string[] => this.#finish([
      ...body.slice(0, bodyHeight), ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ""),
      ...help.map((line) => this.#theme.paint("muted", line)),
    ], width, height);
    const children: Component[] = [];
    let cursor: SettingsWorkspaceCursor | undefined;
    if (modal.kind === "confirmation" && blocked) {
      const cancel = modal.actions[0]?.label ?? "取消";
      const warning = new VStack([this.#line("请放大终端以阅读完整确认内容", "warning"), this.#line(` ${cancel} `, "focus")]);
      return finish(warning.render(width));
    }
    children.push(modal.kind === "confirmation" ? new Text(this.#theme.paint("title", clean(modal.title)), 0, 0) : this.#line(modal.title, "title"));
    if (modal.kind === "confirmation") {
      children.push(...confirmationContent(modal, innerWidth).map((line) => this.#line(line)));
      const actions = modal.actions.map((action, index) => this.#theme.paint(index === modal.selectedIndex ? "focus" : "button", ` ${clean(action.label)} `)).join("  ");
      children.push(new TruncatedText(actions, 0, 0));
    } else if (modal.kind === "form") {
      children.push(this.#formContent(modal, innerWidth, Math.max(1, Math.min(24, bodyHeight) - 3)));
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
      const rows: string[] = [];
      const groups: (string | undefined)[] = [];
      const headings = new Set<number>();
      let selected: { top: number; height: number } | undefined;
      for (const [index, row] of modal.rows.entries()) {
        if (row.group && row.group !== modal.rows[index - 1]?.group) {
          headings.add(rows.length);
          rows.push(this.#theme.paint("muted", truncateToWidth(clean(row.group), innerWidth, "…")));
          groups.push(row.group);
        }
        const top = rows.length;
        const prefix = index === modal.selectedIndex ? "› " : "  ";
        const disabled = row.disabled ? " · 不可用" : "";
        const badge = row.badge ? ` ${truncateToWidth(clean(row.badge), Math.max(0, innerWidth - visibleWidth(prefix + disabled) - 8), "…")}` : "";
        const available = Math.max(0, innerWidth - visibleWidth(prefix + disabled + badge) - 2);
        const labelMinimum = Math.min(visibleWidth(clean(row.label)), Math.ceil(available / 2));
        const value = row.value ? `  ${truncateToWidth(clean(row.value), available - labelMinimum, "…")}` : "";
        const label = truncateToWidth(clean(row.label), Math.max(1, innerWidth - visibleWidth(prefix + disabled + value + badge)), "…");
        rows.push(this.#theme.paint(row.disabled ? "disabled" : index === modal.selectedIndex ? modal.searchFocused ? "selected" : "focus" : "text", prefix + label + disabled + value)
          + (badge ? this.#theme.paint(row.tone ?? "muted", badge) : ""));
        groups.push(row.group);
        if (row.description && listHeight > 1) {
          rows.push(this.#theme.paint("muted", truncateToWidth(`  ${clean(row.description)}`, innerWidth, "…")));
          groups.push(row.group);
        }
        if (index === modal.selectedIndex) selected = { top, height: rows.length - top };
      }
      if (rows.length === 0) rows.push(this.#theme.paint("muted", "没有可选项"));
      let viewport = new ScrollViewport(new RenderedLines(rows), Math.min(listHeight, rows.length), selected, 0);
      let visible = viewport.render(innerWidth);
      const start = viewport.scroll.scrollTop;
      if (listHeight > 1 && start > 0 && groups[start] && !headings.has(start)) {
        viewport = new ScrollViewport(new RenderedLines(rows), listHeight - 1, selected, 0);
        visible = viewport.render(innerWidth);
        const group = groups[viewport.scroll.scrollTop];
        if (group && !headings.has(viewport.scroll.scrollTop)) visible.unshift(this.#theme.paint("muted", truncateToWidth(clean(group), innerWidth, "…")));
      }
      children.push(new RenderedLines(visible));
      children.push(...statusLines.map((line) => this.#line(line, modal.messageTone ?? "muted")));
    } else if (modal.kind === "picker") {
      const showDescription = modal.description && bodyHeight >= 7;
      if (showDescription) children.push(this.#line(modal.description!, "muted"));
      const list = new SelectList(modal.options.map((option) => ({ value: clean(option.value), label: clean(option.label), ...(option.description ? { description: clean(option.description) } : {}) })), Math.max(1, bodyHeight - (showDescription ? 5 : 4)), this.#listTheme(), { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 28 });
      list.setSelectedIndex(modal.selectedIndex);
      children.push(modal.options.length ? list : this.#line("没有可选项", "muted"));
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
    const y = Math.max(0, Math.floor((bodyHeight - lines.length) / 2));
    const x = Math.max(0, Math.floor((width - panelWidth) / 2));
    if (cursor && !this.#model.pending && cursor.row + y < bodyHeight) this.#cursor = { row: cursor.row + y, column: Math.min(width - 1, cursor.column + x) };
    return finish([...Array.from({ length: y }, () => ""), ...lines.map((line) => " ".repeat(x) + line)]);
  }
}

class RenderedLines implements Component {
  constructor(readonly lines: readonly string[]) {}
  invalidate(): void {}
  render(width: number): string[] { return this.lines.map((line) => truncateToWidth(line, width, "")); }
}
