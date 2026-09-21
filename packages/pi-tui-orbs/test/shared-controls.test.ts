import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Button, projectButton, renderButton } from "../src/button.js";
import { SelectionList, projectChoiceRow, SELECTION_LIST_STRINGS_ZH } from "../src/selection-list.js";

describe("shared control projections", () => {
  it("uses one pure button projection for Component and legacy text hosts", () => {
    const model = { label: "测试连接", focused: true, intent: "primary" as const };
    expect(projectButton(model)).toEqual({ text: "› [ 测试连接 ]", role: "primary" });
    const theme = { paint: (_role: string, text: string) => `\x1b[32m${text}\x1b[39m` };
    expect(new Button(model, theme).render(40)).toEqual([renderButton(model, 40, theme)]);
    expect(stripTerminalSequences(renderButton(model, 40, theme))).toBe(projectButton(model).text);
    expect(projectButton({ label: "删除", appearance: "action", focused: true, intent: "danger" })).toEqual({ text: "› 删除", role: "error" });
    expect(projectButton({ label: "保存", appearance: "plain" }).text).toBe(" 保存 ");
  });

  it.each(["button", "plain", "action"] as const)("shows focus without losing primary or danger semantics in %s buttons", (appearance) => {
    for (const intent of ["primary", "danger"] as const) {
      const idle = projectButton({ label: "执行", intent, appearance });
      const focused = projectButton({ label: "执行", intent, appearance, focused: true });
      expect(focused.role).toBe(intent === "danger" ? "error" : "primary");
      expect(focused.text).toContain("›");
      expect(focused.text).not.toBe(idle.text);
    }
  });

  it("makes disabled and busy state authoritative and updates the component", () => {
    const button = new Button({ label: "确认", intent: "danger", disabled: true });
    expect(projectButton({ label: "确认", focused: true, intent: "primary", busy: true }).role).toBe("disabled");
    expect(projectButton({ label: "确认", busy: true }).text).toContain("…");
    expect(button.render(20)).toEqual(["[ 确认 ]"]);
    button.setModel({ label: "取消", appearance: "action", focused: true });
    expect(button.render(20)).toEqual(["› 取消"]);
  });

  it("sanitizes terminal commands and clips CJK without breaking button brackets", () => {
    for (const width of [0, 1, 3, 4, 8, 16, 40]) {
      const line = projectButton({ label: "长标题\x1b[2J\x1b]52;hidden\x07继续" }, width).text;
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toContain("hidden");
      expect(line).not.toContain("\x1b");
      if (width >= 4) expect(line).toMatch(/^\[ .* \]$/u);
    }
    expect(projectButton({ label: "未限宽" }).text).toBe("[ 未限宽 ]");
  });

  it("keeps cursor, checked state and badges separate in the pure choice projection", () => {
    const row = { id: "a", label: "服务", checked: true, kind: "multi" as const, badge: "已配置", tone: "success" as const };
    const spans = projectChoiceRow(row, { selected: true });
    expect(spans[0]).toEqual({ text: "› ☑ 服务", role: "focus" });
    expect(spans[1]).toEqual({ text: " 已配置", role: "success" });
    expect(projectChoiceRow({ ...row, disabled: true }, { selected: true })[0]!.role).toBe("disabled");
    expect(projectChoiceRow({ ...row, checked: false, kind: "radio" }, {})[0]!.text).toContain("○");
    for (const width of [0, 1, 4, 12, 40]) {
      expect(visibleWidth(projectChoiceRow(row, { width, selected: true }).map((span) => span.text).join(""))).toBeLessThanOrEqual(width);
    }
  });
});

