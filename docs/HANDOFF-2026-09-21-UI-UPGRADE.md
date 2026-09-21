# HANDOFF 2026-09-21 — UI 升级（向 /settings 看齐）

> 本文档已更新。原始 handoff 见 git 历史 `ff8a89b`。

## 已完成（已提交 main）

以下 5 个 commit 已合并 main（`8ae48f1` 为最新）：

### 1. Orbs 包增强（`83ec03d`）

**列表主体**：`FormWorkspaceModel.body?: FormWorkspaceListBody`（`kind: "list"`, `items`, `selectedIndex`, `emptyMessage?`, `disabledLabel?`），内容区渲染有界 `SelectionList`，替代 groups/fields；缺省不传则行为不变。

**字符串外置**：`FormWorkspaceStrings` 9 个键，默认值改英文（`pending` / `read-only` / `N unsaved` / `… enlarge` / `q / Esc back` / `Cancel` / `Esc / q to cancel` / `Search…`）。导出 `FORM_WORKSPACE_STRINGS_ZH` 中文预设。`SelectionList` 默认 `No options` / `unavailable`，导出 `SELECTION_LIST_STRINGS_ZH`。

**Theme 收敛**：`FormWorkspaceRole = ControlRole | FormWorkspaceSurfaceRole`（联合成员不变，零破坏）。`LabControlTheme` **彻底删除**（别名 + @deprecated 注释 + index 导出 + README 引用全部移除），standalone lab controls 改用 `OrbThemeName | OrbTheme` 内联联合。

**桥接函数导出**：`cleanControlText` / `clipControlText` / `clipControlSpans` / `controlWidth` 进 `index.ts`，消除 README 文实漂移。

**新增**：`examples/form-lab.ts`（表单页 + 64 行列表页 + confirmation modal 三类目），`demo:form` 脚本；SelectionList 测试 +5（sticky heading / clamp / bounding / disabled override），FormWorkspace 测试 +14（list body / strings / zh regression）。

### 2. UI 语言偏好（`633f9be`）

新增持久化偏好 `uiLanguage: 'en' | 'zh'`（默认 `en`），schemastery schema → codec（additive，版本不升）→ settings 页面「外观」组 segmented 控件（`语言` / `English` / `中文`）。`src/ui/form-workspace-strings.ts` 提供 `formWorkspaceStrings(lang)` 纯函数，两个 frame builder（settings + providers）通过 `uiLanguage` → `view` → builder → `model.strings` 注入。父仓库 4 处测试钉 + e2e 钉翻转为英文。

### 3. `/capabilities` 迁移（`56f8433`）

**Seam**：`renderDshFrame`（`src/ui/frame.ts:2044-2051`）分支 → `src/ui/capabilities-frame.ts` builder；状态经 content region node 的 `capabilitiesStateSource` 读取；`deferLayout` 双路径（settings 同构）。

**页面形态**：categories = Skills N / Tools N / MCP N（侧栏或顶部 tab），body 有界列表（MCP 按服务器分组，skills 按来源分组），搜索框，`Enter` → 只读 form modal（`projectCapabilitiesDetails`），`q`/Esc 先关 modal 再关页面。

**顺手修复**：MCP tab 的 `0 tools available in this session` 串台文案随旧 nodes 头行删除；空态改为可执行的 `No MCP servers configured — manage providers in /settings`。footer 统一为单行 `[/] tabs · ↑↓ select · Enter details · / search · r refresh · q back`。

**通用基建**：feature keymap 现在允许绑定 `escape`（无 overlay 时优先于 `navigation.back`），后续页面直接受益。

### 4. `/activity` 迁移（`88a5d38`）

**页面形态**：Jobs N / Subagents N / Workflows N 三标签（含 live 计数），列表保留状态 glyph + lineage spine，`K`/Delete → confirmation modal（cancel-first），`Enter` → 只读 form modal（`projectActivityDetails`）。

**顺手修复**：旧 footer 双 `Esc back` bug 消失（hint 堆叠逻辑随旧 renderer 删除）。

### 5. `/sessions` 迁移（`8ae48f1`）

**页面形态**：单分类 `Sessions N`，有界列表（badge: current/idle/saved/subagent，description: path），搜索框，`Enter` → 只读 form modal（`projectSessionDetails`，含 inspection 回放），`a` resume / `f` fork → confirmation modal（旧 `operationRows` 删除，事务语义逐字节不变）。120 行 bounding 测试。

**顺手修复**：旧 inspector panel、content panel、operationRows 全部删除；navigator node 保留为 fallback + state anchor。

## 已验证（代码就位，e2e 全绿）

### 6. `/models` 迁移（完成）

**文件**：`src/ui/models-frame.ts`，`tests/models-frame.spec.ts`（6 测试），factory keymap（`q` → `models.back` → `openRoute('chat')`，`h`/`l` 移除）。

**页面形态**：单分类 `Models N`，列表 `label` = modelName / `value` = providerName / badge = current/default/retained/unroutable，选中行 description 显示 `Reasoning {level}`（←/→ 编辑），`Enter` apply，`Ctrl+S` set default。

