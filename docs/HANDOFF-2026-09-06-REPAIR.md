# DSH-TUI 修复与体验收敛：开发交接手册

> 当前接手入口（2026-09-08）：先读 [UI 控件复用审计](UI-CONTROL-REUSE-AUDIT-2026-09-08.md)。Settings 功能已交付，但按钮与部分选择列表尚未统一；后续应先在现有 pi-tui + Orbs 内收拢共享控件，再迁移 Settings 使用位置。本次按用户要求记录审计、更新 README 并同步当前开发成果；没有继续改 UI。下列“未 commit / push”和脏工作区描述均是各阶段历史快照，当前状态以 Git 为准。

> 最新管理面板修正（2026-09-08）：提供商管理已使用 Orbs 三组表单，测试中保留上下文，成功/失败/取消在按钮旁醒目反馈；危险操作分色与完整确认。2270 个根包测试、每文件四维 100%、223 个 Orbs 测试及完整 ConPTY 通过，最终两包已安装并核验启动和配置。接手先读 [提供商管理表单与测试反馈](SETTINGS-PROVIDER-MANAGEMENT-2026-09-08.md)。未 commit / push，保留当前脏工作区。

> 最新截图反馈修正（2026-09-08）：Settings 模型已按提供商分组去重，快捷键移至独立底栏，默认/已配置状态独立着色，目录限高滚动。2252 个根包测试、每文件四维 100%、211 个 Orbs 测试和完整 ConPTY 通过，新两包已安装并核验启动。接手先读 [模型与提供商列表修正](SETTINGS-PROVIDERS-2026-09-08-POLISH.md)。未 commit / push，保留当前脏工作区。

> 最新（2026-09-08）：Settings 的“模型与服务”已改为动态供应商目录和配置浮窗，新增显式测试按钮；2243 个根包测试、每文件四维 100% 覆盖、199 个 Orbs 测试与官方 ConPTY 均通过，两个包已安装并完成字节/启动/配置核验。接手先读 [提供商浮窗交付与安装记录](SETTINGS-PROVIDERS-2026-09-08-RESULT.md)。本轮未 commit / push，现有脏工作区仍需保留。

> 2026-09-08 Settings 已以 pi-tui + Orbs 重做，保持主页面字号并新增 q 退出；后续已修复宽屏右侧留空和独立绿色主题问题，重新通过门禁并安装到真实 profile。接手先读 [Settings 当前框架交付记录](SETTINGS-2026-09-08-FRAMEWORK.md)的“最新修正验收”；[Settings 前一阶段记录](SETTINGS-2026-09-08-RESULT.md)、[2026-09-07 交付记录](REPAIR-2026-09-07-RESULT.md) 与 [产品及依赖审计](AUDIT-2026-09-07-UX-AND-ORBS.md) 保留作历史参考。下文保留 2026-09-06 中断现场，不能作为当前安装或验证状态。

> 交接日期：2026-09-06（Asia/Shanghai）。
> 交接性质：**中断现场，不是完成报告，不是发布说明**。
> 用户要求结束过长会话，在新 session 中继续既定修复计划。本次交接只写文档，没有继续修改实现、安装依赖或覆盖用户安装包。

## 0. 接手先看这页

**当前主要逻辑已经实现，但集成尚未收尾，工作树不能视为可发布。**

- 用户已批准实施“DSH-TUI 修复与体验收敛计划”，不要重新进入大范围设计讨论，不要从零重构。
- 修改前完整基线通过；修改后多组定向测试通过，**当前 typecheck 仍失败，完整 verify 尚未重新通过**。
- 最直接的断点是：审批尺寸预算已用于 Controller 安全检查，但 Frame 尚未采用；Retained Composer 的高度/禁用光标改造只有失败测试，源码尚未实现。
- 新版尚未打包、尚未安装。真实 tui profile 仍引用 2026-09-05 08:55 的旧包。
- 工作树大量 dirty/untracked，包含前几轮功能和本轮修复。没有提交本轮改动，不能 reset、checkout、clean 或把所有差异当作本轮新增。
- **新 session 必须使用同一个本地工作目录，不要从干净 HEAD 新建 worktree 后继续。** 大量实现和本文都未提交；新 worktree 不会自动包含它们。
- 三个旧子 Agent 都已停止实现并完成只读交接。新 session 不应假定这些 Agent 会继续运行，也不要依赖旧工具 session/cell ID。
- 用户希望每次做好后直接打包安装供试用；但必须先通过门禁，不能把半成品覆盖到真实 profile。

### 0.1 第一轮操作

1. 阅读本文件、仓库 AGENTS.md、PRODUCT.md 和 docs/development.md。
2. 核对工作目录、HEAD、dirty 文件和现有安装包；不要动用户 Session。
3. 重新跑 typecheck 与最窄的失败 fixture，确认现场没有被后续操作改变。
4. 首先完成共享审批预算与 Composer 接线；保留失败测试，不删除它们换取绿色。
5. 再处理旧目录尚未达到的键盘/详情/断点合同，以及其余整合回归。
6. 完成后跑完整门禁、真实屏幕操作、打包、安装和两包 digest 校验。

### 0.2 当前交接准确性

本文依据本次实际源码读取、上一轮工具输出、三个负责 Agent 的只读核验编写。下文的测试数量带有“运行范围”和“时间/阶段”限制；**不能把这些数字相加当成最终总数，也不能把历史 100% 当成当前整仓 100%。**

交接时主 Agent 最近重新运行的 typecheck 返回 7 处错误，详见第 8 节。

---

## 1. 目录、工具链与禁止事项

### 1.1 实际路径

| 用途 | 路径 |
|---|---|
| 共享父目录 | D:\Projects\DSH-Project |
| 本轮开发仓库 | D:\Projects\DSH-Project\dsh-tui |
| 官方 Harness，只读参考/现有构建 | D:\Projects\DSH-Project\deepseek-harness |
| 独立 Orbs 包 | D:\Projects\DSH-Project\pi-tui-orbs |
| Desktop，禁止进入本轮范围 | D:\Projects\DSH-Project\deepseek-harness-desktop |
| 真实用户 profile | C:\Users\30553\.dsh\profiles\tui |
| 当前 CLI | D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js |
| 本仓库 artifacts | D:\Projects\DSH-Project\dsh-tui\.artifacts |

本机 D:\Projects\DSH-Project\AGENTS.md 不存在；仓库有 [AGENTS.md](D:/Projects/DSH-Project/dsh-tui/AGENTS.md)。全局用户指令来自对话，关键限制在本节同步。

### 1.2 环境

