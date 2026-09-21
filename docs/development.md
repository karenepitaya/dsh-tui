# DSH-TUI 开发说明

这份文档记录 DSH-TUI 当前的架构合同、渐进迁移边界和验证方式。安装与日常使用请先看[项目 README](../README.md)。

## 项目状态

DSH-TUI 正在使用 Strangler（绞杀者）方式从集中式 Controller/Frame 迁移到可扩展微内核。迁移原则是：先建立可测试的合同和生命周期，再逐个迁移功能，最后删除旧分支；每个阶段都保持真实 DSH profile 可运行。

当前已经具备：

- Cordis 托管的 Feature 与 Capability 注册表。
- Application、Session、Surface、Request 和 Motion scope。
- 纯状态转换与统一 Effect 执行边界。
- ResourceCoordinator 的去重、取消、latest-wins 和 last-good 语义。
- Route、Command、Keymap、Surface 与 Slot contribution。
- 纯函数 LayoutStrategy 和响应式 Region 布局。
- Sessions、Diff、Models、Modes、Capabilities、Activity 的独立 Feature route。
- DSH 官方 Settings `dsh-tui` namespace 与 app-owned Preference port。

当前还没有完成：

- 旧 Chat、Controller、Frame 和 Session compatibility facade 尚未全部删除。
- 部分上游 catalog 仍会经过 legacy adapter 提前获得；页面 Resource 的 on-open 生命周期不等于所有底层数据都已经完全懒加载。
- 部分旧命令处理分支仍与新 Feature route 并存，迁移完成后才能移除。
- Feature API 仍是 experimental，不是第三方稳定 v1。

因此，当前实现证明的是新合同可以承载真实页面，不代表 Milestone 5 已全部完成。

## 架构

```text
Cordis composition
└─ Product (terminal owner)
   ├─ AppScope
   │  ├─ FeatureRegistry
   │  ├─ CapabilityRegistry
   │  ├─ ResourceCoordinator
   │  ├─ LayoutEngine
   │  ├─ PreferenceApplication
   │  └─ TerminalDriver
   └─ RuntimeSessionScope*
      ├─ CoreSessionPort
      ├─ CapabilityLease*
      ├─ ActiveSurfaceScope
      │  └─ OverlayScope
      └─ RequestScope
         └─ MotionScope
```

核心组合是：

```text
Cordis Microkernel
+ Feature Factory
+ Capability Factory
+ discriminated-union state machines / MVU
+ scoped resources
+ slot/layout strategy
+ repository
```

### Microkernel

Registry 只保存 Factory 和静态 manifest，不保存页面运行状态。Feature instance 属于自己的 scope；卸载 Cordis fiber 时，其 contributions、resource、watcher、surface 和 pending effect 必须一起释放。

Feature 通过 manifest 声明：

- 唯一 `id` 与 `apiVersion`。
- `application` 或 `session` scope。
- `eager`、`on-command` 或 `on-route` activation。
- required / optional 身份。
- 需要的类型化 Capability token。

Factory 只能得到 manifest 声明的依赖，不能拿到任意 Cordis Context 或全局 service locator。重复 Feature ID、Route 或 single Slot 在注册时立即失败；可选 Feature 的失败不得拖垮 Chat。

实验合同从以下入口导出：

```text
dsh-tui/experimental
dsh-tui/kernel
```

内置模块有独立 subpath：

```text
dsh-tui/features/legacy-chat
dsh-tui/features/sessions
dsh-tui/features/diff
dsh-tui/features/models
dsh-tui/features/modes
dsh-tui/features/capabilities
```

这些出口当前用于包内组合和合同验证；在 experimental API 稳定前，不应作为第三方长期兼容承诺。

### DSH Adapter 边界

DSH/Cordis 具体类型应停留在 `src/dsh/`、`src/adapters/` 和最外层 composition plugin。Feature、state machine、projector 和 presentation 不应反向导入 DSH 类型。

边界分工：

