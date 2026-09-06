# DSH-TUI 修复交付记录 · 2026-09-06

本记录对应同一 dirty 工作区的交接续修；不替代原始 [HANDOFF](HANDOFF-2026-09-06-REPAIR.md)。完整本地门禁、成对打包、真实 profile 安装与回滚演练均已完成；真实模型五类行为通过，系统剪贴板端到端仍需手动验证。

2026-09-06 用户实测反馈：审批含义与授权选项、二级页面的信息组织、重复模型命令、模型与 effort 的组合列表、设置页面等仍有明显体验问题，另有待继续复现的小 bug。本次按用户要求提交现有开发进度；工程门禁通过不代表产品体验验收完成，上述问题尚未修复。本文链接的 `.artifacts/` 验证产物仅保留在本地，不随 Git 提交。

**完成项与关键入口**

| 完成项 | 代码入口 |
|---|---|
| 审批使用共享尺寸预算，证据滚动受限；窗口不足以审阅时禁止允许和权限扩大，拒绝仍可用。80×6 支持完整紧凑审批，80×3 不可允许。Permission Presets 进入目录，扩大权限保持默认取消的短确认 | [approval-layout.ts](../src/presentation/approval-layout.ts)、[approval-dock.ts](../src/ui/approval-dock.ts)、[permission-workspace.ts](../src/ui/permission-workspace.ts)、[controller.ts](../src/app/controller.ts) |
| Flat / Retained Composer 对齐高度、实底、附件位置和审批期间的禁用光标；保留草稿及轮次间距，工具终态由真实事件投影 | [conversation.ts](../src/ui/conversation.ts)、[frame.ts](../src/ui/frame.ts)、[tool-outcome.ts](../src/presentation/tool-outcome.ts) |
| 旧目录补齐 Normal / 搜索、区域焦点、完整详情和分页；Sessions 支持过滤后的稳定选择、刷新与小屏状态。详情适配 80 / 100 / 140 / 200 列；不为没有内容的 Inspector 占位 | [legacy-directory.ts](../src/navigation/legacy-directory.ts)、[legacy-workspace-routing.ts](../src/ui/legacy-workspace-routing.ts)、[workspace-capability.ts](../src/ui/workspace-capability.ts)、[workspace-sessions.ts](../src/ui/workspace-sessions.ts)、[picker.ts](../src/session/picker.ts) |
| Diff 拒绝进入不支持的 Insert 模式，保留 h/l 折叠、[/] 切 hunk、Tab 切区域和一次 Esc；Preferences 与 Harness Settings / Plugins 继续分开 | [commands.ts](../src/navigation/commands.ts)、[feature-host.ts](../src/app/feature-host.ts)、[settings/nodes.ts](../src/features/settings/nodes.ts)、[workspace-runtime.ts](../src/ui/workspace-runtime.ts) |
| 原生 TTY 的 stderr 写入完成后异步全屏重绘；保留原始输出、回调与错误事件。启动失败取消排队渲染，退出释放挂钩 | [driver.ts](../src/terminal/driver.ts)、[stderr-redraw.ts](../src/terminal/stderr-redraw.ts) |

**已复现并修复的边界问题**

1. 权限扩大确认打开后缩小窗口，仍可能提交无法完整审阅的边界变化。现在 renderer 与 Controller 使用相同确认预算；窗口不足时禁止提交，取消可用。
2. Diff 按 `i` 误入没有搜索能力的 Insert，第一次 Esc 只回 Normal。真实 Feature + Host 回归先复现失败；现在能力检查覆盖所有非 Chat 页面，单次 Esc 返回，短交互与 Chat 输入语义保留。
3. Sessions 在 3 / 4 行窗口只剩标题、搜索和页脚，选中项或空、错误、加载状态不可见。现在 Normal 优先显示实际状态或选中项，普通 notice 随选中项显示，错误保留语义颜色；搜索时保留输入行。
4. 审批字段超过 65,536 字符后，Arguments 尾部无法查看却仍可允许。现在显示与提交共享边界：执行参数、cwd、工具/调用和审批/会话关联超限时禁止 Allow；拒绝仍可用。理由只提供解释，理由超限不会冒充执行证据缺失。
5. 旧 Session inspection 固定区裁掉长 cwd、preset 等元数据，且只支持方向键。现在被挤出的完整换行元数据进入滚动内容，支持 j/k 和 PageUp / PageDown，保留确认与 Esc 语义。
6. TypeScript runtime 的 Node warning 在首帧后覆盖 Composer 底边，后续增量渲染不修复。现在 stderr 保持原始写入，并在完成后请求全量重绘。另修复了启动失败后仍有排队渲染的问题；未启动的实例不提前排队。
7. 真实 MiMo 验收中，一次工具失败或审批拒绝后，模型正常结束回答会被描述为“恢复后成功”。现在 [execution-trace.ts](../src/presentation/execution-trace.ts) 保留失败 / 取消数量并显示 `request completed`，[agent-request.ts](../src/presentation/agent-request.ts) 使用 `Tool failed` 和 `Request complete · N tool failures`；不从 `turn/end` 正常完成推断故障已经恢复。