- Windows，PowerShell 7+，使用 pwsh，不用 cmd.exe 或 Windows PowerShell 5.1。
- packageManager：pnpm@11.7.0；保留 pnpm-lock.yaml，不引入 npm/yarn lock。
- Node engines：^22.19.0 || >=24.0.0；用户曾提供 Node v24.16.0、PowerShell 7.6.5。新 session 用命令复核实际执行器。
- TypeScript、pi-tui 0.84.2、pi-tui-orbs 0.1.0、Vitest、@xterm/headless、Windows ConPTY。
- 所有直接 @deepseek-ai/* 预发行依赖继续精确固定 0.1.1-rc.2；不要用范围版本。
- Vitest coverage 是 **perFile 四项全部 100%**，不是只看 aggregate。不要降低阈值、删测试或加忽略指令掩盖问题。

工具执行时普通 sandbox 下 pnpm 曾因包管理器签名/registry 网络请求失败；同一命令走批准的正常用户环境成功。应记录并区分环境问题，**不要关闭签名校验或更换包管理器**。新 session 的工具能力/审批状态需重新确认，不依赖旧批准自动继承。

### 1.3 必须保护的边界

- 不修改 deepseek-harness 核心，不处理 Desktop，不迁移 OpenTUI，不使用 Figma。
- 不处理此前搁置的 token-delta 数组复制和命令面板候选重建。
- 不清理历史测试 Session，不批量删除任何真实 DSH 用户数据。
- 不自动 commit/push/reset；不要把用户原有修改覆写成“更干净”的版本。
- 本仓库是 clean-room：禁止复制/改写 ccch1mneyyy/dsh-TUI 源码；该来源有 leaked proprietary origin 风险。
- dsh-tui/dsh-tui 仅能作历史架构证据，具体代码授权未核对前不得复制。
- DSH 类型/集成留在 src/dsh/ 与最外层 composition/compat；UI、Feature 不直接获取 Cordis Context 或任意 service locator。
- Durable DSH events 是 transcript/tool/goal/plan/todo 的事实源，实时和回放必须走同一 reducer。
- State machine 不执行 IO、不生成 ANSI；layout 不调用 loader；Resize/主题切换不重建资源。
- 不引入进程/module-global 可变 Singleton，不把刚拆开的业务搬进另一个巨型文件。
- 修改文件使用 apply_patch；Windows 路径必须用 LiteralPath 或明确解析，递归删除只针对已校验的本次生成目录。
- ConPTY、审批结算、shutdown、terminal restore 恰好一次都是发布门禁。

---

## 2. 用户已经确定的产品合同

这些是当前修复计划的决定，不需要再次向用户询问。它们覆盖更早对话中相矛盾的旧方案。

### 2.1 视觉与信息层级

- “Claude Code 式简短对话流 + OpenCode 式精致二级页面”，不是 Web 聊天气泡。
- 不显示 USR、YOU、DSH 角色标签；用户消息低对比背景条，Assistant 正文无框。
- **完整对话轮之间保留一行；Assistant 同轮内容紧凑。** 不要把所有间距删光，也不要让 Markdown 标题/列表制造大片空白。
- 不试图由 TUI 控制终端字体字号。
- Compact 默认只显示必要对话和一行执行摘要；Ctrl+O 切换整个当前 Session 的安全详细记录。
- Compact 不提前构建详细 tool renderer 或 diff；不要以“先构造后隐藏”冒充懒加载。
- 原始 reasoning 不直接出现在普通 UI；阶段说明必须安全、简短，不从 raw thinking 截一段伪装摘要。
- Orb 位于 Assistant 时间线尾部；提交即反馈，首个正文字符后停止；终态释放 motion，不让历史缓存每帧失效。
- Quick Start 暂停；真实 Goal、Plan、Todo 不删。
- 聊天保留用户终端背景。Composer、审批区、Workspace 使用实底。
- **Composer 始终同一种实底弱边框，无 PROMPT 字样；与时间线有一行分隔。** 单行、多行、附件只变高度，不变组件外观。这取代旧的“单行无框”方案。
- 附件摘要在 Composer 内；图片编码/本地绝对路径不能泄露到 renderer。

### 2.2 审批

- 固定内嵌在 Composer 上方，不居中遮住聊天。
- 实际工具/命令/参数、cwd、当前与请求权限、理由和队列位置必须能查看；理由不是证据。
- 默认拒绝，缺失关联证据禁止允许；数字、方向键、Enter 与提示一致。
- 普通审批只有一次允许/拒绝，不新增永久允许、记住授权。
- /permission 管理官方权限预设；custom 只读；never 不是自动允许，而是自动拒绝审批请求。
- 扩大权限必须显示真实边界变化并再次确认，不静默改全局配置。
- 审批期间草稿和附件保留、普通 Composer 不提交；Esc 拒绝当前项；队列依次处理。
- Question、Plan Review、认证挑战、Fork/Resume 确认仍属于短交互，不强制当目录页。

### 2.3 导航与 Workspace

- 目录页 **一次 Esc 返回上一层，搜索状态也一样**；不能只能 Ctrl+C 退出整个产品。
- Normal 默认聚焦列表；/ 或 i 进入搜索；Enter 应用搜索并回列表；Tab/ShiftTab 切区域。
- j/k 移动，h/l 切相邻区域；文本输入时这些字母正常输入。
- Diff 保留 h/l 折叠/展开，[/] 切 hunk，Tab 切区域。
- 页脚持续说明当前焦点、主要操作和 Esc 返回；选中项与焦点区域要分开表现。
- 列表移动/搜索/Resize 后选中项可见；长详情能换行和独立滚动，不能永久省略成一行。
- <100 列一个活动区域；100–139 列可 Navigator+Content；>=140 列只在有实际 Inspector 内容时第三栏。
- 分栏有明确留白与边界，不把文本按列宽直接拼接。
- 返回 Chat 恢复 draft、attachments、scroll anchor 和输入焦点。
- 无参 /model 与 /models 共用 Models；/mode 与 /modes 共用 Modes；带参数的官方命令仍保留。
- /settings 是 Harness Settings/Plugins；/preferences 才是 TUI 偏好，不能互相顶替。

### 2.4 Agent 与时间

- 工作规范和动态时间是两项独立能力；保留官方身份、工具说明、权限上下文与项目指令。
- 不覆盖用户显式 complete prompt。
- Agent 先检查再修改、保护 dirty、遵守工具链、进度简洁、失败不能声称成功、最终说明验证与未完成项。
- 不伪造身份、能力、时间、项目事实；不能把审批拒绝当成绕权限的理由。
- 时间经官方 time-context 的 eligible pre-step 刷新，进程时区是运行环境事实，不冒充用户/浏览器时区。
- 不注入完整环境变量、secrets 或无关系统信息。

---

## 3. Git、基线与安装现场

### 3.1 工作树基线

- 分支：main，相对 origin/main ahead 7。
- HEAD：dbd369601744c1e9f17fccc01ae3491005fbe05e。
- 本轮开始前已有大量 tracked 修改和 untracked 架构文件。
- 本轮未提交、未重置，也未清理旧历史数据。
- [修复前基线清单](D:/Projects/DSH-Project/dsh-tui/.artifacts/repair-2026-09-05-baseline.json)：
  - capturedAt：2026-09-05T19:04:25.7109333+08:00。
  - 412 个源码/测试/脚本/配置文件的 SHA256。
  - 记录当时 HEAD 和已安装两包 tarball 引用。
- **该 JSON 是哈希清单，不是源文件备份，不能靠它恢复未提交内容。** 不要因此误认为 git reset 后还能还原。
- docs/development.md 已承认 Strangler 迁移未完成、部分底层 catalog 仍提前获得、legacy 分支仍存在。不能把“Feature 外壳已建”表述成完全解耦/完全懒加载。
- 2026-09-06 只读统计：src/ui/frame.ts 4959 行，src/app/controller.ts 6042 行。部分渲染已抽出，但巨型中央模块的问题尚未解决；不要把扩大中央文件作为默认接线方式。

### 3.2 当前实际安装（交接时读取 profile manifest 确认）

主包：

D:\Projects\DSH-Project\dsh-tui\.artifacts\dsh-tui-0.0.0-979b5e5b9223a9e9.tgz

- 715790 bytes；2026-09-05 08:55:37。
- profile dependencies.dsh-tui 为上述文件的 file: 引用。

Orbs：

D:\Projects\DSH-Project\dsh-tui\.artifacts\pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz

- 71503 bytes；2026-09-05 08:55:36。
- profile dependencies.pi-tui-orbs 为上述文件的 file: 引用。

真实 manifest：

C:\Users\30553\.dsh\profiles\tui\package.json

bundles 仍为 @deepseek-ai/dsh-base 和 dsh-tui。

本轮没有新包安装。更早校验记录为主包 files=956、digest 前缀 1474f3536853a412；Orbs files=92、digest 前缀 e9ef779a6a52a482。**这两个 digest 是旧安装的历史记录，不是当前新源码的证明。**

---

## 4. 模块实施状态与具体接口

本节源码短路径均以 D:\Projects\DSH-Project\dsh-tui 为根；表中“通过”仅指对应定向测试。

### 4.1 工具结果与轮次结算：已实现并接入 Frame

关键文件：

- src/dsh/session-event-adapter.ts
- src/runtime/events.ts
- src/transcript/state.ts、src/transcript/reducer.ts
- src/presentation/tool-outcome.ts、execution-trace.ts、agent-request.ts
- src/presentation/tool-card-renderers.ts
- src/ui/frame.ts、src/ui/conversation.ts

接口/事实：

~~~ts
toolResultStatus(result): 'done' | 'failed' | 'cancelled'
toolRowStatus(row): 'running' | 'done' | 'failed' | 'cancelled'

ToolRow.turnEnd?: {
  seq: number
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
}

executionTraceProjection(turn, tools): ExecutionTraceProjection | undefined
// status: 'done' | 'failed' | 'interrupted' | 'cancelled'
~~~

- 显式保留官方 tool-result.isError，包括 false；不扫描输出的 Error 字样。
- isError=true 或外层 error 是失败；ABORTED / ABORTED_BEFORE_DISPATCH 是取消。
- 无 result 但真实整轮取消的工具显示 cancelled；之前已成功的工具保持成功，不被后来的整轮取消抹掉。
- turn/end 只给同 turn 的现存工具行附加常量大小摘要；依附已有有界 rows，不增加无界 map。
- 摘要在后续 turn、journal 256 事件尾部淘汰、同 key 晚到 result 后仍保留。
- **不再以“有最终文字”推断整轮成功。** executionTraceProjection 从三参改成两参；旧 hasAnswer 不要加回去。
- “工具步骤完成”和“请求最终成功”分别表达；只有真实成功结束事件才出现 request succeeded。
- frame 三处工具状态投影已改用 toolRowStatus，旧 executionTraceProjection 函数已移到独立模块；cancelled 类型及 badge 已加入。
- 最后独立验证 54 tests、4 源模块四项 100%；见第 8 节。Retained 新 badge 分支的全套覆盖仍需整合跑。

### 4.2 审批证据与官方权限：逻辑已实现，布局尚有缺口

关键文件：

- src/interaction/port.ts、src/interaction/editor.ts
- src/dsh/approval-evidence.ts、permission-facts.ts、interaction-hub.ts、session-permissions.ts
- src/permission/port.ts、policy.ts、picker.ts
- src/ui/approval-dock.ts、permission-workspace.ts
- src/presentation/approval-layout.ts
- src/app/controller.ts、src/ui/frame.ts

ApprovalEvidence 包括 source、原始 arguments、cwd、currentPermission、requestedPermission、missing。approvalEvidenceError(item) 同时供编辑器和 Adapter 使用。

- 以精确 Agent/Session/callId/toolName 关联 tool/call 或 tool/code-dispatch-start，保留 approvalId owner 校验。
- 缺失、重复、已结束、不匹配或响应前证据变更都不能允许；不是只把 UI 按钮涂灰。
- permission metadata 来自官方服务，支持合法 host-plane fallback，但仍精确到 Session。
- 普通审批 selectedIndex=0 是 Allow once，1 是 Reject，**默认 1**。
- 数字 1=Allow once、2=Reject；左右切动作，Enter 确认；上下只改 scrollOffset，Esc 拒绝。
- permission picker 的 confirmation.selectedIndex 则 **0=Cancel，1=Confirm，默认 0**。两种索引语义不同，不能混用。
- preset selection 的确认 proof 包含 fromValue/toValue/generation/currentPermission/targetPermission，写入前复核。
- /permission <value> 已拦截进同一 picker 确认，不再绕过到 generic command。
- sandbox 收紧但 never→ask 仍可能增加可获授权能力；不要简单按 sandbox 名字排序判定“无需确认”。

Approval dock：

~~~ts
buildApprovalDock(item, snapshot, input, columns, maxRows): ConversationDock
// inline: true; lines + styledLines; header/actions/footer 常驻，body 滚动
~~~

- 显示实际参数、cwd、权限、理由、证据来源和队列；range 标识当前可见正文。
- 4 行可容纳固定三行 + 一行证据；width<40 或 height<4 只显示过小提示。
- 缺证据固定显示 Allow disabled；完整 missing 在正文可滚动。
- 控制字符/双向控制字符转为字面转义；处理了 truncateToWidth 可能注入 ANSI reset 的问题。
- 单字段显示最多 65536 字符并标记 truncated，Adapter 原始证据不改。长审批完整可达性/截断后的审阅安全仍需实屏验收。

**交接重点：**

1. approvalLayoutBudget 已实现，Controller 小屏 Allow guard 已接；Frame 未接，详见第 5 节。
2. renderPermissionWorkspace 已被 frame 调用，**但 /permission 当前仍被外层作为 compact 浮窗包装**：
   - legacyWorkspaceDescriptor 对 permissionPicker 返回 undefined。
   - renderDshFrame 使用 renderSecondary('compact', ...)。
   - 因而“独立 permission renderer 已完成”不等于 Permission Presets 已符合统一目录外壳。恢复后必须修正并补真实入口测试。
3. 审批 Flat 已显示 inline，Retained dock 尚会被 VStack shrink 裁掉按钮。
4. Controller 小屏安全修复观察过 red，但补 guard 后最后组合测试被中断，不能称最终绿色。

### 4.3 导航与新 Feature Workspace：已实现，旧目录不完全等价

关键文件：

- src/app/feature-host.ts、feature-surface-runtime.ts
- src/navigation/commands.ts、preferences.ts 及 state/keymap
- src/features/*/factory.ts、machine.ts、nodes.ts
- src/presentation/feature-surface.ts
- src/layout/strategy.ts
- src/ui/feature-surface-frame.ts
- src/terminal/input.ts