- `CoreSessionPort` 承担 durable event、submit、cancel 和 interaction 的最小会话能力。
- 额外能力以版本化 `CapabilityToken<T>` 声明，并在 SessionScope 内至多创建一个 Lease。
- `AgentBootstrapContributor` 负责 Agent 发布前必须事务安装的能力及 rollback。
- Agent 发布后的 catalog、tools、MCP、jobs 等能力按 Feature 需要获取。
- DSH `0.1.5-rc.2` 的兼容逻辑隔离在 adapter/compat 层。
- Durable DSH event 始终是 transcript、tool 与 workbench 数据的事实源；TUI 不复制一份业务事实。

项目不修改 `deepseek-harness`，也不要求 DSH 为 TUI 增加专用协议。

### State 与 Effect

状态机使用 TypeScript discriminated union 和穷尽 reducer，不引入 XState。约定形式是：

```ts
transition(state, event) => { state, effects }
```

Reducer 必须：

- 保持纯函数，不执行 IO。
- 不生成 ANSI 或直接操作终端。
- 用明确状态表达 loading、ready、failed、cancelling 等生命周期。
- 让迟到结果通过 scope epoch / requestId 被确定性拒绝。

IO 由 scope-aware EffectRunner 执行。Feature 间协作通过语义 UiCommand 和只读 Capability；不建立新的全局 EventBus，也不互相导入具体 Feature。

输入链固定为：

```text
raw bytes
→ TerminalKey
→ navigation preference / Keymap Context
→ semantic UiCommand
→ active Feature or shell
```

Chat 默认 Insert；二级页面默认 Normal。`hjkl` 只在导航上下文中生效，不得吞掉 Insert 模式的普通文字。

### Resource 与加载时机

Resource 声明 lifetime、activation、cache policy、load 和可选 watch。ResourceCoordinator 负责：

- 同 scope 去重。
- Abort 与逆序销毁。
- requestId / epoch 的 latest-wins。
- 刷新失败时保留 last-good。
- Surface 关闭时释放其 loader 和 watcher。
- resize 或主题变化只重算布局/样式，不重新请求数据。

目标加载顺序：

1. 首帧只启动 Kernel、Chat、Composer、当前 Session durable replay 和可见的轻量摘要。
2. Session ready 后准备当前会话需要的轻量状态。
3. `Ctrl+O` 后才建立 Verbose projection 和详细工具 renderer。
4. Diff 可见后才计算 diff，并以内容摘要缓存。
5. Catalog 页面可见后才创建对应页面 Resource 和 watcher。
6. 关闭 Surface 后取消页面任务，但保留 Session event pump。

目前第 5 点的页面生命周期已建立，但部分 Feature 的数据源仍来自 legacy adapter；不要用“所有 catalog 已完全 lazy”描述当前版本。

### Surface、Slot 与 Layout

Feature 贡献语义 Region，不指定绝对坐标。常用 role：

```text
timeline navigator content inspector composer status overlay
```

LayoutStrategy 是纯函数：

```text
resolve(viewport, route, regions) -> LayoutPlan
```

默认断点：

- `<100` 列：一个活动区域，切换焦点查看列表或详情。
- `100–139` 列：允许 Navigator 与 Content 两栏。
- `>=140` 列：只有实际存在 Inspector 内容时才增加第三栏。

权限审批内嵌在 Composer 上方，并与输入安全门共用 `approvalLayoutBudget`。Question、Plan Review 和短确认保留短交互。Breakpoint 变化只能生成新 LayoutPlan，不得重新创建 Feature 或 Resource。

## Transcript 与安全显示

Compact 与 Verbose 是同一 durable transcript 的两种 projection，不是两份存储。

Compact：

- 用户问题、最终回答，以及存在执行步骤时的一行安全摘要。
- 单工具调用同样折叠。
- 不调用详细 tool renderer 或 diff computation。

Verbose：

- 按时间顺序呈现安全阶段摘要、工具参数、结果、错误和截断状态。
- 不直接呈现 raw private reasoning。
- 无可靠摘要时使用稳定的阶段描述，不截取 thinking 充当摘要。