**已经实际通过的验证**

以下是不同时间点的验证范围，数量不能相加。单元测试和 fake-provider 终端测试不等于真实 LLM 验收。

| 范围 | 实际结果 |
|---|---|
| 正式 `verify` 内的 `typecheck` + `test:coverage` | 170 个文件、1955 项测试通过，0 skip；266 个源码文件逐文件 statements / branches / functions / lines 全部 100%（19246 / 15704 / 4022 / 17100） |
| 导航与旧目录局部快照 | 10 个文件、88 项通过；限定 8 个实现模块四项 100% |
| Diff 真实 Feature / Host / Surface 与导航回归 | 7 个文件、61 项通过；Host 和命令映射两源四项 100% |
| 完整 Frame 与 Sessions 回归 | 5 个文件、116 项通过；Sessions picker / catalog-filter / renderer 三源四项 100% |
| Controller 与审批 UI 合并回归 | 249 项通过；限定三个实现模块四项 100% |
| 最后一次审批与 Session inspection 回归 | 11 个文件、405 项测试通过，typecheck 退出 0；五个相关实现模块四项 100% |
| 原生 stderr 与终端生命周期回归 | 两个文件、44 项测试通过；两个实现模块四项 100%，无退出后渲染或未处理错误 |
| 真实失败 / 审批拒绝的中性状态文案 | 四条回归先失败后通过；三个测试文件 27 项通过，两源四项 100%，typecheck 退出 0 |
| Windows ConPTY smoke | 3 / 3 通过，0 skip：UTF-8 输入与 graceful、Controller / Driver 的 forced 路径、CP936 错误编码；forced 使用隔离 ApplicationPort fixture，CP936 在分配终端前验证 |
| 构建产物装配检查 | `node scripts/import-built.mjs` 与 `node scripts/loader-built.mjs` 均退出 0 |
| Orbs 局部验证 | typecheck、23 个文件 / 154 项测试通过，`demo:build` 退出 0；最终 paired pack 已重新构建 dist |

源码迁移仍是 **partial**：新 Feature 与 legacy Controller / Frame 分支并存，部分上游 catalog 仍由 legacy adapter 提前获得。完整的页面生命周期不代表所有底层数据已完全懒加载，也不代表中央模块已经彻底拆完。具体边界见 [development.md](development.md)。

Prompt 验证区分两条能力：`standard` 的工作规范是精确匹配的 scoped system prompt section；官方 `minimal` 使用 `complete: true`，恢复后仍只有原来的 persona section。独立的 `time-context` 在 pre-step 写入 user snapshot，恢复后的 `minimal` 仍有该时间快照。没有把工作规范强行追加到完整 prompt。

**最终包与安装记录**

| 项目 | 状态 / 结果 |
|---|---|
| 完整 `pnpm run verify`，包括最终官方 ConPTY E2E | **退出 0**：1955 项常规测试、8 项官方 E2E 检查、build、产物 import、Loader；[完整日志](../.artifacts/repair-2026-09-06-verify.log) |
| 逐页真实终端断点与操作矩阵 | **16 页 × 5 尺寸 = 80 个实屏**：80×24、100×30、140×30、200×30、80×6；模型调用增量全部 0。检查正文实际 cell 布局与画面稳定，排除 resize 中间帧；[screens](../.artifacts/official-e2e-workspaces-LQgYS2/screens.json)、[审批与 Ctrl+O](../.artifacts/official-e2e-workspaces-LQgYS2/interactions.json)、[请求用途与 Modes 持久事件](../.artifacts/official-e2e-workspaces-LQgYS2/request-lifecycle.json) |
| 主包 tarball 路径、大小与 SHA-256 | [dsh-tui-0.0.0-400e76bdc7c78e38.tgz](../.artifacts/dsh-tui-0.0.0-400e76bdc7c78e38.tgz)，774277 bytes；`400e76bdc7c78e38e4d69c6134e656b7217a650406db026772f705e0ccdfb531` |
| Orbs tarball 路径、大小与 SHA-256 | [pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz](../.artifacts/pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz)，71503 bytes；`897449175f1f2eb40c395770cd590fe1f5404d61450d91b36a64877f0fefc147` |
| 安装前回滚演练 | **最终新包安装启动 → 旧包恢复启动通过**；5 个配置文件恢复原 hash，旧两包 build digest 前缀为 `1474f3536853a412` / `e9ef779a6a52a482`。恢复脚本通过官方 `plugin add --force --offline` 显式重装旧 tarball，再恢复原 manifest / lock；避免同版本 hoisted 包仅恢复 lock 仍留有新文件。[演练日志](../.artifacts/repair-2026-09-06-upgrade-rollback.log)，恢复材料保留在 `.artifacts/repair-2026-09-06-install-recovery` |
| 新两包安装和 build digest 对照 | 实际 `C:\Users\30553\.dsh\profiles\tui` 引用上列 tarball；主包 1064 files，`2890b047d2a1711a8dc23f9602ef8c84b540f28eb9b74f6adf1dff0bef521be5`；Orbs 92 files，`e9ef779a6a52a4829e992538fb5bedafb1b97cf5bde5835d42f044c59661fa90`。与完整构建树逐文件一致，[安装摘要](../.artifacts/repair-2026-09-06-installed-digests.json) |
| 真实 profile 启动、退出与终端恢复 | **idle=true、hostReady=true、exit=0、finalBuffer=normal**；等 Loader 的 post-boot 装配就绪后退出，排空终端解析再检查终态。[安装日志](../.artifacts/repair-2026-09-06-install.log)、[实屏](../.artifacts/repair-2026-09-06-install-recovery/installed-startup-screen.txt)。临时 patch 隔离 Session / attachment / query，实际验收 Session 位于 `startup-data-JEoKvH/sessions`，没有使用真实用户 Session 存储 |