已做：

- Esc 返回不排在业务 Promise 后；navigationGeneration 阻止旧队列和迟到 openRoute 回跳。
- 已开始的模型/模式切换或设置写入仍跟踪真实结果；Esc 不是撤销已经提交的操作。
- Settings 已处理迟到 revision、CAS/重开 snapshot，不以旧页面结果覆盖新状态。
- ShiftTab 编码为 { type: 'complete', reverse: true }。
- 新 Feature Normal 下 /、i 搜索，Enter 回列表；Settings Enter 进入编辑，Normal h/l 不偷偷改设置。
- 共享 featureListViewport、featureDetailViewport、createFeatureDetailSurface。
- UiNode 可选 hasContent()/scroll(delta)；runtime 投影可见性，Host 把详情 j/k、方向键、PageUp/Down 路由给本地滚动。
- 新 LayoutStrategy 按 <100 / 100–139 / >=140 处理真实区域；无内容 Inspector 不占位。
- 修过局部 keymap 抢占详情 j/k 的真实 Host 回归。
- 100 次 Resize 不增加 loader 调用；主题/Resize 不重新构造 Feature。

旧目录适配：

- src/ui/legacy-workspace.ts：renderLegacyWorkspaceFrame(viewport, descriptor, render)
- src/ui/legacy-workspace-routing.ts：legacyWorkspaceDescriptor(view)
- src/ui/workspace-rows.ts：secondaryModalFrame(viewport, rows, cursor?, splitLeftColumns?)
- src/ui/workspace-context.ts
- src/ui/workspace-request-recovery.ts
- src/ui/workspace-model-route.ts
- src/ui/context-metrics.ts