**修复（2026-09-21 深夜）**：e2e `reasoning changes without applying the model` 90s 超时的根因是 `models-form` 的 description 规则用 `choice.key === state.selectedKey` 判断选中行，但 `projectModelRows` 返回的是模型级代表 choice（默认 effort），切到非默认 effort 后 key 永不相等，`Reasoning Low` 永不显示。修复：按 `selectedIndex` 定位选中行、按 provider+model 匹配选中 effort choice（`selectedModelsChoice`），effort 名从该 choice 取。

### 7. `/modes` 迁移（完成）

**文件**：`src/ui/modes-frame.ts`，`tests/modes-frame.spec.ts`（6 测试），factory `q` keymap。

**页面形态**：单分类 `Modes N`，列表 `label` = name / `value` = trust，badge = current/default/broken，`Enter` choose，`r` refresh。

**修复（2026-09-21 深夜）**：e2e `started-session Modes Feature lock` 超时的根因是 `statusMessage` 的 if 链中 `locked` 分支独占 message，丢掉了 `Current {mode}`；旧 renderer 两行都渲染。修复：locked 时 message 追加 `· Current {mode}`。

### 8. `/diff` 删除（完成）

`/diff` 不在有效命令单中，整个 Diff workspace 已移除：`src/features/diff/`、`diff-entry.ts`、`composition/diff-plugin.ts`、`dsh/diff-workspace.ts`（DSH_SESSION_DIFF_WORKSPACE capability）、`NavigationState` 的 `diff` 路由、`layout/strategy.ts` diff 分支、cordis.patch.yml 的 `dsh-tui-diff` 行、profile-policy rows、import/loader 冒烟、e2e lane（改为断言 `/diff` 不再路由并退回 Session prompt）。`NavigationRoute` 收窄为 `ChatRoute | WorkspaceRoute`。

### 9. `/status` 迁移（完成）

`src/ui/status-frame.ts`：`statusFormModel` + `renderStatusFormFrame` + `statusDetailRows`/`statusDetailViewport`。三分区（Context / Request recovery / Model route）以 `body: list` 渲染（每行一个 item，复用旧 `workspace-context` / `workspace-request-recovery` / `workspace-model-route` 行投影），页脚 `↑↓ move · Enter / Esc / q close`。控制器滚轮经 `statusPanelOffset` → `scrollOffset`（`legacyDetailViewport` 包裹行窗口）切片；`renderDshFrame` statusPanel 分支改走新 frame；旧 `src/ui/workspace-status.ts` 已删除。e2e 新增 `statusViewportReady` 门（`q close` 页脚）。

## 未开始

（无 — 全部完成。）

## 门禁状态

| 级别 | 结果 |
|---|---|
| orbs verify | 255 测试通过 |
| 父仓库 pnpm build | 干净 |
| 全量 vitest（含 e2e） | **2242 / 2242 通过**（2026-09-21 深夜修复后） |
| import/loader 冒烟 | exit 0 |

## 恢复工作指南

1. 提交（`feat(models): migrate /models to FormWorkspace` / `feat(modes): migrate /modes to FormWorkspace`，frame seam + factory keymap + tests 可拆或合并）。
2. 装 profile：`pnpm build && pwsh scripts/install-local.ps1 -Profile tui`。
3. 评估 `/diff` `/status` 是否迁移。
4. 最终推送 origin/main。

## 本地运行方式

```
pnpm build
pwsh scripts/install-local.ps1 -Profile tui
node D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js --profile tui
```

## 架构事实（供后续 session 用）

**FormWorkspace 渲染 seam**（可复制到每页）：
1. `src/ui/frame.ts` 的 `renderDshFrame` 在 `renderFeatureSurfaceFrame` 之前插入分支（`featureId === 'xxx'`）
2. 新 `src/ui/<page>-frame.ts`：纯函数 `<page>FormModel(state, viewport, options)` + `<page>StateSource(snapshot)` + `render<Page>Frame(snapshot, viewport, options)`
3. 状态经 content region node 的 typed state source 读取（`snapshot.host.slots.contributions.find(featureId, role: 'content').value.node`）
4. `deferLayout` 双路径：defer → `{ lines: [], formWorkspace: model }`；否则 throwaway `FormWorkspace` 渲染 lines 用于 snapshot/测试
5. 字符串注入：`formWorkspaceStrings(view.preferences?.uiLanguage ?? 'en')`
6. feature keymap 需绑定 `escape`（利用 host first-refusal 机制）实现 Esc 先关 modal 再关页面
7. navigator node 保留为 state anchor + fallback renderer

**e2e 验证顺序**：`pnpm build` → `pnpm vitest run`（含 ConPTY，约 120s）→ `node scripts/import-built.mjs && node scripts/loader-built.mjs`

**安装后测试**：必须用 `pwsh scripts/install-local.ps1 -Profile tui` 装到 profile 后跑 harness CLI，单 build 不生效。