用户明确授权后，使用现有 Xiaomi MiMo 认证，仅发送隔离目录中自建的提示与示例文件，**五类真实行为全部通过**。统一证据见 [real-llm-validation-20260906.json](../.artifacts/real-llm-validation-20260906.json)。

| 真实行为 | 观察到的证据 |
|---|---|
| 简单问答与时间上下文 | 正确回答 2+2、本地日期 2026-09-06 和 Asia/Shanghai，无工具调用 |
| 项目扫描 | 实际成功读取四个 fixture 文件，识别加法函数误写成减法 |
| 修改后验证 | 实际 edit 修复，再用 pwsh 执行 `node calc.test.mjs`；输出 `DSH_REAL_VERIFY_OK`，主进程独立复验通过，非目标文件未变 |
| 工具失败 | 一次真实 read 返回 not found，模型如实报告失败，不重试、不换工具 |
| 审批拒绝 | 一次真实 write，默认 Reject；asked / decided 关联 ID 一致且为 rejected，模型停止，目标文件未创建 |

有效批次 `real-llm-ObN825` 的 11 次调用全部完成（10 次会话、1 次标题），没有 fixture 范围拒绝；1170 个产物文件的密钥扫描通过，真实 settings / credentials 字节未变。此前一次范围限制过窄导致脚本超时，保留其 7 次调用记录；授权后的总调用数为 18，不把该脚本问题记作产品或审批失败。

验收边界：`ObN825` 的五类行为完成，但原脚本因 ConPTY 退出回调尚未提供 exitCode 而整体返回失败；原 `passed: false` 和退出码未知记录保持原样。补齐有限等待后，独立 `real-llm-BxCbWU` 退出烟测以 **0 次模型调用、退出码 0、终端恢复**通过。上述真实实屏还暴露了失败后无依据的“恢复成功”文案，截图属于该文案修复前版本；最终文案以随后回归和官方 E2E 为准，没有重复付费模型调用来替换历史记录。

系统剪贴板只完成了真实格式探测：发现 Chromium 私有格式，无法保证完整恢复，因此在读取内容或写入 fixture 前停止。现有剪贴板未改变。文本 / 路径 / PNG 的系统端到端、终端对 Ctrl+V 的拦截以及真实模型图片发送仍未验证；官方 `attachment-local` 的内存 PNG 接收与坏数据拒绝已经通过。格式探测证据位于 `.artifacts/clipboard-system-smoke-20260906-summary.json`。

**安装完成后的试用步骤**

在终端启动已安装的 profile：

```powershell
node 'D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js' --profile tui
```

1. 简单问答：提交后应立即显示反馈，首字到达后 Orb 停止，两轮之间保留一行间距。
2. Compact：运行一次带工具的任务，用 Ctrl+O 切换详细记录；检查成功、失败、取消状态与真实结果一致，草稿、焦点和滚动位置保持稳定。
3. 目录：依次打开 `/models`、`/modes`、`/sessions`、`/skills`、`/tools`、`/mcp`，在支持搜索的页面用 `/` 搜索、Enter 回列表、Tab / h / l 切区域、j / k 和 PageUp / PageDown 查看详情，再按一次 Esc 返回。
4. 审批：触发一次需要审批的操作，查看参数与权限证据；缩到提示无法审阅的尺寸，确认 Allow 被禁用、Esc 能拒绝；再检查 `/permission` 扩大权限默认取消。
5. 图片：截图复制后 Ctrl+V；终端拦截时用 `/paste-image`。检查附件摘要位于 Composer 内，文本和路径粘贴保持文本，失败、审批或返回页面后草稿和附件仍在。
6. Settings 与尺寸：分别打开 `/preferences` 与 `/settings`；前者用 Enter 进入偏好编辑，后者显示 Harness Settings / Plugins，Normal h/l 不应直接写入偏好。拉窄窗口、降低高度并滚动长内容，确认仍能操作或返回。
7. 退出：Ctrl+C 后应恢复终端回显、光标和 normal buffer，无需手动修复终端。