已从 Frame 抽出 Context、Attempts/Recovery、Route 与公共 metrics/rows helper，保持原公共重导出。Activity/CapabilityLens/Runtime 和 Recovery/Route 已传明确 leftColumns。

不要按正文里的 │ 猜分栏：此问题已由明确 styleSpans 几何修复。还修了单列失焦选中背景、极窄宽度 ANSI reset/溢出、Context CRITICAL 被错染成选择蓝色等问题。

**仍需完成，不可当成可选小修：**

- 旧 Tools/Skills/MCP query cursor 恒在；旧 view 尚无新 Feature 的 searchFocused/Normal-Insert 合同。
- wrapper 目前统一的是外框和样式，**不证明所有旧目录都已拥有相同断点、独立详情滚动和键盘模式**。
- 用户明确要求“所有现有用户可达目录/详情统一”，因此要逐页核对，不可仅靠 wrapper 存在就勾选完成。
- Runtime 页脚清理旧 Esc namespaces 时可能留孤立 namespaces 文案。
- 最终七模块 coverage 尚未重跑，旧报告 branches=98.4%。

### 4.4 Composer、对话密度与主题：部分落地，断点在 Retained

已有落盘：

- 普通 Composer 固定弱边框、无 PROMPT；attachments rail 已移入 Composer 内容。
- Frame Flat 增加 timeline 与输入区分隔、inputBackground/panelBackground 语义。
- ConversationDock 新增 inline?: boolean；inline 走纯 styled lines，避免再次画一张工具卡。
- palette 新增 panelBackground、inputBackground、selectionBackground、inactiveSelectionBackground，沿用既有主题系统和降级。
- 顶层 transcript 保持终端背景；没有修改用户 Windows Terminal 配置。
- 用户/assistant 间距规则和 Compact/Verbose 已有之前实现，仍要通过最终屏幕验证。

未完成：

- ConversationSurface 未声明 composerMaxRows/composerDisabled。
- ComposerComponent 仍固定 6 行，frame 局部 maxRows 未进入 Retained surface。
- CURSOR_MARKER 未按审批 disabled 抑制。
- 小宽度/unboxed fallback 未整行补齐 inputBackground。
- maxRows=1/2 的 boxed 分支仍可能产出至少 3 行。
- VStack dock shrink=1/minSize=0/maxSize=12，可裁掉操作；inline 时 footer/dashboard/timeline 尚未按预算让位。
- 旧 conversation.spec.ts 仍有对已移除内部 attachments component 的访问。
- 当前阶段不可声称“新视觉完成”，更不能把高覆盖率等同于好看/好用。

### 4.5 Clipboard：底层与 Controller 接线完成，真实系统验收未做

关键文件：

- src/attachment/port.ts、composer.ts
- src/terminal/clipboard.ts、input.ts
- src/dsh/runtime-port.ts
- src/runtime/tui-session-port.ts
- src/app/controller.ts

接口：

~~~ts
type ClipboardContent =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: PromptImageBytes }

interface ClipboardPort {
  read(options?: { signal?: AbortSignal; maxImageBytes?: number }): Promise<ClipboardContent>
}

// 对旧 embedder 保持可选：
SessionAttachmentPort.prepareImageBytes?(image, signal?)
DshTuiControllerOptions.clipboard?: ClipboardPort
~~~

