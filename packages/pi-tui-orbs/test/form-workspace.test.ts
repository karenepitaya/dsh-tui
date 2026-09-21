import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { MotionHost } from "../src/motion-host.js";
import { Terminal } from "@xterm/headless";
import { FormWorkspace, fitsFormConfirmation } from "../src/form-workspace.js";
import { FORM_WORKSPACE_STRINGS_ZH, type FormWorkspaceModel } from "../src/form-workspace-model.js";
import { SELECTION_LIST_STRINGS_ZH } from "../src/selection-list.js";

const model: FormWorkspaceModel = {
  header: "DSH 设置", height: 30,
  categories: [
    { id: "general", label: "通用" }, { id: "models", label: "模型与服务" },
    { id: "plugins", label: "插件" }, { id: "agents", label: "Agent 预设" },
  ], activeCategoryId: "general", focus: "content", selectedFieldId: "theme", dirtyCount: 2,
  actions: [{ id: "save", label: "保存" }, { id: "cancel", label: "取消" }],
  help: "↑↓ 移动  Enter 修改  Tab 切换  Ctrl+S 保存  q 退出",
  groups: [{ id: "appearance", title: "外观", fields: [
    { id: "theme", label: "主题", description: "选择终端配色", control: { kind: "select", value: "自动" } },
    { id: "density", label: "显示密度", description: "调整内容之间的间距", control: {
      kind: "segmented", value: "宽松", choices: [{ value: "紧凑", label: "紧凑" }, { value: "宽松", label: "宽松" }],
    } },
    { id: "motion", label: "减少动画", description: "让界面切换更平静", control: { kind: "toggle", value: "开启", checked: true } },
  ] }],
};

const providerForm = () => ({
  kind: "form" as const, title: "团队模型服务", selectedFieldId: "test", hint: "↑↓ 选择   Enter 编辑或执行   Esc / q 返回",
  groups: [
    { id: "connection", title: "连接配置", fields: [
      { id: "name", label: "显示名称", description: "不应堆在表单的长说明", control: { kind: "text" as const, value: "团队网关" } },
      { id: "url", label: "服务地址", control: { kind: "text" as const, value: "https://gateway.example/v1" } },
      { id: "key", label: "API 密钥", badge: "已配置", tone: "success" as const, control: { kind: "action" as const, value: "更换" } },
    ] },
    { id: "testing", title: "连接测试", fields: [
      { id: "model", label: "测试模型", control: { kind: "select" as const, value: "Chat", choices: [{ value: "Chat", label: "Chat" }] } },
      { id: "test", label: "测试连接", intent: "primary" as const, control: { kind: "action" as const, value: "测试连接" } },
    ] },
    { id: "more", title: "更多操作", fields: [
      { id: "advanced", label: "高级设置", control: { kind: "action" as const, value: "高级设置" } },
      { id: "disconnect", label: "断开连接", intent: "danger" as const, control: { kind: "action" as const, value: "断开连接" } },
    ] },
  ],
});

