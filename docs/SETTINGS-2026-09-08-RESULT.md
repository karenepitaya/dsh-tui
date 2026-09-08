# Settings 表单交付 · 2026-09-08

本轮只实现 Settings，采用已讨论的顶部分类方案。已完成构建、当前源码验证、打包并安装到现有 `tui` profile；正在运行的旧进程需要重启才能加载新包。

Git 仍为 `main` / `ba7852f916fc647017de1cf5d352ebb9419bd97c`，上轮已有差异全部保留，本轮没有提交或推送。不要 reset/clean 或从旧 HEAD 推断当前实现。

## 使用与验收

启动现有 `tui`，输入 `/settings`。若没有快捷命令，使用：

```powershell
node "D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js" --profile tui
```

- 顶部四类：通用、模型、插件、Agent 预设；通用按外观、交互、权限分组。
- 枚举显示可选项，布尔值显示开关，数字/文本用输入框。方向键或 hjkl 遵循当前导航偏好，编辑/搜索不吞普通字符。
- `[` / `]` 切分类，`/` 搜索当前分类，Tab 切焦点，Enter 编辑，Ctrl+S 保存。修改先暂存，Esc 可取消编辑或确认放弃草稿。
- “恢复默认”作用于当前分类，移除用户覆盖后继承部署配置/默认值；先暂存，保存才生效。
- 密钥不回显，空输入保留现有值；恢复默认不猜测密钥属于哪一层，以保存后重新读取的脱敏状态为准。
- 默认权限/默认 Agent 预设影响新会话。保存完全访问权限前明确确认；终端太小、风险说明不能完整呈现时不能确认。
- Ctrl+O 进入原高级配置检查，需要先保存/取消草稿。高级页 Esc 返回聊天。

建议人工验收：修改主题并保存、重新打开确认保持；修改后取消；缩小窗口浏览并编辑最后一项；在单色主题下确认分组与焦点仍可辨认。

## 实现与范围

新增 `src/settings/page-catalog.ts`、`page-machine.ts`、`page-contracts.ts` 与 `src/ui/settings-page-frame.ts`。Controller 接入该表单，旧 Runtime Library 作为高级入口保留。

设置仍走 DSH 官方 SettingsProvider，按 namespace 批量提交路径操作并检查 revision；失败保留对应草稿，部分成功不会宣称全部保存。没有新增第二份配置文件或改动依赖版本。

真实终端验收发现并修复了部分用户覆盖不带 version 时，旧 Preferences 读取器拒绝加载的问题。版本补全仅在适配器读取边界进行，持久化仍保留部分覆盖；显式旧版和非法版本继续走原迁移/校验。

这是一版可用表单，不代表所有复杂配置已具备专用编辑器：模型数组、预设组成文件等复杂集合仍需高级入口或专用工具；凭据引用仍由连接管理。仅 Web 使用的设置没有混进终端页面。其他产品页面本轮未重设计。

## 当前验证

| 检查 | 结果与本地证据 |
| --- | --- |
| 全量单测与覆盖 | 178 文件、2,112 测试通过；每文件四项覆盖率 100%。`.artifacts/settings-release-coverage.log`、`.artifacts/coverage/settings-release/` |
| 类型与产物 | TypeScript、built imports、Loader 验证均通过 |
| Orbs | 23 文件、154 测试及 typecheck/build/demo:build 均通过；沙箱内聚合 pnpm 子 Shell 被拒后，使用项目 Node/TypeScript/Vitest 逐项执行原检查，未改工具链 |
| 官方 ConPTY | `OFFICIAL_DSH_E2E_OK`，17 页 × 5 尺寸 = 85 屏，10 类交互记录；旧工具链、退出、终端恢复均通过。`.artifacts/settings-official-e2e-attempt-2.log`、`.artifacts/official-e2e-workspaces-u8jez3/` |
| Settings 真实流程 | 主题保存 mono、取消 auto 草稿、重新打开保持 mono、保存恢复 auto；数字错误与取消权限确认都不写配置；设置操作模型请求数为 0 |
| 视觉检查 | 120×30 auto/mono、80×24、40×12 程序字符格预览已查看。`.artifacts/settings-20260908/VISUAL-QA.md`；预览字体近似，不冒充真实终端截图 |

全部模型相关验收使用隔离目录和本地 mock，没有发送用户真实项目、历史会话或调用付费模型。

## 安装记录

源码 270 文件，SHA-256 `56116e609fc75171f07f726aed146ccb37650cc45dbbb6f6f8e2d773cebbb6e3`。

- DSH-TUI 包：`dsh-tui-0.0.0-5c6ad127e545c5a1.tgz`，已安装 1,080 个运行文件，摘要前缀 `2a799b3f8db99f91`。
- Orbs 包不变：`pi-tui-orbs-0.1.0-897449175f1f2eb4.tgz`，92 文件，摘要前缀 `e9ef779a6a52a482`。
- 安装后实际 profile 隔离启动达到 ready/idle，退出码 0，最终终端为 normal，存储隔离通过；三个受检 profile 配置文件摘要未变。
- 当前 profile 备份、旧包、安装/恢复脚本及安装日志保存在 `.artifacts/settings-20260908-install-recovery/`。本次成功安装未触发回滚，不能称回滚端到端已演练。
- 原有 peer dependency warning 仍存在；本轮未修改依赖约束。

`.artifacts/` 是本地证据，受 Git 忽略，不随提交分发。后续以实际用户验收继续收敛 Settings，不因上述检查通过而宣称整个产品体验已完成。