- 只有用户明确触发 Ctrl+V 或 /paste-image 才读取；无后台监听。
- Windows 隐藏 pwsh -NoProfile -NonInteractive -STA helper；内存流 PNG/base64 stdout，无临时图片。
- 5 秒超时、Abort、有界 stdout；默认 image 20MiB、硬上限 32MiB、text 1MiB；最终入选仍服从官方附件限制。
- 字节和路径准备共享官方 validateImage；路径与剪贴板共享数量/总大小约束。
- Ctrl+V 普通文本进入草稿；/paste-image 只接图片；/attach <path> 保留。
- 普通路径文本不应自动变附件；新 session 必须在真实 bracketed-paste 与 Ctrl+V 路径验收。
- pending、取消、binding epoch、失败保留草稿与已有附件已接。
- renderer 只收到安全 PromptImageView，不接字节/base64/本地路径。
- fake process 测试与 PowerShell AST/parser 检查通过；**尚未真实读取系统剪贴板，也未真实模型发送图片验收**。

### 4.6 Agent guidance 与 time-context：已实现，官方发布包已核验

关键文件：

- src/dsh/agent-guidance.ts
- src/compat/dsh-rc2/agent-bootstrap.ts
- src/dsh/runtime-port.ts、cold-resume-coordinator.ts
- src/compat/dsh-rc2/profile-policy.ts
- cordis.patch.yml、package.json、pnpm-lock.yaml

installDshAgentGuidance(agentCtx)：

- section 名 dsh-tui:agent-guidance，order=50，非 complete。
- 有 systemPrompt 时验证 scopeOf(agentCtx) === agentCtx.agent，防止误注册成全局。
- preset mount 后、downstream setup/Agent publish 前安装；disposer 跟随原 Bootstrap rollback/scope。
- create/fork 和 cold resume 已接；不对借用的外部 live Agent 强行追补 prompt 所有权。
- 没有 systemPrompt 时兼容 seam 返回 undefined；最终真实产品交付仍必须验证 guidance 确实存在，不能把静默缺能力当成本批功能通过。
- 保留 complete prompt 优先级、项目指令和官方 section。

time-context：

- 精确依赖 @deepseek-ai/dsh-time-context@0.1.1-rc.2。
- dsh-scope、dsh-system-prompt 按现有惯例精确 dev+peer。
- Cordis time-context row 已加，refreshIntervalMs: 0（每次 eligible pre-step）。
- 已实际获取 registry tarball，不以本地同版本号目录代替发布证据。
- tarball integrity：
  sha512-4Q1sCr06SfJ7jkhrvfdg8ZSFp5Ohtl4E9nH19nUbIjcGK8F5yA2h68HPEglztDo54vxI5HZSblLIjdGKZkY+FQ==
- 发布包 lib/index.js SHA256：
  b89daa446c540d684bb96c5dde073689ebee22ffed4a952edc9cdbe529cbaefc
- 证据目录：
  D:\Projects\DSH-Project\dsh-tui\.artifacts\registry-time-context-bd2d515df01347ce92ecd88f2b4a3e28
- tests/dsh-time-context-contract.spec.ts 固化版本、integrity 和入口 hash。
- 已测首次请求、跨日、恢复首步、进程时区、取消/卸载、plugin snapshot；不创建可见用户 turn，不增加工具步骤数。
- **没有进行实际 LLM 行为验收**。snapshot 正确不等于模型一定遵守规范。

### 4.7 测试隔离：默认根隔离完成，所有 Storage 配置审计未完成

- vitest.config.ts 已设置 setupFiles: ['tests/setup.ts']。
- setup 在各测试导入 DSH 前创建 mkdtemp 独立根，设置 DSH_HOME/DSH_AGENTS_HOME。
- isAbsolute(relative(...)) 跨盘、父目录、异常 basename guard 已补；cleanup 只使用捕获的原始 mkdtemp 路径，不取后来被改写的环境变量。
- tests/test-home-isolation.spec.ts 有 fake-fs VM 负面测试，跨盘 case 先 red 后 fix，最后 8 tests 通过。
- 官方 dsh-home-paths 优先 DSH_HOME 已核对。
- **当前依赖没有查到 DSH_AGENTS_HOME 消费者，不能据此宣称隔离了真实 agents 库。**
- 官方 E2E 有明确临时 storage.root；所有真实存储 fixture 的逐项 storage.root 审计尚未做完，应在恢复后先审计再运行可能访问真实服务的测试。
- 不清理历史 Session 来掩盖旧测试污染。

---

## 5. 第一优先：完成共同审批预算与 Retained Composer

共享 helper 已经存在：

D:\Projects\DSH-Project\dsh-tui\src\presentation\approval-layout.ts

~~~ts
approvalLayoutBudget({ columns, rows }): {
  dockRows: number
  compactOnly: boolean
  canInspect: boolean
}
~~~

当前算法：

- rows floor 且至少 1。
- rows<13：compactOnly=true，dockRows=min(12, rows)。
- rows>=13：dockRows=min(12, rows-9)。
- canInspect=columns>=40 && dockRows>=4。

这是为安全门与 UI 共用的预算，不要在各层复制 40/13/9 常量。

### 5.1 当前错位

- Controller 已以 canInspect 阻止 allowed-once；拒绝和 Esc 不受阻。
- Frame 仍以 Math.min(12, Math.max(1, rows-7)) 建 dock。
- Frame 没有 compactOnly 分支。
- Frame 虽局部计算 composerMaxRows，只有 Flat layout 用到，ConversationSurface 未投影。
- 新 tests/conversation-renderer.spec.ts 已引用两个尚不存在的 Surface 字段，导致 typecheck 红。

### 5.2 接线步骤

1. Frame 引入 approvalLayoutBudget。
2. compactOnly 时优先返回纯审批区域的 frame，实底、无 overlay、无 cursor；普通草稿只是暂不显示，不能清空。不能为了显示 Composer 把审批操作裁掉。
3. 正常高度用同一 dockRows；预留 header/separator/composer/status 的预算。
4. 给 ConversationSurface 添加可选 composerMaxRows、composerDisabled；Frame 投影实际预算与是否审批。
5. Composer 渲染与 VStack 测量采用同一 maxRows；小于 3 行时不能硬画 3 行边框，退化为有限实底行。
6. disabled 仅抑制光标，不吞按键。审批输入仍必须送到 Controller。
7. inline dock 固定完整高度，不能 shrink 裁动作；让 footer/dashboard/timeline 根据余量让位。
8. 审批 Flat 和 Retained 都检查样式、草稿、按钮、range、Esc；任何 one-off 小屏保护都必须与安全 canInspect 一致。
9. 更新旧内部附件 component 测试为用户可见“附件位于 Composer 内”测试，不重建冗余 attachment rail。
10. 小屏安全 guard 补丁后的 Controller 测试必须跑到结束；目前只有先失败证据，没有最终绿色记录。

极小窗口（1–3 行）无法提供完整操作，应清楚提示扩大窗口/拒绝，并禁止 Allow。不能只画 disabled 字样但仍允许键盘绕过。

---

## 6. 后续必须补齐的产品验收

