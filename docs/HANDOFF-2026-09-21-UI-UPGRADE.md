# HANDOFF 2026-09-21 — UI 升级（向 /settings 看齐）

## 这个 session 完成了什么（已合并 main 并推送）

命令面精简 + 架构统一，merge commit `9b15e2c`（`origin/main` 已推送，分支 `upgrade/dsh-0.1.5` 也在远端）：

- `/preferences` 删除（并入 `/settings`）；`/chat` 误暴露修复；6 个休眠 legacy picker 删除。
- `SettingsPageSession`（`src/settings/page-session.ts`，`PageSession` 契约）从 controller 抽出。
- Orbs `SettingsWorkspace` → **`FormWorkspace`**（`packages/pi-tui-orbs/src/form-workspace.ts`），通用表单页组件；`UiFrame.formWorkspace` 是 driver 唯一组件槽位（`src/terminal/driver.ts`）。
- `/activity` 迁为 session 作用域 kernel feature（`src/features/activity/`，Ctrl+B 保留）。
- `/skills` `/tools` `/mcp` → **`/capabilities`**（`src/features/capabilities/`，三标签页；旧名 typed 别名保留）。
- `/context` `/attempts` `/route` → **`/status`**（单页滚动三分区，`src/ui/workspace-status.ts`；旧名 typed 别名保留）。
- `/connect` → 收编进 `/settings` 提供商页（`SettingsPageSession.openAtProviders()`，typed 别名保留）。
- 删除 `/stop`（Ctrl+C 覆盖）、`/paste-image`（**Ctrl+V / Alt+V** 直接粘贴，`src/terminal/input.ts`）；`/model` `/mode` `/attach` 菜单隐藏、typed 保留。
- `src/app/controller.ts`：6362 → **3844 行**。全量 2197 测试 + ConPTY e2e（26/26）+ build + import/loader 冒烟全绿。

## 重要：本地运行方式

`pnpm build` **不够**——harness CLI 加载的是 profile 安装副本。改动后必须：

```
pnpm build
pwsh scripts/install-local.ps1 -Profile tui     # 打包并重装到 ~/.dsh/profiles/tui
node D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js --profile tui
```

（或 `pnpm dev:profile` 装完直接启动。）

## 下一步任务：UI 视觉升级（用户已确认方向）

**目标：所有页面放弃纯文本行渲染（`src/ui/feature-surface-frame.ts`），迁到 Orbs `FormWorkspace` 组件渲染，向 `/settings` 的视觉与交互水准看齐。**

用户验收截图（证据，本仓库内）：
- `docs/assets/ui-2026-09-21-sessions.png`
- `docs/assets/ui-2026-09-21-activity.png`
- `docs/assets/ui-2026-09-21-capabilities.png`

用户原话的三条 complaint：
1. **几乎看不出有效信息**——信息密度低、关键字段被截断。
2. **操作逻辑不遵循 settings**——各页按键/焦点/提示各搞一套。
3. **排版丑，莫名大块空白**。

### 截图中确诊的具体问题（先修这些）

**Sessions 页**（三栏：navigator + content + inspector）：
- navigator 行被截断（`cur…`），列宽分配不合理；navigator 与 content 之间大片死空白。
- content 栏只有 3 行有效信息（标题/路径/Status/Created），其余全空。
- inspector 的 session id 硬换行很丑；`Transcript 0 rows · 3 events` 这类信息层级不清。
- footer 键位与 settings 不一致（`a resume · f fork · R refresh` vs settings 的 Enter/Tab/Ctrl+S/q 体系）。

**Activity 页**：
- 空态只有顶部 3 行，下方整屏空白；空态应居中或给引导。
- **footer 出现两个 `Esc back`**（明显 bug：feature-surface 默认 hint 与页面 actionHint 叠加重复）。
- `[/] tabs · j/k move · K stop · R refresh` 与 settings 操作语言不一致。

**Capabilities 页**：
- **MCP tab 上出现 `0 tools available in this session`**（疑似串台：tools 空态文案渲染在 MCP tab；需查 `src/features/capabilities/nodes.ts` 的空态/行构建分发）。
- `SEARCH i to search · r to refresh`、`Check MCP configuration in /settings, then r to refresh` 等说明行直接堆在内容区顶部，无视觉层级。
- 同样整屏空白。

### 已知的框架层事实（升级时要用）