Orb 属于 RequestScope，并显示在 Assistant 时间线尾部。提交后立即出现；首个 durable answer 内容出现后停止；失败或取消且没有回答时可留下静态终态。Motion lease 在请求结束或 Surface 销毁时必须归零。

## Preferences 与持久化

长期偏好只保存在 DSH 官方 Settings 的 `dsh-tui` namespace：

```ts
interface DshTuiPreferencesV1 {
  version: 1
  theme: DshTuiThemeConfig
  density: 'compact' | 'comfortable'
  navigationKeys: 'arrows' | 'vim' | 'both'
  reducedMotion: boolean
  layoutMode: 'auto' | 'single' | 'split'
  defaultTranscriptMode: 'compact' | 'verbose'
}
```

层级优先级：

```text
built-in defaults < Cordis row config < DSH Settings user section
```

写入使用 namespace revision 进行 CAS，冲突必须显式返回；外部文件热重载校验失败时保留 last-good。schema 使用 version 字段为后续 migration 留出边界。

不得写入偏好库的内容：

- transcript 或 raw tool output。
- Prompt draft、附件路径和滚动位置。
- Session route 或 Session-specific Compact/Verbose 状态。
- credentials、token 或其他 secrets。

草稿、附件、scroll anchor 和 view mode 只允许在当前进程中按 `{sessionId, bindingEpoch}` 保存。Diff projection 和 catalog cache 都是可丢弃缓存。

主题支持语义 `palette`，其条目可为 `#RRGGBB` 或 ANSI 名称；显式 palette 覆盖旧的 ANSI-only `colors`。Product 的 PreferenceApplication 热更新当前主题、密度、布局、导航和 motion 设置，不重建 transcript 节点或滚动状态。

## 当前 Feature 迁移表

| Feature | 新 route / machine / resource | 当前迁移备注 |
| --- | --- | --- |
| Sessions | 已接入 | 独立目录、详情、搜索、恢复与 fork；旧 Session picker 分支已删除 |
| Diff | 已接入 | 内容寻址 Resource 与独立 Surface；旧 transcript 兼容路径尚需最终删除 |
| Models | 已接入 | 独立选择与默认值操作；旧 Model picker 分支已删除，部分 catalog 来源仍经 compatibility port |
| Modes | 已接入 | 独立 mode machine；旧 Mode picker 分支已删除，live Session 的官方锁定规则继续由 DSH 决定 |
| Capabilities | 已接入 | Skills / Tools / MCP 合并为一个三标签 Feature，页面投影为 `FormWorkspaceModel`（分类栏 + 有界列表 body + 只读 form 详情弹层，见 `ui/capabilities-frame.ts`），复用三个纯 machine；typed `/skills`、`/tools`、`/mcp` 是打开同一 route 的隐藏别名；旧三个独立 Feature、overlay 分支与 inspector 面板已删除，Capability 在 route scope 获取，不复制 tool 执行事实，不拥有 MCP connection supervisor |
| Status | `/status` 单页只读诊断 | 旧 `/context`、`/attempts`、`/route` 三个诊断 overlay 合并为一个滚动单页（Context / Request recovery / Model route 三个分区）；typed 旧名是隐藏别名，不进补全菜单；投影继续复用 `llm/attempts`、`llm/routes` 与 context-metrics |
| Connect | 收编进 `/settings` 提供商管理页 | 独立 `/connect` 向导浮层（ProviderConnectController）已删除；typed `/connect` 是直达“模型与服务”提供商页的隐藏别名；连接/断开/授权/测试由 SettingsProvidersController 承担 |
| Activity | 已接入 | 独立 Jobs/Subagents/Workflows 工作区（navigator + inspector）；旧 controller 直管 Activity Center overlay 与 legacy Jobs 路径已删除，Ctrl+B 与 `/activity` 改接 Feature route，refresh/stop 归 Feature effect runner 所有；transcript 的 `ACTIVITY · {id}` 活卡保留在 controller |
| DSH Settings | `/settings` 分类表单 | `settings/page-catalog` 投影真实 schema，`page-machine` 管理草稿；`settings/page-session` 以 `SettingsPageSession` 拥有覆盖层的运行时库状态、SettingsProvidersController 与变更管线（实现最小 `PageSession` 契约），controller 仅保留命令入口、优先级仲裁与关闭编排；`settings-page-frame` 只映射脱敏数据，终端保留 Orbs `FormWorkspace`（原 `SettingsWorkspace`，现为共享表单页组件）并组合 pi-tui 容器与控件；settings machine 内核（`src/settings/page-machine.ts`）在第二个表单页消费者落地前有意保持 settings 专属；Ctrl+O 进入高级目录；外观偏好在此页面编辑，`/preferences` 命令已移除（仅 `/settings`） |
| Chat | 兼容迁移中 | durable reducer、stream、interaction 与 Orb 仍需从 legacy host 最终拆出 |