### 6.1 按页面而不是按 renderer 文件验收

至少逐一打开并退出：

Sessions、Models、Modes、Skills、Tools、MCP、Diff、TUI Preferences、Harness Settings/Plugins、Connections、Activity、Context、Attempts、Route、Permission Presets。

每页记录：

- 经真实 Host/Controller 命令到达的路由，而不只是直接调用 renderX()。
- 当前是目录还是短确认/认证挑战。
- 默认焦点、搜索进入/退出、hjkl、Tab/ShiftTab、Enter、Esc。
- 空/错误/loading/ready/refreshing 状态。
- 选中项跟随 viewport、详情独立滚动、CJK/长路径。
- 80/100/140/200 列和低高度；Layout 变化不额外加载。
- 返回 Chat 的 draft/attachments/focus/scroll anchor。
- 模型/模式/Settings 写入中 Esc 立即离页，迟到成功/失败/CAS 冲突如实结算、不回跳。

旧目录当前没有完全统一 Normal/Insert，这是计划内剩余工作，不能把“旧模块兼容”作为无限期免验收理由；同时不要借机另起框架。

### 6.2 原计划剩余总清单

- [ ] 所有真实 Storage 测试路径隔离审计。
- [ ] 工具实时、回放、Compact、Verbose、取消/恢复的一致实屏验证。
- [ ] 审批完整证据滚动、默认拒绝、队列、小屏 fail-closed、shutdown settlement。
- [ ] Permission Presets 真正进入一致的目录外壳，升权确认保持独立语义。
- [ ] 新旧目录统一可中断导航、焦点、选中跟随和完整详情可达。
- [ ] Composer 两套渲染一致、附件位置稳定、间隔/背景/光标正确。
- [ ] Markdown 紧凑但保留代码块空行与必要段落；整轮之间一行。
- [ ] Compact 详细工具/diff renderer 调用次数为零；Ctrl+O 草稿/焦点/锚点不丢。
- [ ] Orb 提交即时、首字停止、终态释放、不反复使历史缓存失效。
- [ ] 真系统剪贴板：图像、文本、路径、终端拦截、超限、不支持图片、失败/取消/Session 切换。
- [ ] guidance/time 的真实 profile 装配、两个 Context 隔离、complete prompt、卸载。
- [ ] 真实模型五类行为：简单问答、项目扫描、修改与验证、工具失败、审批拒绝。
- [ ] 用户 README 与实际命令/页面一致；不要把这份工程交接书当用户 README。
- [ ] 全部门禁、实屏、打包/安装、两包 digest、失败回滚。
- [ ] 最终 diff 逐项可追溯本计划，不掺入无关性能债。

---

## 7. 自动回归里的已知坑

- tests/repair-frame.spec.ts 最初有不合法 SurfaceOp fixture，已经改为 **surfaceOp: 'append'**。不是 { kind:'append' }，也不是为了 append 构造 replace 对象。
- PromptImageView 只有安全 name/mediaType/bytes；不要给 renderer fixture 添加 id/width/height 等不属于它的字段。
- tests/frame.spec.ts 用 JSON.stringify(nodes).not.toContain('one') 判断工具正文泄漏，会误匹配 revision 中的 **done**。应只检查展示文本/内容字段或使用唯一哨兵，不删除安全断言。
- 同一测试中“final text 存在 + 一个失败工具”不再意味着 recovered success，必须加真实 turn/end 事实，或者期待失败摘要。
- 旧测试依赖 overlay 是否存在判定页面关闭，现在目录 overlay===undefined 但仍打开。应检查 route/页面标题/Workspace 外壳，不把它当作“已回 Chat”。
- 旧断言 “▌ Permission request”、单行 composerBoxed=false、目录在 centered modal，已不符合当前合同。
- 无证据的 synthetic approval 现在必须 fail closed。要验证允许流程，就给真实结构的 evidence；不要取消校验迁就 fake。
- 假 Agent Context 必须用官方 createScope 等构造真实 scoped 环境，不绕过 guidance 的 scope guard。
- 截断辅助函数可能为纯文本加入 ANSI reset；传入 UiFrame 的 plain rows 要再清理。
- 分栏必须使用几何/styleSpans；不要 split('│')，正文可能含同一字符。
- `.artifacts/coverage/` 下的历史报告很多来自更早工作（原根目录 coverage / coverage-* 已于 2026-09-06 归档）。没有 ownership 证据不要批量删。
- 中断后的原测试进程是否完全退出未确认；旧 cell 不可恢复。检查精确本仓库测试进程，不要 taskkill 所有 node（可能是用户其他服务）。

---

## 8. 验证台账：不要混淆时间点

### 8.1 修改前完整基线

本轮动实现前执行 pnpm run verify：

- 147 个测试文件、1645 个测试通过。
- per-file 四项 coverage 100%。
- 官方 DSH E2E、build、import、loader 通过。
- E2E 使用 fake provider + 真实 ConPTY，不是实际 LLM 评估。

这是 **修改前** 的可用基线，不是当前结果。

### 8.2 修改后局部结果

| 范围 | 最后有完成输出的结果 | 不能外推的结论 |
|---|---|---|
| Tool outcome / execution-trace / reducer / state | 54 tests；4 源模块四项 100% | 不代表整个 UI 已通过 |
| 审批证据/权限逻辑早期范围 | 5 suites / 66 tests 通过 | 后续 Controller/UI 已继续变化 |
| Navigation 批次 | 20 files / 250 tests；限定源 coverage 100% | 不涵盖所有 legacy 目录 |
| 新 Feature Workspace 批次 | 17 files / 195 tests；限定源 coverage 100% | 不是最后整仓 coverage |
| Clipboard 底层 | 124 tests / 9 files；4 底层源 100%；PowerShell parser 通过 | 未测真实剪贴板/真实图像发送 |
| Guidance/time | 10 suites / 115 tests 通过；guidance+bootstrap 100% | 无真实 LLM；更宽 coordinator 范围有原有缺分支 |
| Permission workspace 独立模块 | 8 tests，四项 100% | 外层仍可能是 compact 浮窗 |
| Approval dock 独立模块 | 7 tests，四项 100% | 不证明 VStack 保留按钮 |
| approval-layout | 2 tests，四项 100% | Frame 尚未使用 |
| test-home-isolation | 8 tests 通过，2026-09-05 21:26:56 | 未审计所有 Storage root |
| frame-renderer + legacy-workspace | 54+30=84 tests 通过，2026-09-05 21:37:38 | 最终限定 coverage 未重跑 |
| repair-frame | 新增 6 项先红后绿（与 frame.spec 联跑时这份通过） | 后续还需重跑 |
| frame.spec | 最后 30 tests 中 7 fail / 23 pass | 待更新合同与小屏接线 |
| conversation-renderer | 最后 6 tests 中 4 fail / 2 pass，2026-09-05 21:42:22 | 4 项实现尚未写 |
| Controller+editor | 更早 238 tests 全绿并限定3源100%；最后完成全量是194 pass /44 fail | 44项是在旧 Workspace 断言批量更新前；更新后命令被中断无最终结果 |

