# DSH-TUI 审计与修复交付记录 · 2026-09-07

本轮同时审计产品交互和 pi-tui-orbs 依赖可复现性，并完成下列修复、当前源码验证、打包与实际 tui profile 安装。用户重启 `tui` 即可加载新包。此前运行中的终端没有被强行关闭。

Git 基线为 `main` 的 `ba7852f916fc647017de1cf5d352ebb9419bd97c`；上一轮 checkpoint 已提交推送，本轮修改尚未提交或推送。继续工作应使用当前工作区，不能从该旧 HEAD 推断本轮实现不存在，也不能 reset / clean 当前差异。

完整问题、取舍和保留边界见 [审计记录](AUDIT-2026-09-07-UX-AND-ORBS.md)。[2026-09-06 交接手册](HANDOFF-2026-09-06-REPAIR.md)与[上一轮交付记录](REPAIR-2026-09-06-RESULT.md)保留历史事实，当前安装与门禁以本文为准。下列 `.artifacts/` 文件是本地证据，已被 Git 忽略，不随提交携带。

## 本轮完成

| 范围 | 最终行为与代码入口 |
| --- | --- |
| 审批信息 | 默认显示请求说明、实际命令、目录、实际权限及原因；长说明摘要化，Ctrl+O 查看完整参数与诊断标识。[approval-dock.ts](../src/ui/approval-dock.ts) |
| 会话授权 | 默认拒绝，支持一次同意、拒绝、会话内同意；第三项只在授权范围可确认时出现。按当前连接 Session、工具、目录、当前/申请权限记忆，明确同范围内不同命令也会放行；每次保留官方 asked/decided 事件，权限改变、断开或 /permission 中按 r 撤销会清除。[interaction-hub.ts](../src/dsh/interaction-hub.ts)、[editor.ts](../src/interaction/editor.ts) |
| 审批输入与尺寸 | 修复 PageDown 被聊天滚动吞掉、搜索框抢走审批数字键、第三项消失后选择状态残留、窗口过小提交受阻后仍保留允许选项等问题。交互时焦点实际进入 dock，结束后聊天与搜索可继续使用。[driver.ts](../src/terminal/driver.ts)、[conversation.ts](../src/ui/conversation.ts) |
| Sessions | 使用官方标题快照，列表显示标题、状态、目录与本地创建时间；默认预览去掉 UUID 和存储元数据，Tab 进入显式详情。标题可检索，缺失标题不调用模型猜测。[session-catalog.ts](../src/dsh/session-catalog.ts)、[sessions/nodes.ts](../src/features/sessions/nodes.ts) |
| Models / Modes | 模型每项一行，推理强度独立调整；Enter 应用，Ctrl+S 设默认。菜单只显示 /models、/modes，保留旧命令兼容。模式显示用途与真实可操作状态，已启动的会话给出 /new 指引。[models](../src/features/models/nodes.ts)、[modes](../src/features/modes/nodes.ts) |
| 其他二级页面 | 移除重复标题、NORMAL、Focus 和常驻 ready；用途、当前值、操作与保存范围优先，技术来源放在详情。MCP / Tools / Skills 区分空目录、无匹配与加载失败，MCP 不把工具 namespace 数冒充服务器数或健康状态。[workspace-runtime.ts](../src/ui/workspace-runtime.ts)、[runtime-library/surface.ts](../src/runtime-library/surface.ts) |
| 草稿恢复 | 发送失败时按整份文字与附件草稿恢复，避免旧图片混入新文字或新图片；等待中的附件操作也会阻止错误恢复。[controller.ts](../src/app/controller.ts) |
| 依赖可复现性 | 将 MIT 许可的 Orbs 源码原样纳入 packages/pi-tui-orbs，以 workspace 和根 lockfile 管理；普通安装、构建、打包不再依赖同级 ../pi-tui-orbs。[SOURCE.md](../packages/pi-tui-orbs/SOURCE.md) |

没有更换 Harness / Pi 底层框架，直接 DeepSeek 依赖仍精确固定在原版本，Harness 集成继续位于 src/dsh/。Session 持久事件仍是真实状态来源。

## 当前源码的验证

这些检查分项实际运行；不把分项执行写成一次完整 `pnpm run verify` 的退出结果，也不把覆盖率解释为用户体验已经完善。

| 检查 | 结果与证据 |
| --- | --- |
| 常规完整测试与覆盖率 | 175 个文件、2035 项测试全部通过；266 个源码文件逐文件四项 100%。Statements 19451/19451、Branches 16089/16089、Functions 4055/4055、Lines 17266/17266；[日志](../.artifacts/ux-full-coverage-release.log)、[coverage-final.json](../.artifacts/coverage/ux-full/coverage-final.json) |
| TypeScript / 构建 / 装配 | 当前源码 typecheck、build、scripts/import-built.mjs、scripts/loader-built.mjs 通过；最终隔离副本 pack:local 也重新构建双包 |
| Orbs | 本轮 23 个文件、154 项测试、typecheck、build 与 demo:build 通过；随后组件源码保持不变，最终打包未重复运行这 154 项 |
| 官方终端脚本辅助回归 | 9 项通过，包括当前页面布局判断与无效终端恢复反例；正式 E2E 另由 PowerShell 执行 |
| Windows ConPTY 官方 E2E | 退出 0，标记 OFFICIAL_DSH_E2E_OK；[最终日志](../.artifacts/ux-official-e2e-attempt-10.log) |
| 页面和交互矩阵 | 16 页 × 5 尺寸 = 80 组画面；80×24、100×30、140×30、200×30、80×6，校验可见字符位置及画面稳定。目录操作模型请求增量为 0；[screens](../.artifacts/official-e2e-workspaces-QO72wd/screens.json)、[interactions](../.artifacts/official-e2e-workspaces-QO72wd/interactions.json) |
| 会话生命周期 | 审批允许/拒绝、问答回答/取消、工具运行、模式切换与锁定、冷恢复、持久事件连续、退出后进程消失与终端恢复均通过；不存在的 Session 恢复禁止写入且不分配终端。[request-lifecycle](../.artifacts/official-e2e-workspaces-QO72wd/request-lifecycle.json) |
| 独立源码副本与双包消费 | 无相邻 Orbs 的副本，frozen-lockfile 离线安装、构建打包、独立 tarball 消费、完整运行文件与 import 校验通过；[green-7](../.artifacts/orbs-repro-20260907/green-7/final-validation.json) |