删除旧字段或分支必须紧跟对应 Feature 的真实迁移，不能先删兼容路径再补行为。

## 本地开发

### 目录与依赖

```text
DSH-Project/
├─ deepseek-harness/       # 官方 E2E 所需的 Harness 源码
└─ dsh-tui/
   └─ packages/pi-tui-orbs/ # 仓库内受版本控制的组件库
```

```powershell
Set-Location 'D:\Projects\DSH-Project\dsh-tui'
pnpm install --frozen-lockfile
```

开发和构建不再依赖相邻的 `../pi-tui-orbs`。组件库通过 pnpm workspace 安装，与应用共用根目录的 `pnpm-lock.yaml`；来源及校验值见 `packages/pi-tui-orbs/SOURCE.md`。不要创建第二套 lockfile。Node.js 版本以 `package.json#engines` 为准。

### 常用门禁

先运行最窄的相关测试，再扩大范围：

```powershell
pnpm exec vitest run tests/<target>.spec.ts
pnpm run typecheck
pnpm run test
```

完整仓库门禁：

```powershell
pnpm run verify
```

覆盖率报告默认输出到 `.artifacts/coverage/latest/`。定向或并行验证使用 `--coverage.reportsDirectory=.artifacts/coverage/<scope>`，每个同时运行的进程使用独立目录；不要在仓库根目录创建 `coverage-*`。

`verify` 当前包含：

1. 仓库内 pi-tui-orbs 的测试、类型检查和构建，以及应用 TypeScript typecheck。
2. 完整 coverage gate（官方 DSH E2E 单独运行）。
3. 官方 DSH Standard Agent E2E。
4. clean build。
5. 构建产物 import smoke。
6. Cordis loader smoke。

不要在文档中固定测试文件数或用例数；它们会随着 Feature 迁移变化。

只跑官方 Agent E2E：

```powershell
pnpm run test:standard-agent-e2e
```

构建与打包：

```powershell
pnpm run build
pnpm run pack:local
```