.artifacts/coverage/legacy-workspace/coverage-summary.json 是 21:21 旧报告：statements318/318、functions47/47、lines280/280、branches371/377=98.4%。之后对应六个分支的测试已补并在84项测试通过，但**没有再次 coverage 结果，不要写100%**。

更宽 guidance/cold-resume 独立覆盖曾留两个原有 external applicationScopes 分支；不要修改 DSH 行为来追覆盖率。

### 8.3 最新 typecheck：7 处错误（主 Agent 于 2026-09-06 重新执行）

命令：pnpm run typecheck。返回 exit code 2。

~~~text
src/ui/frame.ts(37,3): TS6196 PermissionPickerRow 未使用
src/ui/frame.ts(112,3): TS6133 conversationAttachmentRail 未使用
tests/conversation-renderer.spec.ts(44,50): TS2353 composerDisabled 不存在于 ConversationSurface
tests/conversation-renderer.spec.ts(82,9): TS2353 composerMaxRows 不存在于 ConversationSurface
tests/conversation-renderer.spec.ts(98,68): TS2353 composerMaxRows 不存在于 ConversationSurface
tests/conversation-renderer.spec.ts(123,57): TS2353 composerDisabled 不存在于 ConversationSurface
tests/legacy-workspace.spec.ts(197,11): TS2322 reason 被推宽为 string，非 initial|resume|change
~~~

行号会随修改漂移，按符号定位。前两个移除 orphan import；四个 Surface 字段应完成实现而不是删测试；最后一个修复 fixture 的字面量类型。

### 8.4 Retained 4 个真实失败

1. 13 行 viewport 审批 action/footer 被 VStack 裁掉。
2. composerMaxRows:1 实际产生 6 行。
3. 8 列 Composer 只有 4 列可见内容，背景未整行填满。
4. composerDisabled:true 仍输出 CURSOR_MARKER。

两个通过项也有限制：直接构造 tiny dock 绕过 Frame/Driver，不证明完整小屏链路；首字测试验证上游已清除 agentRequest 后 renderer 释放计时器，不独立证明 Controller 的全部首字识别。

---

## 9. 推荐续接命令

以下是交接命令，不代表本次交接执行过它们。先读脚本并确认隔离；失败后停止相应阶段，不把后面的命令照抄到底。

### 9.1 只读确认

~~~powershell
Set-Location -LiteralPath 'D:\Projects\DSH-Project\dsh-tui'
git status --short --branch
git rev-parse HEAD
$PSVersionTable.PSVersion.ToString()
node -v
pnpm -v
Get-Content -LiteralPath '.\AGENTS.md'
Get-Content -LiteralPath '.\.artifacts\repair-2026-09-05-baseline.json' -TotalCount 12
~~~

### 9.2 第一组失败与安全回归

~~~powershell
pnpm run typecheck
pnpm exec vitest run tests/approval-layout.spec.ts tests/approval-dock.spec.ts tests/repair-frame.spec.ts tests/conversation-renderer.spec.ts
pnpm exec vitest run tests/controller.spec.ts tests/interaction-editor.spec.ts tests/test-home-isolation.spec.ts
pnpm exec vitest run tests/frame.spec.ts tests/frame-renderer.spec.ts tests/conversation.spec.ts tests/legacy-workspace.spec.ts
~~~

按阶段单独执行、查看每次结果。不要同时运行多个写同一个 coverage 目录的进程。

### 9.3 可重建的结果真值限定覆盖命令

~~~powershell
pnpm exec vitest run tests/execution-trace.spec.ts tests/transcript-reducer.spec.ts tests/tool-outcome.spec.ts tests/bounded-state.spec.ts --coverage --coverage.include=src/presentation/execution-trace.ts --coverage.include=src/presentation/tool-outcome.ts --coverage.include=src/transcript/reducer.ts --coverage.include=src/transcript/state.ts --coverage.reportsDirectory=.artifacts/coverage/execution-trace
~~~

覆盖命令中的输出目录为可再生测试产物，但只可清理本次明确拥有的目录。

### 9.4 最终门禁

~~~powershell
pnpm run verify
if ($LASTEXITCODE -ne 0) { throw '完整门禁失败，禁止安装当前包。' }
~~~

当前 verify 实际串联：

typecheck → test:coverage（排除官方 E2E）→ test:standard-agent-e2e → build → import-built.mjs → loader-built.mjs。

scripts/official-dsh-e2e.ps1 会检查现有 Harness 构建是否新鲜；缺失/stale 时拒绝，不会偷偷构建 DSH 核心。它可以按需构建 TUI/Orbs。若因 Harness 构建过期失败，单独报告环境依赖，不擅自编辑 Harness 源码。

ConPTY/VT 用例属于必须门禁；检查 test:coverage 的真实执行结果，不能把 skip 当 pass。官方 E2E 与自定义真实 profile 启动还需单独核对装配、退出、资源释放。

---

## 10. 打包、安装、回滚与试用

### 10.1 现在不要运行安装

本轮未完成门禁。当前 lib 可能仍是旧构建，src/ 与已安装包不一致正常；不要用“旧 lib 校验成功”证明新源码已安装。

scripts/pack-local.mjs 现在自己构建 Orbs 和 TUI，再成对打包。不要使用早期对话中的过时 pack 命令假设。

### 10.2 门禁通过后

先备份本次会影响的 profile package.json、lockfile、Cordis 装配配置（若安装路径会修改），记录旧两包引用；备份不能包含无关 secrets，也不能移动用户 Session。

只打包：

~~~powershell
Set-Location -LiteralPath 'D:\Projects\DSH-Project\dsh-tui'
pnpm run pack:local
if ($LASTEXITCODE -ne 0) { throw '打包失败。' }
~~~

预期打印两条绝对路径：

~~~text
DSH_TUI_ORBS_TARBALL=...
DSH_TUI_TARBALL=...
~~~

**以本次脚本输出为准，不用 Get-ChildItem 最新时间猜本次包。**

安装并校验（脚本会再次打包）：

~~~powershell
$previousDshHomeForRepair = $env:DSH_HOME
try {
    $env:DSH_HOME = 'C:\Users\30553\.dsh'
    & pwsh -NoLogo -NoProfile -File '.\scripts\install-local.ps1' -Profile tui
    if ($LASTEXITCODE -ne 0) { throw '安装或校验失败，进入既定回滚流程。' }
} finally {
    if ($null -eq $previousDshHomeForRepair) {
        Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    } else {
        $env:DSH_HOME = $previousDshHomeForRepair
    }
}
~~~