正式 E2E 使用本地 mock 模型服务。本轮没有发起新的真实 Xiaomi MiMo 付费验收；历史真实模型结果不能替代当前界面的人工体验检查。真实系统剪贴板与模型组合场景也没有在本轮重新端到端验收。

## 最终包与实际安装

最终 266 个源码文件摘要：`d92244e840f54c69fbebc4aa1b8c2fef44994ece91ad18cc5fefad9620da5ecf`。两个包来自已验证的 green-7 源码副本；完成构建后只补交付文档，没有继续修改源码。

| 包 | 文件与 SHA-256 |
| --- | --- |
| dsh-tui 0.0.0 | [dsh-tui-0.0.0-81d88c57628a8af1.tgz](../.artifacts/orbs-repro-20260907/green-7/checkout/.artifacts/dsh-tui-0.0.0-81d88c57628a8af1.tgz)，784420 bytes；`81d88c57628a8af1a5c5b382f27f28dc501553c4f149854498b92f9377878090` |
| pi-tui-orbs 0.1.0 | [pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz](../.artifacts/orbs-repro-20260907/green-7/checkout/.artifacts/pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz)，71503 bytes；`897449175f1f2eb40c395770cd590fe1f5404d61450d91b36a64877f0fefc147` |

实际安装位置为 `C:\Users\30553\.dsh\profiles\tui`。pnpm 11.7.0 安装命令退出 0，随后完整运行文件与实际 import 校验通过：

- DSH-TUI：1064 个运行文件，摘要 `3a4e553661a142662d183b3a8305d5b853dccfd106cd4e575e259c815f1d6ee1`。
- Orbs：92 个运行文件，摘要 `e9ef779a6a52a4829e992538fb5bedafb1b97cf5bde5835d42f044c59661fa90`。
- 安装后隔离启动达到 `idle=true`、`hostReady=true`，Ctrl+C 退出 0，`terminalRestored=true`、`finalBuffer=normal`。
- `cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 三项原文件字节保持一致。package.json 与 lockfile 因包安装而更新，不能称全部 profile 文件未变。
- 启动检查的 Session 与附件存储隔离到 `.artifacts/ux-20260907-install-recovery/startup-data-HTzUgA`，SessionQuery 使用内存；没有发送用户提示或调用模型。

最终安装证据：[install-executed.log](../.artifacts/ux-20260907-install-recovery/install-executed.log)，完成标记 `DSH_TUI_CHECKED_INSTALL_OK fixedPackage=green-7`。green-7 JSON 中的 `profileTouched=false` 和旧 profile 摘要是安装前阶段的快照，当前安装状态应读此安装日志。

安装前保存了旧两包及五个 profile 文件，恢复材料位于 [.artifacts/ux-20260907-install-recovery](../.artifacts/ux-20260907-install-recovery/README.md)。本轮验证了材料、脚本解析与只读预检；成功安装没有触发回滚，不宣称本轮新恢复脚本已经实际完成端到端回滚演练。不要直接重跑针对安装前基线的 install-checked.ps1。

## 仍需继续处理

1. 非 Shell 工具仍是通用参数展示，尚未为不同操作提供专用的内容、文件或差异审批预览。
2. 未知第三方扩展的复杂设置仍使用通用字段编辑；已知类别的进一步文案与交互打磨需要继续逐项体验。
3. 会话内授权只在当前连接存在，范围是工具、目录及权限，包含不同命令；不等于命令前缀授权或跨重启永久记忆。
4. 原来没有标题的 Session 保留未命名状态；没有删除疑似测试历史，也没有通过模型补造标题。
5. 无锁消费者存在已记录的上游 Cordis peer 范围警告，真实 profile 安装同样报告 peer warning。当前锁定副本、包文件和启动通过，不等于所有下游依赖组合兼容；本轮未升级官方约束依赖，未单独追查真实 profile 的全部 peer 警告。
6. Legacy Chat 与部分兼容页面的迁移仍是 partial，不能因本轮页面调整就宣称底层已全部统一。官方 E2E 仍需要已构建的 Harness 源码，普通构建不需要相邻 Orbs。

下一轮从安装后的实际交互复现剩余问题，尤其是非 Shell 审批与复杂设置；保留本轮证据作为回归基线。不要把“测试全绿”当成“所有产品问题已解决”。