实际 profile 的打包、安装和 digest 校验见 [README](../README.md#手动打包和安装)。开发迭代推荐：

```powershell
pnpm run dev:profile
```

### HMR 边界

终端 ownership、raw mode 和 Cordis Session 生命周期无法安全地做模块级热替换。当前开发流程不提供 HMR；每次源码变化后重新 build、pack、install、launch。不要用绕过 profile 安装的本地 import 代替发布路径验证。

## 测试合同

### 架构边界

- UI / presentation 不导入 DSH 具体类型。
- presentation 不反向依赖底层 terminal protocol。
- Feature Factory 不获取 Cordis Context。
- 两个 Cordis Context 的 registry、theme、cache 和 Session 状态完全隔离。
- Fake Feature 无需修改 Controller、Frame、Input Router 或 LayoutEngine 即可注册、打开、加载和卸载。
- 重复贡献、API 版本不符与依赖缺失都产生确定结果。
- optional Feature 失败不影响 required Chat。

### Scope 与异步

- 未打开的 Feature Factory / loader / watcher 调用次数为零。
- Surface 每次打开和关闭精确创建、释放一次。
- 迟到请求不能写入新 scope。
- refresh 失败保留 last-good，并呈现可辨识的失败状态。
- resize 和主题切换不增加数据加载次数。
- shutdown 逆序释放 scope，motion lease 为零，终端恢复恰好一次。

### 交互与视觉

- Compact 下复杂 turn 只有一行执行摘要，详细 renderer 调用次数为零。
- Verbose 恢复当前 Session 全部安全详情，但不泄漏 raw reasoning。
- `Ctrl+O`、route 切换后 draft、焦点和 scroll anchor 保持。
- Orb 从 submit 覆盖到首个回答内容，失败/取消无正文时留下静态结果。
- 普通消息无 YOU/DSH 标签；用户条与 Assistant 正文之间无多余空行，完整 turn 之间保留一行。
- Composer 始终实底弱边框、无 `PROMPT`，与时间线分隔一行；多行或附件只改变高度，极小窗口退化为有界实底行。
- Quick Start 不显示，真实 Goal/Plan/Todo 仍可用。
- CJK、Windows 路径、窄屏、宽屏、ANSI 降级和 ConPTY 可见屏幕不越界。

### Feature 人工验收

每个可见里程碑都要通过实际 `tui` profile，而不只看 unit test：

1. `/sessions`：搜索、`j/k`、详情、resume/fork、Esc 焦点恢复。
2. `/diff`：窄屏单页、宽屏分栏、hunk 导航、长行与空 diff。
3. `/models`：每模型一行、独立推理强度、当前/默认状态、应用、保存默认值和错误恢复。
4. `/modes`：切换未锁定 Session，已运行 Session 显示 DSH 官方锁定状态。
5. `/skills`、`/tools`、`/mcp`：查询、空态、刷新、last-good 和 Capability 缺失降级。
6. `/activity`（或 Ctrl+B 开关）：JOBS/SUBAGENTS/WORKFLOWS 页签、`[/]` 切页、`K`/Delete 确认停止、`r` 刷新、Esc 返回；空目录预暖与不可用降级。
7. `/settings`：响应式分类、类型化输入、选择弹层确认/取消、q 退出与输入保护、保存/取消/恢复默认、秘密不回显、默认宽权限确认；外观偏好在该页面编辑、CAS 冲突、外部文件热重载和主题降级；`/preferences` 已移除，仅此一个入口。真实 Settings 颜色与光标必须测试 Orbs 渲染路径；中性 UiFrame 仅用于文本回退。
8. Chat：纯文本、单工具、多工具、reasoning-only、失败、取消、权限、问题和 plan review；发送或命令失败不能混合新旧草稿的文字/图片。
8. 审批：一次允许/拒绝/会话内允许、数字键切换、Ctrl+O 详情、窄屏最后一行可达、按范围复用以及 /permission 撤销。
9. ConPTY：graceful shutdown、第二次 interrupt 强制退出、终端样式恢复。
10. `/web`：TUI 界面消失、终端恢复恰好一次；会话小结与 web 面板打印在同一终端；浏览器自动打开；`Ctrl+C` 停止 web 并回 shell、无残留进程；日志文件有完整子进程输出；CLI 入口不可解析时打印原因并以非零码退出。

## 改动纪律

- 保留用户现有的未提交修改，不 reset，不覆盖无关工作。
- 每次迁移只删除已经被新 Feature 完整替代的旧状态与分支。
- Kernel、Layout 和 Input 不得为某个具体页面增加特判。
- 新 Feature 应通过新增 Factory 和可选 DSH Adapter 接入。
- 不在本仓库修改 `deepseek-harness` 或 Desktop。
- 不顺带处理未纳入当前里程碑的性能债。
- 发布前检查自己的 diff，每一行都必须能追溯到当前计划。

## License

[MIT](../LICENSE)