- `/settings` 渲染链：`src/settings/page-machine.ts`（纯状态机）→ `src/ui/settings-page-frame.ts`（view→model 投影）→ `UiFrame.formWorkspace` → driver 缓存 `FormWorkspace` 组件实例（`setModel` 更新，`setTheme` 换肤）。
- FormWorkspace 已有：categories 侧栏/顶部 tab、groups/fields、ChoiceControl/ToggleControl/Button/SelectionList、5 种模态（editor/picker/confirmation/dialog/form）、宽窄断点、硬件光标。模型必填项：`actions`、modal `hint`。
- feature 页现在的渲染链：feature `nodes.ts` 产 `FeatureSurfaceRow` 文本行 → `renderFeatureSurfaceFrame` 排版（pane 布局、选择高亮、footer hint）。**两套栈并存是本次要消灭的。**
- feature 声明 panes 用 `LayoutRegion`（factory 里 minColumns/preferred/priority）；**standard 断点（100-139 列）只显示 content（+inspector 需 ≥140 列）**——sessions 截图里 content/inspector 空洞与此策略有关，升级时重新评估断点与列宽。
- `h`/`l` 被 shell 焦点切换占用（`feature-host.ts` shell-reserved），feature keymap 里声明无效；tab 切换用 `[`/`]`。
- 确认类 UI 没有共享原语：各 feature 手写 confirm 行（sessions `operationRows`、activity 同样模式）——FormWorkspace 的 confirmation modal 是统一出口。

### Orbs 包侧的优化项（与 UI 升级同批做）

- 三套 theme 词汇待统一：`FormWorkspaceTheme`（17 角色，form-workspace-model.ts）、`ControlTheme`（10 角色，control-presentation.ts）、`LabControlTheme`（lab-controls.ts）。迁移页面时顺手收敛。
- `packages/pi-tui-orbs/README.md` 已有 FormWorkspace 章节（本 session 补的），控件层文档可再完善。
- 视觉规范参考 `docs/SETTINGS-2026-09-08-FRAMEWORK.md`、`docs/SETTINGS-CONSISTENCY-2026-09-09.md`、`docs/PROVIDER-PAGE-2026-09-09.md`（settings 的 UX 迭代记录：侧栏 vs 顶部 tab、操作栏位置、标题规范、q 退出语义）。

### 建议执行顺序

1. **`/capabilities` 视觉试点**：迁到 FormWorkspace（categories = Skills/Tools/MCP 三标签；列表 → SelectionList；详情 → 内容区/inspector；skill 调用的 confirm → confirmation modal）。同步修掉空态串台 bug。
2. **`/activity`** 跟进（同构标签页；顺手修 footer 双 `Esc back`）。
3. `/sessions` `/models` `/modes`；`/diff`、`/status` 信息密度高，控件化收益小，最后评估或不动。
4. 每页迁移都要更新 e2e（见下）与对应 feature spec。

### e2e 与测试门禁（改 UI 文本必动）

- `scripts/official-dsh-e2e.mjs` 是 ConPTY 发布门禁，大量断言屏幕文本（marker 列表、`assertWorkspaceResizeMatrix` 每页恰好一次、`workspace_pages=11` 计数、证据 token 行）。UI 文案/布局变了要同步改；失败时从 `.artifacts/official-e2e-workspaces-*` 读屏幕快照。
- 验证顺序：`pnpm --filter pi-tui-orbs run verify` → `pnpm build` → 全量 `pnpm vitest run`（含 e2e，约 90s）→ `node scripts/import-built.mjs && node scripts/loader-built.mjs`。
- feature-surface 文本行被一批 spec 钉住（`tests/*feature*.spec.ts`、`workspace-*.spec.ts`、`frame*.spec.ts`），迁移时预期大量断言更新。

### 工作方式备注（本 session 的有效模式）

- 探索用 explore 子代理出带 file:line 的完整触点图；实施用 coder 子代理（本 session 的 coder 通过 resume 连续完成了 activity 迁移、W4/W3/W2/W1，上下文连贯性好）。
- controller.spec 有 ~40 处直接读内部状态的 cast，删功能时先 grep 测试触点。
- 官方命令让位机制：同名官方命令注册后本地实现自动隐藏（bridge `occupiedCommands` + `hasOfficialCommand` 门控），删本地命令时 typed 输入要有防漏兜底（否则漏进 agent prompt）。