describe("SelectionList", () => {
  it("keeps one-row, empty and zero-sized viewports bounded and updates theme without retaining old rows", () => {
    const items = [{ id: "a", label: "模型\x1b[2J", group: "服务", description: "详情", badge: "默认", checked: false, kind: "multi" as const }];
    const list = new SelectionList({ items, selectedIndex: 0, height: 1, focused: false });
    expect(list.render(30)).toEqual(["› ☐ 模型 默认"]);
    expect(list.render(0)).toEqual([]);
    list.setModel({ items: [], selectedIndex: 0, height: 1, emptyMessage: "无结果" });
    list.setTheme({ paint: (_role, text) => `\x1b[32m${text}\x1b[39m` });
    expect(list.render(30).map(stripTerminalSequences)).toEqual(["无结果"]);
    list.setModel({ items, selectedIndex: 0, height: 0 });
    expect(list.render(30)).toEqual([]);
  });

  it.each([3, 8, 18])("keeps the selected row and its provider group in a %s-row viewport", (height) => {
    const items = Array.from({ length: 38 }, (_, index) => ({ id: `${index}`, label: `模型 ${index % 19}`, group: index < 19 ? "同名服务 (alpha)" : "同名服务 (beta)", description: `说明 ${index}`, ...(index === 37 ? { badge: "当前默认" } : {}), tone: "accent" as const }));
    const list = new SelectionList({ items, selectedIndex: 37, height });
    const lines = list.render(40);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.join("\n")).toContain("› 模型 18");
    expect(lines.join("\n")).toContain("同名服务 (beta)");
    expect(lines.join("\n")).toContain("当前默认");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    list.setModel({ items, selectedIndex: 0, height });
    expect(list.render(40).join("\n")).toContain("同名服务 (alpha)");
  });

  it("paints only visible rows and preserves badge semantics in mono and color", () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({ id: `${index}`, label: `Provider ${index}`, badge: "已配置", tone: "success" as const }));
    const calls: string[] = [];
    const colored = new SelectionList({ items, selectedIndex: 999, height: 8 }, { paint: (role, text) => { calls.push(role); return role === "success" ? `\x1b[32m${text}\x1b[39m` : text; } });
    const lines = colored.render(40);
    expect(calls.length).toBeLessThanOrEqual(16);
    expect(lines.map(stripTerminalSequences)).toEqual(new SelectionList({ items, selectedIndex: 999, height: 8 }).render(40));
    expect(calls).toContain("success");
  });

  it("pins a sticky group heading when the viewport scrolls past it", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `${index}`, label: `Row ${index}`, group: "Alpha" }));
    const lines = new SelectionList({ items, selectedIndex: 5, height: 3 }).render(20);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Alpha");
    expect(lines.join("\n")).toContain("› Row 5");
  });

  it("clamps description lines when the viewport height is one", () => {
    const items = [{ id: "a", label: "模型", description: "不应出现" }];
    expect(new SelectionList({ items, selectedIndex: 0, height: 1 }).render(30)).toEqual(["› 模型"]);
  });

  it("clamps an out-of-range selectedIndex to the nearest row", () => {
    const items = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
    expect(new SelectionList({ items, selectedIndex: 99, height: 3 }).render(20).join("\n")).toContain("› C");
    expect(new SelectionList({ items, selectedIndex: -2, height: 3 }).render(20).join("\n")).toContain("› A");
  });

  it("renders only the viewport height from a hundred rows", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `${index}`, label: `Item ${index}` }));
    const lines = new SelectionList({ items, selectedIndex: 50, height: 5 }).render(30);
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("› Item 50");
    expect(lines.filter((line) => line.includes("Item"))).toHaveLength(5);
  });

  it("replaces the disabled suffix with a caller-provided label", () => {
    const item = { id: "a", label: "服务", disabled: true };
    expect(projectChoiceRow(item, {})[0]!.text).toContain("unavailable");
    expect(projectChoiceRow(item, { disabledLabel: "不可用" })[0]!.text).toContain("不可用");
    const lines = new SelectionList({ items: [item], selectedIndex: 0, height: 2, disabledLabel: SELECTION_LIST_STRINGS_ZH.disabledLabel }).render(30);
    expect(lines.join("\n")).toContain("不可用");
    expect(lines.join("\n")).not.toContain("unavailable");
  });
});