显式 DSH_HOME 是为了不误装 sandbox 用户的目录，不是改变 HOME。新 session 如发现用户实际改过 DSH_HOME，先核对目标，不静默覆盖其他 profile。

真实启动命令：

~~~powershell
& node 'D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js' --profile tui
~~~

也可已有 pnpm run dev:profile（安装并 Launch），但自动化验收不要随意创建可见新窗口；helper 隐藏运行。用户交互试用才需要可见终端。

验证器接口：

~~~powershell
& node '.\scripts\verify-installed-package.mjs' `
    'D:\Projects\DSH-Project\dsh-tui' `
    'C:\Users\30553\.dsh\profiles\tui\node_modules\dsh-tui' `
    'D:\Projects\DSH-Project\pi-tui-orbs' `
    'C:\Users\30553\.dsh\profiles\tui\node_modules\pi-tui-orbs'
~~~

必须看到主包与 Orbs 校验均通过，并记录本次 files/digest/tarball。版本号相同不等于安装内容相同。

### 10.3 回滚还不是自动完成的能力

当前 install-local.ps1 出错时主要是 throw，**没有已经验证的自动回滚事务**。原计划要求安装/启动失败恢复本次安装影响的版本，所以在真实安装前要准备并验证恢复路径。

- 上一版两个内容寻址 tarball 在第 3 节，不要删除。
- 恢复只针对本次改变的包/manifest/lock/config；不要恢复或清空 Session/Settings 用户数据。
- 重装旧包后仍核对 profile 引用、Loader 和启动，不把 pnpm 返回成功当全部恢复。
- 本手册不授权批量改写用户目录；目标不明确先停止。

### 10.4 交给用户的试用清单

完成后至少提供这些可操作步骤：

1. 简单问答：提交即反馈、首字 Orb 停、两轮间一行。
2. 项目扫描：Compact 一行执行摘要，Ctrl+O 查看全会话详情再折叠，草稿不丢。
3. /models、/modes、/sessions、/skills、/tools、/mcp、/settings、/preferences：进入、搜索、hjkl/Tab、一次 Esc 返回。
4. /permission：当前权限可见、扩大范围默认取消、never 说明准确；触发真实审批并拒绝，Agent 不绕权限。
5. 图片：截图复制后 Ctrl+V；终端拦截时 /paste-image；文本/路径粘贴保持文本；失败保留草稿。
6. 拉窄、低高度、滚动长内容与审批；没有按钮消失或页面困住。
7. Ctrl+C/shutdown 后终端恢复，用户无需手动修复回显/光标。

真实 LLM 五类人工验收与 fake-model 自动验收分开记录，不因为 prompt snapshot 通过就宣称行为通过。

---

## 11. 新 session 并行工作建议

不必复活旧 Agent；按新环境可用能力重新分工。旧名字仅作为责任历史：

| 旧 Agent | 已完成领域 | 新会话建议 |
|---|---|---|
| approval_safety / Copernicus | approval evidence、permission、安全 renderer、guidance/time；Retained 只留下失败测试 | 新子任务可独占 conversation.ts + conversation tests，先补实现 |
| navigation_fix / Hubble | Host 导航、新 Workspace、legacy wrapper、Context/Route/Attempts 抽取、frame-renderer tests | 新子任务核对旧目录完整合同/最终 coverage |
| result_truth / Goodall | 工具状态、turnEnd、Clipboard、Controller glue、测试隔离 | 新子任务验证 Controller 安全小屏与存储隔离 |
| root | Frame 整合、固定 Composer/inline dock、全局验证与发布 | 唯一负责共享 Frame 最终接线和发布 |

避免两个 Agent 同时编辑同一个 frame.ts/controller.ts/测试文件；需要共享时明确函数范围和 ownership。记录每次定向验证针对哪个文件快照，完成后由主 Agent 跑统一门禁。

本轮使用过 Impeccable 的 harden/craft-floor，重点是实际边界情况、长文本、背景和可操作性，并未使用 Figma。新 session 如继续用该 skill，应重新按其规则读取：

- C:\Users\30553\.agents\skills\impeccable\SKILL.md
- 同目录 reference/harden.md、reference/craft-floor.md

不要因 skill 流程再问已经确认的品牌/布局选择；用户计划优先。不要把 web CSS 的字号规则生搬进字符终端。

---

## 12. 新 session 启动提示词（可直接复制）

~~~text
请继续 D:\Projects\DSH-Project\dsh-tui 的既定修复工作。

先完整阅读：
D:\Projects\DSH-Project\dsh-tui\docs\HANDOFF-2026-09-06-REPAIR.md
D:\Projects\DSH-Project\dsh-tui\AGENTS.md
D:\Projects\DSH-Project\dsh-tui\PRODUCT.md
D:\Projects\DSH-Project\dsh-tui\docs\development.md

这是同一本地脏工作区的续接，不要从干净 HEAD 重新实现，不要 reset/clean/checkout，也不要改 deepseek-harness 核心、Desktop 或此前搁置的性能债。

当前主要逻辑已实现但未发布。优先复核 typecheck 的7处错误，完成共享 approvalLayoutBudget 到 Frame 的接线，以及 ConversationSurface.composerMaxRows/composerDisabled、Retained 审批不被裁和输入框背景/光标修复。新增失败fixture应保留。

随后逐页补齐旧目录尚未完成的键盘/滚动/响应式合同，特别是 Permission Presets 仍被compact浮窗包装的问题。请按交接书区分历史局部通过与当前整仓结果，不要声称已经全部完成。

完整验证、ConPTY/实屏操作通过后，直接打包并安装到真实 tui profile，校验主包与Orbs digest，再给我试用步骤。安装前保留可回滚包和配置，不碰用户Session数据。先用简短进度说明开始，然后继续实施。
~~~

---

## 13. 交接文档本身的边界

- 本文不会自动恢复旧聊天、图片或工具进程；真正续接依据是同一工作树及这里记录的合同。
- 用户截图在旧对话及系统 Temp 路径中，可能过期。不要把临时图片文件存在当作新 session 前提，也不要重生成设计图代替修复。
- PRODUCT.md / README / docs/development.md 是上下文，不等于本轮验收证明；若与本手册记录的最新用户决定冲突，以当前修复计划为准。
- 未把本手册写入全局 memory，未创建新任务，未提交或推送。
- 若新 session 发现现状与本文不同，先读当前文件和测试结果，再记录差异；不能为了对齐这份快照反向覆盖更新的用户工作。
