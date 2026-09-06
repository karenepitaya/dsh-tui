# 2026-09-05 微内核迁移检查点

这是可运行中间版本的交接记录，不是整个重构计划的完成报告。

## 已接入的产品路径

- Cordis 分拆装配、Feature/Capability registry、scope、resource、navigation、layout 与 experimental exports。
- Sessions、Diff、Models、Modes、Skills、Tools、MCP 和 Preferences 的独立 Feature。
- `/preferences` 管理官方 Settings 的 `dsh-tui` namespace；`/settings` 保留 DSH 全 namespace 编辑及敏感值脱敏。
- Chat 去除 YOU/DSH 标签；同轮紧凑、轮间留白；语义配色支持 truecolor、ANSI256、ANSI16、mono 降级。
- Prefs 首次读取先于 Terminal 创建；主题、布局、输入导航偏好支持当前进程内更新。

## 本次收尾修复

- Feature route 打开成功或失败均保留暂存图片，避免误清空附件。
- Bracketed paste 不作为 Normal 模式快捷键执行；已声明的 Feature `Ctrl+S` 可以抵达 Models，未声明时保留旧路径。
- 迟到的 route 完成结果不写入已切换的 Session；shutdown 等待当前 route task。
- 改变 density/navigationKeys 不再无条件重建主题或重排 Feature 布局。
- 偏好启动等待最新 refresh；dispose 唤醒启动等待，忽略迟到读取结果。
- Session 详情必须经显式操作加载，关闭 Surface 后取消读取并清除检查目标；Feature 模型先卸载时，后续 Surface teardown 不再向已销毁模型派发事件。
- Session 导航期间首次 Esc 将取消通知传回请求所属 Feature，即时退出运行态；底层切换仍完成回滚和资源释放。第二次 Ctrl+C 保留强制退出语义，Controller 不依赖具体 Feature 模型。

## 验证记录

- 最终 `pnpm run verify`：退出码 0，包含 TypeScript、coverage、官方 DSH E2E、build、import-built 和 loader-built。
- 全量测试与逐文件严格覆盖率：147 个测试文件、1645 项测试通过；Statements 18273/18273、Branches 14327/14327、Functions 3877/3877、Lines 16281/16281，均为 100%。官方 DSH E2E 按仓库约定单独执行，额外 1 个文件、1 项通过。
- Windows ConPTY、屏幕快照、Terminal/Input、Prefs/Product 定向回归：6 个文件、103 项测试通过。
- 官方 DSH 真实 ConPTY E2E：通过；覆盖分拆 Cordis profile、二级页面、同 Session 模式切换、CLI 冷启动恢复、进程清理与终端恢复。最后一轮包含取消桥接的最终源码。

E2E 的行为范围不能扩大解释：Models UI 当前验证 Enter 的 Session-only 选择，不包含 Ctrl+S 保存默认值；Sessions Feature 当前验证当前行的 no-op，CLI 冷恢复不等于 Feature 内冷切换或 fork；旧 `/settings` 验证脱敏浏览，不包含 UI CAS 写入或冲突。更深的保存、切换、取消、回滚由 unit/adapter 测试覆盖，不能代替尚未执行的这些真实 UI 场景。

## 已打包并安装

- 主包：`D:\Projects\DSH-Project\dsh-tui\.artifacts\dsh-tui-0.0.0-979b5e5b9223a9e9.tgz`
- Orbs：`D:\Projects\DSH-Project\dsh-tui\.artifacts\pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz`
- 实际安装位置：`C:\Users\30553\.dsh\profiles\tui`；未修改其他 profile。
- 安装内容校验：`DSH_TUI_INSTALL_OK files=956 digest=1474f3536853a412`；`DSH_TUI_ORBS_INSTALL_OK files=92 digest=e9ef779a6a52a482`。
- 实际安装 profile 启动：进入 `idle`，打开 `/preferences` 至 `ready`，Esc 返回 Chat，Ctrl+C 退出码 0；未发送模型请求。检查创建了一个空 Session，没有修改偏好。
- `pnpm peers check` 仍以退出码 1 报告 DSH/Cordis peer 缺失或冲突；此次安装启动与官方 E2E 均通过，但不能据此声称 peer 检查已清零，未自动改依赖版本。

PowerShell 试用：

```powershell
node 'D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js' --profile tui
```

试用 `/sessions`、`/diff`、`/models`、`/preferences`；默认 `both` 导航支持方向键与 hjkl。需要搜索时按 `i`，Esc 回 Normal；Feature 根页 Esc 返回 Chat。Ctrl+O 切换当前 Session 的对话详情。

## 明确未完成

- M5 尚未完成：旧 Controller/Frame/SessionBinding 仍包含页面业务与加载分支。
- Product 仍使用 `asLegacyPort()` 兼容面；部分底层 catalog 会提前获得。Feature Resource on-open 不能解释为整个产品已完全懒加载。
- Providers、Activity、Workbench、Plugin Inventory 与全 DSH Settings 尚未全部迁移为独立 Feature。
- Chat 仍经 legacy host，待其余页面迁移后最后拆出 durable stream、interaction 和 Orb 编排。
- Feature API 仍为 experimental；第三方稳定 v1 与完整 DSH 升级演练未完成。
- Session 切换到目标后返回 Chat 之前，仍可能为目标短暂重建当前页面 Resource。需要通用的导航/Session 提交事务来解决，不能提前跳 Chat 而破坏失败时的原页面和焦点。

## 下次继续原则

先阅读本记录和 `docs/development.md`，再检查实际 worktree 与测试；所有未提交改动均保留。
逐功能替换后删除其中央旧分支，不能只再增加一层 wrapper。不要修改 DSH、Desktop、Orbs 公共 API，或顺带处理此前搁置的 token-delta 数组复制和命令候选重建。

建议下一批按以下边界推进（函数名比本检查点行号稳定）：

1. Tools/MCP：删 Controller 的 `openLocalToolBrowser`、`handleToolBrowserInput`、`openLocalMcpCapabilityBrowser`、`handleMcpCapabilityBrowserInput` 及其 Frame/Binding 分支；保留通用 Feature route bridge。
2. Models/Modes/Skills：删除旧 picker UI、输入分支和重复任务；暂保留 Chat statusline 的 model snapshot、mode 重组信号、Composer skill aliases，不把轻量消费一并切断。
3. Sessions：抽出 `navigateSession`、`runSessionFork`、`runSessionSwitch`、`stageCandidate`、`commitSessionSwitch` 与 binding 释放事务，再删旧 picker/inspection UI；同步处理上一节记录的原子导航问题。
4. 新迁移 Providers、完整 DSH Settings/Plugin Inventory、Workbench、Activity，再迁移 Context/Attempts/Route/Permission 的剩余页面边界。
5. Chat/Composer 最后迁移，随后切断 Product 的 `asLegacyPort()` 和 aggregate facade，删除 `legacy.chat` marker。Transcript 内正常的工具/diff 展示不是重复 Workspace 页面，不能一并删除。