describe("FormWorkspace", () => {
  it("lays out each field once per frame while retaining selection and updates", () => {
    const fields = Array.from({ length: 40 }, (_, index) => ({ id: `field-${index}`, label: `字段 ${index}`, control: { kind: "text" as const, value: `值 ${index}` } }));
    let paints = 0;
    const workspace = new FormWorkspace({ ...model, selectedFieldId: "field-39", groups: [{ id: "all", title: "配置", fields }] }, {
      paint: (role, text) => { if (role === "text" && /^字段 \d+$/u.test(text)) paints++; return text; },
    });
    expect(workspace.render(100).join("\n")).toContain("字段 39");
    expect(paints).toBe(40);
    paints = 0;
    workspace.setModel({ ...model, selectedFieldId: "field-0", groups: [{ id: "all", title: "配置", fields }] });
    expect(workspace.render(100).join("\n")).toContain("字段 0");
    expect(paints).toBe(40);
  });

  it.each([[80, 24], [160, 40]])("renders a grouped provider form with distinct controls in one panel at %sx%s", (width, height) => {
    const lines = new FormWorkspace({ ...model, height, modal: providerForm() }).render(width);
    const text = lines.join("\n");
    for (const label of ["团队模型服务", "连接配置", "连接测试", "更多操作", "API 密钥", "已配置", "更换", "测试连接", "断开连接"]) expect(text).toContain(label);
    expect(text.match(/测试连接/gu)).toHaveLength(1);
    expect(text).toContain("✎");
    expect(text).toContain("▾");
    expect(text).not.toContain("不应堆在表单");
    expect(lines.filter((line) => line.includes("┌"))).toHaveLength(1);
    const border = lines.find((line) => line.includes("┌"))!;
    expect(visibleWidth(border.trim())).toBeLessThanOrEqual(width);
    expect(lines.at(-1)).toContain("Esc / q 返回");
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it.each([
    ["success", "测试通过", "✓", 0x00cc66], ["error", "测试失败", "✕", 0xff4455],
    ["warning", "输出达到限制", "!", 0xffcc00], ["accent", "正在测试", "…", 0x4488ff],
  ] as const)("places bold %s feedback next to the selected test and preserves the state in mono", async (tone, title, symbol, color) => {
    const modal = { ...providerForm(), pending: tone === "accent", feedback: { afterFieldId: "test", tone, title, detail: "本次使用 Chat 模型" } };
    const paint = (role: string, text: string) => role === tone ? `\x1b[38;2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}m${text}\x1b[39m` : text;
    const lines = new FormWorkspace({ ...model, height: 24, modal }, { paint }).render(80);
    const plain = lines.map(stripTerminalSequences);
    const row = plain.findIndex((line) => line.includes(title));
    const button = plain.findIndex((line) => line.includes("测试连接"));
    expect(row).toBe(button + 1);
    expect(plain[row]).toContain(symbol + " " + title);
    expect(plain[row + 1]).toContain("本次使用 Chat 模型");
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
      const column = visibleWidth(plain[row]!.slice(0, plain[row]!.indexOf(title)));
      const cell = terminal.buffer.active.getLine(row)!.getCell(column)!;
      expect(cell.getFgColor()).toBe(color);
      expect(Boolean(cell.isBold())).toBe(true);
    } finally { terminal.dispose(); }
    const mono = new FormWorkspace({ ...model, height: 24, modal }).render(80);
    expect(mono).toEqual(plain);
    expect(mono.join("\n")).toContain(symbol + " " + title);
  });

  it.each([[40, 12], [80, 6]])("keeps the selected action, clipped feedback and return together at %sx%s", (width, height) => {
    const form = providerForm();
    const modal = { ...form, groups: [{ ...form.groups[0]!, fields: Array.from({ length: 30 }, (_, index) => ({ id: `field-${index}`, label: `配置 ${index}`, control: { kind: "text" as const, value: "value" } })) }, ...form.groups.slice(1)],
      feedback: { afterFieldId: "test", tone: "error" as const, title: "测试失败", detail: "很长的失败说明，需要检查地址、凭据和模型。".repeat(20) } };
    const lines = new FormWorkspace({ ...model, height, modal }).render(width);
    const button = lines.findIndex((line) => line.includes("测试连接"));
    expect(button).toBeGreaterThanOrEqual(0);
    expect(lines[button + 1]).toContain("✕ 测试失败");
    expect(lines.join("\n")).toContain("… enlarge");
    expect(lines.at(-1)).toContain("Esc / q 返回");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("keeps primary and destructive form buttons distinct from the credential badge and disables pending actions", () => {
    const calls: { role: string; text: string }[] = [];
    const theme = { paint: (role: string, text: string) => { calls.push({ role, text }); return text; } };
    const workspace = new FormWorkspace({ ...model, height: 24, modal: providerForm() }, theme);
    workspace.render(80);
    expect(calls.some((call) => call.role === "primary" && call.text.includes("测试连接"))).toBe(true);
    expect(calls.some((call) => call.role === "error" && call.text.includes("断开连接"))).toBe(true);
    expect(calls.some((call) => call.role === "success" && call.text.includes("已配置"))).toBe(true);
    expect(calls.some((call) => call.role === "focus" && call.text.includes("已配置"))).toBe(false);
    calls.length = 0;
    workspace.setModel({ ...model, height: 24, modal: { ...providerForm(), pending: true } });
    workspace.render(80);
    expect(calls.some((call) => call.role === "disabled" && call.text.includes("测试连接"))).toBe(true);
    expect(workspace.getCursor()).toBeUndefined();
  });

  it("keeps a form mutation error beside the selected action in a six-line viewport", () => {
    const modal = { ...providerForm(), message: "配置保存失败", messageTone: "error" as const };
    const lines = new FormWorkspace({ ...model, height: 6, modal }).render(80);
    expect(lines.join("\n")).toContain("测试连接");
    expect(lines.join("\n")).toContain("配置保存失败");
    expect(lines.at(-1)).toContain("Esc / q 返回");
  });

  it.each([[40, 12], [80, 6]])("starts the running form on a complete field instead of an orphan credential badge at %sx%s", (width, height) => {
    const form = providerForm();
    const connection = form.groups[0]!;
    const modal = { ...form, title: "DeepSeek", pending: true, hint: "Esc 取消测试",
      groups: [{ ...connection, fields: [connection.fields[2]!, connection.fields[0]!, connection.fields[1]!] }, ...form.groups.slice(1)],
      feedback: { afterFieldId: "test", tone: "accent" as const, title: "正在测试连接…" } };
    const lines = new FormWorkspace({ ...model, height, modal }).render(width);
    const text = lines.join("\n");
    if (text.includes("已配置")) expect(text).toContain("API 密钥");
    expect(lines.find((line) => /^│\s*已配置\s*│$/u.test(line.trim()))).toBeUndefined();
    expect(text).toContain("测试连接");
    const button = lines.findIndex((line) => line.includes("测试连接"));
    expect(lines[button + 1]).toContain("… 正在测试连接…");
    expect(lines.at(-1)).toContain("Esc 取消测试");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("wraps complete shortcut groups and only splits an action when the terminal is narrower than that action", () => {
    for (const gap of ["  ", "   "]) {
      const hint = ["↑↓ 选择", "Enter 打开", "t 测试", "Esc / q 返回"].join(gap);
      const modal = { kind: "dialog" as const, title: "服务", rows: [{ id: "test", label: "测试连接" }], selectedIndex: 0, hint };
      const workspace = new FormWorkspace({ ...model, height: 12, modal });
      const lines = workspace.render(40);
      expect(lines.at(-1)).toContain("Esc / q 返回");
      for (const action of ["↑↓ 选择", "Enter 打开", "t 测试", "Esc / q 返回"]) {
        expect(lines.slice(-2).some((line) => line.includes(action))).toBe(true);
      }
      const tiny = workspace.render(8);
      expect(tiny).toHaveLength(12);
      expect(tiny.every((line) => visibleWidth(line) === 8)).toBe(true);
      expect(tiny.join("").replace(/[\s│]/gu, "")).toContain("Esc/q返回");
    }
  });

  it.each([[40, 12], [80, 24], [160, 50]])("places modal help below the panel at the bottom of %sx%s", (width, height) => {
    const hint = "↑↓ 选择   Enter 确认   Tab 切换   Esc / q 返回";
    const modals: NonNullable<FormWorkspaceModel["modal"]>[] = [
      { kind: "dialog", title: "服务目录", rows: [{ id: "a", label: "服务 A" }], selectedIndex: 0, hint },
      { kind: "picker", title: "选择主题", options: [{ value: "a", label: "主题 A" }], selectedIndex: 0, hint },
      { kind: "editor", title: "编辑名称", text: "中😀X", cursor: 3, hint },
    ];
    for (const modal of modals) {
      const workspace = new FormWorkspace({ ...model, height, modal });
      const lines = workspace.render(width);
      const top = lines.findIndex((line) => line.includes("┌"));
      const bottom = lines.findIndex((line) => line.includes("└"));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThan(height - 1);
      expect(lines.slice(top, bottom + 1).join("\n")).not.toContain("Esc");
      expect(lines.at(-1)).toContain("返回");
      expect(lines.slice(bottom + 1).join("").replace(/\s/gu, "")).toContain(hint.replace(/\s/gu, ""));
      if (modal?.kind === "editor") {
        const cursor = workspace.getCursor()!;
        expect(cursor.row).toBeLessThan(bottom);
        expect(sliceByColumn(lines[cursor.row]!, cursor.column, 1)).toBe("X");
      }
    }
  });

  it.each([[40, 12], [80, 24], [160, 50]])("bounds 38 providers and keeps the last selection visible at %sx%s", (width, height) => {
    const modal = { kind: "dialog" as const, title: "添加提供商", description: "选择模型服务", search: { text: "", cursor: 0 },
      rows: Array.from({ length: 38 }, (_, index) => ({ id: String(index), label: `Provider ${index}` })),
      selectedIndex: 37, hint: "↑↓ 选择   Enter 打开   Esc 返回" };
    const workspace = new FormWorkspace({ ...model, height, modal });
    const lines = workspace.render(width);
    const top = lines.findIndex((line) => line.includes("┌"));
    const bottom = lines.findIndex((line) => line.includes("└"));
    expect(bottom - top + 1).toBeLessThanOrEqual(24);
    expect(lines.filter((line) => line.includes("Provider ")).length).toBeLessThanOrEqual(18);
    expect(lines.join("\n")).toContain("› Provider 37");
    expect(lines.join("\n")).not.toContain("Provider 0 ");
    workspace.setModel({ ...model, height, modal: { ...modal, selectedIndex: 0 } });
    expect(workspace.render(width).join("\n")).toContain("› Provider 0");
  });

  it.each([[40, 12], [80, 24], [160, 50]])("retains group context for same-named providers without adding selectable rows at %sx%s", (width, height) => {
    const rows = Array.from({ length: 38 }, (_, index) => ({ id: `${index < 19 ? "alpha" : "beta"}/${index % 19}`,
      label: `模型 ${index % 19}`, group: `同名服务 (${index < 19 ? "alpha" : "beta"})`, value: `model-${index % 19}` }));
    const modal = { kind: "dialog" as const, title: "选择默认模型", rows, selectedIndex: 0, hint: "Enter 选择   Esc 返回" };
    const workspace = new FormWorkspace({ ...model, height, modal });
    for (const selectedIndex of [0, 18, 19, 37]) {
      workspace.setModel({ ...model, height, modal: { ...modal, selectedIndex } });
      const lines = workspace.render(width);
      const selected = lines.findIndex((line) => line.includes(`› 模型 ${selectedIndex % 19} `));
      expect(selected).toBeGreaterThan(0);
      const group = lines.slice(0, selected).reverse().find((line) => line.includes("同名服务 ("));
      expect(group).toContain(selectedIndex < 19 ? "alpha" : "beta");
      expect(lines.filter((line) => line.includes("› "))).toHaveLength(1);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
  });

  it("paints badges independently from focus and retains their meaning in mono", () => {
    const paints: { role: string; text: string }[] = [];
    const theme = { paint: (role: string, text: string) => { paints.push({ role, text }); return text; } };
    const modal = { kind: "dialog" as const, title: "服务", rows: [
      { id: "a", label: "服务 A", badge: "已配置", tone: "success" as const },
      { id: "b", label: "服务 B", badge: "当前默认", tone: "accent" as const },
    ], selectedIndex: 0, hint: "Esc 返回" };
    const text = new FormWorkspace({ ...model, height: 12, modal }, theme).render(40).join("\n");
    expect(text).toContain("已配置");
    expect(text).toContain("当前默认");
    expect(paints.some((call) => call.role === "success" && call.text.includes("已配置"))).toBe(true);
    expect(paints.some((call) => call.role === "accent" && call.text.includes("当前默认"))).toBe(true);
    expect(paints.some((call) => call.role === "focus" && /已配置|当前默认/u.test(call.text))).toBe(false);
    paints.length = 0;
    const field = { id: "provider", label: "服务 A", badge: "已配置", tone: "success" as const, control: { kind: "action" as const, value: "管理" } };
    const homeModel = { ...model, height: 12, selectedFieldId: field.id, groups: [{ id: "providers", title: "服务", fields: [field] }] };
    const home = new FormWorkspace(homeModel, theme).render(40).join("\n");
    expect(home).toContain("已配置");
    expect(paints.some((call) => call.role === "success" && call.text.includes("已配置"))).toBe(true);
    expect(paints.some((call) => call.role === "focus" && call.text.includes("已配置"))).toBe(false);
    const mono = new FormWorkspace(homeModel).render(40).join("\n");
    expect(mono).toContain("已配置");
    expect(mono).not.toContain("\x1b");
  });

  it("uses the complete footer height in the confirmation fit gate", () => {
    const modal = { kind: "confirmation" as const, title: "确认风险", lines: ["完整风险说明，不允许隐藏末尾。".repeat(3)],
      actions: [{ id: "cancel", label: "取消" }, { id: "accept", label: "确认扩大权限" }], selectedIndex: 0,
      hint: "←→ 选择操作   Enter 确认选择   Esc / q 取消并返回设置" };
    const height = Array.from({ length: 50 }, (_, index) => index + 1).find((rows) => fitsFormConfirmation(40, rows, modal))!;
    const lines = new FormWorkspace({ ...model, height, modal }).render(40);
    const bottom = lines.findIndex((line) => line.includes("└"));
    expect(lines.slice(0, bottom + 1).join("\n")).not.toContain("Esc");
    expect(lines.slice(bottom + 1).join("").replace(/\s/gu, "")).toContain(modal.hint.replace(/\s/gu, ""));
    expect(lines.join("").replace(/[\s│]/gu, "")).toContain(modal.lines[0]);
    expect(fitsFormConfirmation(40, height - 1, modal)).toBe(false);
  });

  it.each([[40, 12], [80, 24], [160, 40]])("renders a directory home without save controls or search at %sx%s", (width, height) => {
    const lines = new FormWorkspace({ ...model, height, actions: [], searchHidden: true,
      headerAction: { label: "n 添加提供商" }, help: "Enter 打开  n 添加  Esc 返回",
    }).render(width);
    const text = lines.join("\n");
    expect(text).toContain("n 添加提供商");
    expect(text).toContain("主题");
    expect(text).not.toContain("搜索设置");
    expect(text).not.toContain("保存更改");
    expect(text).not.toContain("未保存");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("uses caller actions and preserves their disabled state", () => {
    const painted: string[] = [];
    const theme = { paint: (role: string, text: string) => { if (role === "disabled") painted.push(text); return text; } };
    const text = new FormWorkspace({ ...model, actions: [{ id: "add", label: "添加提供商", disabled: true }, { id: "back", label: "返回" }] }, theme).render(80).join("\n");
    expect(text).toContain("添加提供商");
    expect(text).toContain("返回");
    expect(text).not.toContain("保存更改");
    expect(painted).toContain(" 添加提供商 ");
  });

  it.each([[40, 12], [80, 24], [160, 40]])("keeps immediate actions free of implicit saved status at %sx%s", (width, height) => {
    const data = { ...model, height, dirtyCount: 0, actions: [{ id: "add", label: "添加提供商" }] };
    const text = new FormWorkspace(data).render(width).join("\n");
    expect(text).toContain("添加提供商");
    expect(text).not.toContain("已保存");
    expect(new FormWorkspace({ ...data, dirtyCount: 2 }).render(width).join("\n")).toContain("2 unsaved");
    expect(new FormWorkspace({ ...data, message: "设置已更新" }).render(width).join("\n")).toContain("设置已更新");
    const settled = new FormWorkspace({ ...model, height, dirtyCount: 0 }).render(width).join("\n");
    expect(settled).toContain("取消");
    expect(settled).not.toContain("已保存");
  });

  it.each([true, false])("shows an empty dialog search hint with focus=%s and replaces it with entered text", (focused) => {
    const modal = { kind: "dialog" as const, title: "添加提供商", rows: [], selectedIndex: 0, hint: "Esc 返回",
      search: { text: "", cursor: 0, placeholder: "搜索提供商…" }, searchFocused: focused };
    const workspace = new FormWorkspace({ ...model, height: 12, modal });
    const lines = workspace.render(40);
    expect(lines.join("\n")).toContain("搜索提供商…");
    if (focused) {
      const cursor = workspace.getCursor()!;
      expect(sliceByColumn(lines[cursor.row]!, cursor.column, 2)).toBe("搜");
    } else expect(workspace.getCursor()).toBeUndefined();
    workspace.setModel({ ...model, height: 12, modal: { ...modal, search: { ...modal.search, text: "openai", cursor: 6 } } });
    const entered = workspace.render(40).join("\n");
    expect(entered).toContain("openai");
    expect(entered).not.toContain("搜索提供商…");
    workspace.setModel({ ...model, height: 12, modal: { ...modal, search: { text: "", cursor: 0 } } });
    expect(workspace.render(40).join("\n")).toContain("Search…");
  });

  it.each([[40, 12], [80, 24], [160, 40]])("gives dialog values unused label space without hiding the label at %sx%s", (width, height) => {
    const endpoint = "https://gateway.example.com/openai/v1";
    const modal = { kind: "dialog" as const, title: "自定义兼容服务", rows: [
      { id: "address", label: "服务地址", value: endpoint },
      { id: "long", label: "很长的提供商配置字段名称", value: endpoint },
    ], selectedIndex: 0, hint: "Enter 确认   Esc / q 返回" };
    const lines = new FormWorkspace({ ...model, height, modal }).render(width);
    const address = lines.find((line) => line.includes("服务地址"))!;
    expect(address).toContain(width >= 80 ? endpoint : "https://gateway.example");
    expect(lines.join("\n")).toContain("很长的提供商");
    expect(lines.join("\n")).toContain("Esc / q 返回");
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it.each([[40, 12], [80, 24], [160, 40]])("keeps the selected dialog row, status and complete cancellation hint visible at %sx%s", (width, height) => {
    const hint = "↑↓ 选择  Enter 打开  / 搜索  Esc / q 取消";
    const modal = { kind: "dialog" as const, title: "添加提供商", description: "选择已安装的服务，或添加自定义服务。",
      rows: Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, label: `Provider ${index}`, value: `状态 ${index}`, description: `服务说明 ${index}`, disabled: index === 49 })),
      selectedIndex: 49, hint, message: "服务目录已更新", messageTone: "muted" as const,
      search: { text: "", cursor: 0 }, searchFocused: false,
    };
    const workspace = new FormWorkspace({ ...model, height, modal });
    const lines = workspace.render(width);
    const text = lines.join("\n");
    expect(text).toContain("添加提供商");
    expect(text).toContain("Provider 49");
    expect(text).toContain("unavailable");
    expect(text).toContain("服务目录已更新");
    expect(text.replace(/[\s│]/gu, "")).toContain(hint.replace(/\s/gu, ""));
    expect(text).not.toContain("Provider 0 ");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    expect(lines.some((line) => line.includes("\x1b"))).toBe(false);
    const border = lines.find((line) => line.includes("┌"))!;
    expect(visibleWidth(border.trim())).toBeLessThanOrEqual(76);
    expect(border.indexOf("┌")).toBe(Math.floor((width - Math.min(width - (width >= 44 ? 6 : 0), 76)) / 2));
    workspace.setModel({ ...model, height, modal: { ...modal, selectedIndex: 0 } });
    expect(workspace.render(width).join("\n")).toContain("Provider 0");
  });

  it("keeps the dialog search cursor on the visible CJK/emoji character and hides it while pending", () => {
    const text = "中😀文".repeat(30) + "X后文";
    const modal = { kind: "dialog" as const, title: "选择提供商", rows: [], selectedIndex: 0, hint: "Esc / q 取消", search: { text, cursor: text.indexOf("X") }, searchFocused: true };
    const workspace = new FormWorkspace({ ...model, height: 12, modal });
    for (const width of [40, 80, 160]) {
      const lines = workspace.render(width);
      const cursor = workspace.getCursor()!;
      expect(sliceByColumn(lines[cursor.row]!, cursor.column, 1)).toBe("X");
    }
    workspace.setModel({ ...model, height: 12, modal, pending: true });
    workspace.render(40);
    expect(workspace.getCursor()).toBeUndefined();
  });

  it.each(["color", "mono"])("gives both on and off switches a non-color focus cue in a %s terminal", async (mode) => {
    const theme = { paint: (role: string, text: string) => role === "focus"
      ? `\x1b[4m${mode === "color" ? "\x1b[38;2;164;222;197m" : ""}${text}\x1b[24m${mode === "color" ? "\x1b[39m" : ""}` : text };
    for (const checked of [false, true]) {
      const data = { ...model, height: 24, selectedFieldId: "switch", groups: [{ id: "a", title: "交互", fields: [{ id: "switch", label: "减少动画", description: "让界面切换更平静", control: { kind: "toggle" as const, value: checked ? "开启" : "关闭", checked } }] }] };
      for (const focus of ["navigation", "content"] as const) {
        const lines = new FormWorkspace({ ...data, focus }, theme).render(80);
        const marker = checked ? "━━■" : "■──";
        const row = lines.findIndex((line) => stripTerminalSequences(line).includes(marker));
        const column = visibleWidth(stripTerminalSequences(lines[row]!).split(marker)[0]!);
        const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        try {
          await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
          const cell = terminal.buffer.active.getLine(row)!.getCell(column)!;
          expect(Boolean(cell.isUnderline()), `${mode}, checked=${checked}, focus=${focus}`).toBe(focus === "content");
        } finally { terminal.dispose(); }
      }
    }
  });
  it.each([[120, 30], [100, 24], [80, 24], [40, 12]])("keeps a blocked navigation notice beside actions with the first of many fields selected at %sx%s", (width, height) => {
    const fields = Array.from({ length: 40 }, (_, index) => ({ id: `f${index}`, label: `字段${index}`, description: "说明", control: { kind: "text" as const, value: `值${index}` } }));
    const message = "请先保存或取消当前更改，再切换工作区。";
    const lines = new FormWorkspace({ ...model, height, selectedFieldId: "f0", message, groups: [{ id: "all", title: "设置", fields }] }).render(width);
    const visible = lines.map(line => width >= 100 ? sliceByColumn(line, 24, width - 24) : line).join("\n").replace(/[\s│]/gu, "");
    expect(visible).toContain(message);
    expect(visible).toContain("字段0");
    expect(visible).toContain("值0");
    expect(visible).toContain("取消");
    expect(visible.match(/请先保存或取消/gu)).toHaveLength(1);
    expect(visible).not.toContain("2项未保存");
    expect(lines).toHaveLength(height);
  });

  it("measures a long save error before reserving the field viewport and still exposes cancellation in tiny terminals", () => {
    const message = "保存失败：服务暂时不可用。请确认地址与网络连接后重试。".repeat(3) + "错误恢复建议末尾";
    const fields = Array.from({ length: 40 }, (_, index) => ({ id: `f${index}`, label: `字段${index}`, control: { kind: "text" as const, value: `值${index}` } }));
    const workspace = new FormWorkspace({ ...model, height: 24, selectedFieldId: "f0", message, groups: [{ id: "all", title: "设置", fields }] });
    const lines = workspace.render(100);
    const visible = lines.map(line => sliceByColumn(line, 24, 76)).join("\n").replace(/[\s│]/gu, "");
    expect(visible).toContain(message);
    expect(visible).toContain("字段0");
    expect(visible).toContain("取消");
    workspace.setModel({ ...model, height: 6, selectedFieldId: "f0", message, groups: [{ id: "all", title: "设置", fields }] });
    const tiny = workspace.render(80).join("\n");
    expect(tiny).toContain("保存失败");
    expect(tiny).toContain("字段0");
    expect(tiny).toContain("取消");
  });

  it("shows a successful save notice exactly once instead of duplicating the generic saved state", () => {
    const text = new FormWorkspace({ ...model, dirtyCount: 0, message: "所有更改已保存" }).render(120).join("\n");
    expect(text.match(/已保存/gu)).toHaveLength(1);
  });

  it.each([[200, 30], [160, 30], [120, 30], [80, 24], [40, 12], [80, 6]])("fits %sx%s while preserving the current field and save/exit feedback", (width, height) => {
    const workspace = new FormWorkspace({ ...model, height });
    const lines = workspace.render(width);
    const plain = lines.map(stripTerminalSequences).join("\n");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(plain).toContain("主题");
    expect(plain).toContain("自动");
    expect(plain).toContain("unsaved");
    expect(plain).toContain("q");
    expect(lines.some((line) => line.includes("\x1b"))).toBe(false);
  });

  it("keeps descriptions immediately beneath labels, with visible select, segmented and toggle surfaces", () => {
    const lines = new FormWorkspace(model).render(120);
    const labelLine = lines.findIndex((line) => line.includes("主题"));
    expect(lines[labelLine + 1]).toContain("选择终端配色");
    expect(lines.join("\n")).toMatch(/自动\s+▾/u);
    expect(lines.join("\n")).toContain("▸ 宽松");
    expect(lines.join("\n")).toContain("━━■ 开启");
  });

  it("scrolls the selected field into view after model changes and resize", () => {
    const fields = Array.from({ length: 30 }, (_, index) => ({
      id: `field-${index}`, label: `字段 ${index}`, description: `说明 ${index}`,
      control: { kind: "text" as const, value: `值 ${index}` },
    }));
    const workspace = new FormWorkspace({ ...model, height: 12, selectedFieldId: "field-0", groups: [{ id: "all", title: "全部", fields }] });
    workspace.render(80);
    workspace.setModel({ ...model, height: 12, selectedFieldId: "field-29", groups: [{ id: "all", title: "全部", fields }] });
    for (const width of [80, 40, 120]) {
      const text = workspace.render(width).join("\n");
      expect(text).toContain("字段 29");
      expect(text).toContain("值 29");
    }
  });

  it("renders picker selection without applying values and exposes an editor cursor in bounds", () => {
    const workspace = new FormWorkspace({ ...model, height: 12, modal: {
      kind: "picker", title: "选择主题", options: [{ value: "a", label: "浅色" }, { value: "b", label: "深色" }], selectedIndex: 1,
      hint: "↑↓ 选择  Enter 确定  Esc / q 取消",
    } });
    expect(workspace.render(40).join("\n")).toContain("› 深色");
    expect(workspace.getCursor()).toBeUndefined();
    workspace.setModel({ ...model, height: 12, modal: { kind: "editor", title: "修改名称", text: "中😀文".repeat(30), cursor: 120, hint: "Enter 确定  Esc 取消" } });
    const lines = workspace.render(40);
    const cursor = workspace.getCursor();
    expect(cursor).toBeDefined();
    expect(cursor!.row).toBeGreaterThanOrEqual(0);
    expect(cursor!.row).toBeLessThan(lines.length);
    expect(cursor!.column).toBeLessThan(40);
  });

  it("never offers confirmation when the full warning and actions cannot fit", () => {
    const modal = { kind: "confirmation" as const, title: "扩大权限", lines: ["确认后将允许修改工作区以外的文件。".repeat(5)], actions: [{ id: "cancel", label: "取消" }, { id: "allow", label: "确认扩大权限" }], selectedIndex: 1, hint: "←→ 选择  Enter 确认  Esc / q 取消" };
    expect(fitsFormConfirmation(40, 6, modal)).toBe(false);
    const text = new FormWorkspace({ ...model, height: 6, modal }).render(40).join("\n");
    expect(text).toContain("取消");
    expect(text).toContain("Enlarge");
    expect(text).not.toContain("确认扩大权限");
    expect(fitsFormConfirmation(120, 30, modal)).toBe(true);
  });

  it("keeps CJK/emoji editor and search cursors on their actual visible character after horizontal scrolling", () => {
    const text = "中😀文".repeat(30) + "X后文";
    const cursor = text.indexOf("X");
    const workspace = new FormWorkspace({ ...model, height: 12, modal: { kind: "editor", title: "修改", text, cursor, hint: "Enter 确定  Esc 取消" } });
    for (const width of [40, 80, 99, 100, 160, 200]) {
      const lines = workspace.render(width);
      const position = workspace.getCursor()!;
      expect(sliceByColumn(lines[position.row]!, position.column, 1)).toBe("X");
    }
    workspace.setModel({ ...model, height: 12, focus: "search", search: { text, cursor } });
    for (const width of [40, 80, 99, 100, 160, 200]) {
      const lines = workspace.render(width);
      const position = workspace.getCursor()!;
      expect(sliceByColumn(lines[position.row]!, position.column, 1)).toBe("X");
    }
  });

  it("keeps labels outside the active control color and preserves text when a theme is injected", () => {
    const workspace = new FormWorkspace(model, { paint: (role, text) => role === "focus" ? `\x1b[48;2;30;90;70m${text}\x1b[49m` : text });
    const lines = workspace.render(120);
    const line = lines.find((value) => value.includes("主题"))!;
    expect(line.indexOf("主题")).toBeLessThan(line.indexOf("\x1b[48;2;30;90;70m"));
    expect(lines.map(stripTerminalSequences)).toEqual(new FormWorkspace(model).render(120));
    expect(lines.every((value) => visibleWidth(value) === 120)).toBe(true);
  });

  it.each([160, 200])("fills the available form width at %s columns, including the field and action panels", (width) => {
    const lines = new FormWorkspace(model).render(width);
    const panels = lines.filter((line) => line.includes("┌"));
    expect(panels).toHaveLength(1);
    for (const panel of panels) {
      expect(sliceByColumn(panel, 24, 1)).toBe("┌");
      expect(sliceByColumn(panel, width - 2, 2)).toBe("┐ ");
    }
    const field = lines.find((line) => line.includes("主题"))!;
    expect(field).toContain("自动");
    expect(sliceByColumn(field, width - 2, 2)).toBe("│ ");
    const actions = lines.find((line) => line.includes("2 unsaved"))!;
    expect(actions).toContain("2 unsaved");
    expect(actions.trimEnd()).toMatch(/取消$/u);
    expect(lines.indexOf(actions)).toBeLessThan(22);
  });

  it("keeps every category and action on narrow screens", () => {
    const narrow = new FormWorkspace({ ...model, height: 12 }).render(40).join("\n");
    for (const value of [...model.categories.map((category) => category.label), "保存", "取消"]) expect(narrow).toContain(value);
  });

  it("wraps complete descriptions/errors and hides pending input cursors", () => {
    const description = "这是需要完整显示而不能截断的说明，".repeat(3) + "说明末尾";
    const message = "连接失败，请检查服务地址并重试。".repeat(2) + "恢复建议末尾";
    const workspace = new FormWorkspace({ ...model, height: 30, message, groups: [{ id: "a", title: "连接", fields: [{ id: "theme", label: "主机", description, control: { kind: "text", value: "localhost" } }] }] });
    const rendered = workspace.render(100).join("\n");
    expect(rendered).toContain("说明末尾");
    expect(rendered.replace(/[\s│]/gu, "")).toContain("恢复建议末尾");
    for (const overlay of [{ focus: "search" as const, search: { text: "abc", cursor: 2 } }, { modal: { kind: "editor" as const, title: "编辑", text: "abc", cursor: 2, hint: "Enter 确定  Esc 取消" } }]) {
      workspace.setModel({ ...model, ...overlay, pending: true });
      workspace.render(80);
      expect(workspace.getCursor()).toBeUndefined();
    }
  });

  it("sanitizes control sequences and preserves read-only, pending and error states", () => {
    const text = new FormWorkspace({ ...model, writable: false, disabledReason: "只读配置", pending: true,
      groups: [{ id: "a", title: "连接", fields: [{ id: "theme", label: "主机\x1b[2J", description: "服务地址", readonly: true, pending: true, error: "连接失败", control: { kind: "text", value: "localhost\x1b]52;hidden\x07" } }] }],
    }).render(120).join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("只读");
    expect(text).toContain("连接失败");
    expect(text).toContain("pending");
  });
});


it("animates the connection test through Orbs and releases its timer on completion and disposal", () => {
  vi.useFakeTimers();
  const host = new MotionHost(() => {}, { motion: "full", glyphs: "unicode", color: "never", isTTY: true });
  const modal = { ...providerForm(), pending: true, feedback: { afterFieldId: "test", tone: "accent" as const, title: "正在测试连接…" } };
  const workspace = new FormWorkspace({ ...model, modal }, undefined, host);
  try {
    expect(vi.getTimerCount()).toBe(1);
    expect(workspace.render(120).join("\n")).toContain("正在测试连接…");
    workspace.setModel({ ...model, modal });
    expect(vi.getTimerCount()).toBe(1);
    workspace.setModel({ ...model, modal: { ...modal, pending: false, feedback: { ...modal.feedback, tone: "success", title: "连接成功" } } });
    expect(vi.getTimerCount()).toBe(0);
    expect(workspace.render(120).join("\n")).toContain("连接成功");
    workspace.setModel({ ...model, modal });
    workspace.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally { workspace.dispose(); host.dispose(); vi.useRealTimers(); }
});

describe("FormWorkspace list body", () => {
  const rows = (count: number): { id: string; label: string; group: string }[] =>
    Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, group: `组 ${Math.floor(index / 10)}` }));

  it.each([[40, 12], [80, 24], [160, 40]])("renders items, selection and headings instead of groups at %sx%s", (width, height) => {
    const lines = new FormWorkspace({ ...model, height, body: { kind: "list", items: rows(6), selectedIndex: 1 } }).render(width);
    const text = lines.join("\n");
    expect(text).toContain("Row 0");
    expect(text).toContain("› Row 1");
    expect(text).toContain("组 0");
    expect(text).not.toContain("外观");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("prefers the body empty message, then the model empty message, then the built-in fallback", () => {
    const base: FormWorkspaceModel = { ...model, groups: [], body: { kind: "list", items: [], selectedIndex: 0 } };
    const withBody = new FormWorkspace({ ...base, body: { kind: "list", items: [], selectedIndex: 0, emptyMessage: "No entries" } }).render(80).join("\n");
    expect(withBody).toContain("No entries");
    expect(new FormWorkspace({ ...base, emptyMessage: "分类为空" }).render(80).join("\n")).toContain("分类为空");
    expect(new FormWorkspace(base).render(80).join("\n")).toContain("No options");
  });

  it.each(["content", "navigation"] as const)("paints the selected row with the %s focus treatment", (focus) => {
    const calls: { role: string; text: string }[] = [];
    const theme = { paint: (role: string, text: string) => { calls.push({ role, text }); return text; } };
    new FormWorkspace({ ...model, height: 24, focus, body: { kind: "list", items: rows(3), selectedIndex: 0 } }, theme).render(80);
    const expected = focus === "content" ? "focus" : "selected";
    const other = focus === "content" ? "selected" : "focus";
    expect(calls.some((call) => call.role === expected && call.text.includes("Row 0"))).toBe(true);
    expect(calls.some((call) => call.role === other && call.text.includes("Row 0"))).toBe(false);
  });

  it.each([[80, 12], [120, 24]])("bounds a 60-row list body to the content height at %sx%s", (width, height) => {
    const lines = new FormWorkspace({ ...model, height, body: { kind: "list", items: rows(60), selectedIndex: 59 } }).render(width);
    const text = lines.join("\n");
    expect(text).toContain("› Row 59");
    expect(text).not.toContain("Row 0 ");
    expect(lines.filter((line) => /Row \d+/u.test(line)).length).toBeLessThanOrEqual(height - 4);
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  });

  it("honours a per-list disabled label override", () => {
    const items = [{ id: "a", label: "Row A", disabled: true }];
    const fallback = new FormWorkspace({ ...model, height: 12, body: { kind: "list", items, selectedIndex: 0 } }).render(80).join("\n");
    expect(fallback).toContain("unavailable");
    const text = new FormWorkspace({ ...model, height: 12, body: { kind: "list", items, selectedIndex: 0, disabledLabel: SELECTION_LIST_STRINGS_ZH.disabledLabel } }).render(80).join("\n");
    expect(text).toContain("不可用");
    expect(text).not.toContain("unavailable");
  });
});

describe("FormWorkspace strings", () => {
  it("restores the Chinese wording with FORM_WORKSPACE_STRINGS_ZH", () => {
    const home = new FormWorkspace({ ...model, pending: true, writable: false, strings: FORM_WORKSPACE_STRINGS_ZH }).render(80).join("\n");
    expect(home).toContain("q / Esc 返回");
    expect(home).toContain("处理中 · 只读");
    expect(home).not.toContain("pending");
    const dirty = new FormWorkspace({ ...model, dirtyCount: 3, strings: FORM_WORKSPACE_STRINGS_ZH }).render(80).join("\n");
    expect(dirty).toContain("3 项未保存");
    expect(dirty).not.toContain("unsaved");
    const fields = [
      { id: "host", label: "主机", readonly: true, control: { kind: "text" as const, value: "x" } },
      { id: "port", label: "端口", pending: true, control: { kind: "text" as const, value: "y" } },
    ];
    const statuses = new FormWorkspace({ ...model, groups: [{ id: "g", title: "连接", fields }], strings: FORM_WORKSPACE_STRINGS_ZH }).render(80).join("\n");
    expect(statuses).toContain(" · 只读");
    expect(statuses).toContain(" · 处理中");
    const modal = { kind: "confirmation" as const, title: "重置", lines: ["完整风险说明".repeat(10)], actions: [], selectedIndex: 0, hint: "Esc" };
    const blocked = new FormWorkspace({ ...model, height: 6, modal, strings: FORM_WORKSPACE_STRINGS_ZH }).render(40).join("\n");
    expect(blocked).toContain("请放大终端以阅读完整确认内容");
    expect(blocked).toContain("取消");
    expect(blocked).toContain("Esc / q 取消");
    const dialog = { kind: "dialog" as const, title: "提供商", rows: [], selectedIndex: 0, hint: "Esc", search: { text: "", cursor: 0 } };
    expect(new FormWorkspace({ ...model, height: 12, modal: dialog, strings: FORM_WORKSPACE_STRINGS_ZH }).render(40).join("\n")).toContain("搜索…");
    const form = providerForm();
    const feedback = { ...form, feedback: { afterFieldId: "test", tone: "error" as const, title: "失败", detail: "detail ".repeat(80) } };
    expect(new FormWorkspace({ ...model, height: 6, modal: feedback, strings: FORM_WORKSPACE_STRINGS_ZH }).render(80).join("\n")).toContain("… 放大查看");
  });

  it("renders the English built-in wording when strings are absent", () => {
    const home = new FormWorkspace({ ...model, pending: true, writable: false }).render(80).join("\n");
    expect(home).toContain("q / Esc back");
    expect(home).toContain("pending · read-only");
    expect(home).not.toContain("处理中");
    expect(new FormWorkspace({ ...model, dirtyCount: 2 }).render(80).join("\n")).toContain("2 unsaved");
    const fields = [
      { id: "host", label: "Host", readonly: true, control: { kind: "text" as const, value: "x" } },
      { id: "port", label: "Port", pending: true, control: { kind: "text" as const, value: "y" } },
    ];
    const statuses = new FormWorkspace({ ...model, groups: [{ id: "g", title: "Connection", fields }] }).render(80).join("\n");
    expect(statuses).toContain(" · read-only");
    expect(statuses).toContain(" · pending");
    const modal = { kind: "confirmation" as const, title: "Reset", lines: ["Full risk disclosure. ".repeat(10)], actions: [], selectedIndex: 0, hint: "Esc" };
    const blocked = new FormWorkspace({ ...model, height: 6, modal }).render(40).join("\n");
    expect(blocked).toContain("Enlarge the terminal");
    expect(blocked).toContain("Cancel");
    expect(blocked).toContain("Esc / q to cancel");
    const dialog = { kind: "dialog" as const, title: "Providers", rows: [], selectedIndex: 0, hint: "Esc", search: { text: "", cursor: 0 } };
    expect(new FormWorkspace({ ...model, height: 12, modal: dialog }).render(40).join("\n")).toContain("Search…");
    const form = providerForm();
    const feedback = { ...form, feedback: { afterFieldId: "test", tone: "error" as const, title: "Failed", detail: "detail ".repeat(80) } };
    expect(new FormWorkspace({ ...model, height: 6, modal: feedback }).render(80).join("\n")).toContain("… enlarge");
  });
});
