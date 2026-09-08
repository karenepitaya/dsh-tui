# Settings 框架组件重做 · 2026-09-08

本轮仅重做 Settings，按已确认概念图实现分区、分组表单和局部控件焦点。后续根据实际终端反馈，取消表单的 102 列上限并接入主页面共享主题，默认强调色为蓝色，自定义主题同步生效。所有字形使用终端现有字体与字号，没有字号设置、字体控制转义或图片式终端渲染。

## 组件与数据边界

- `packages/pi-tui-orbs/src/settings-workspace.ts` 的 `SettingsWorkspace` 是真实 pi-tui `Component`，组合 `Box`、`HStack`、`VStack`、`ScrollView`、`SelectList`、`Text` 与既有 Orbs `ChoiceControl` / `ToggleControl`。新增选择框、分段控件与开关外观保留旧控件默认行为。
- `src/settings/page-catalog.ts` 读取官方设置 schema，`page-machine.ts` 管理草稿、选择列表和保存确认；保存仍走 DSH SettingsProvider 的版本检查与批量操作。
- `src/ui/settings-page-frame.ts` 仅格式化与脱敏，将数据映射成通用 `SettingsWorkspaceModel`。中性文本回退与真实终端使用同一组件布局。
- `src/terminal/driver.ts` 保留组件实例，更新模型或主题，直接使用组件的渲染与光标。Settings 读取主页面的 `theme.semantic.styles`，沿用共享的强调色、文字色、面板背景、选中背景和状态色；不再维护独立调色板。适配 truecolor、256 色、16 色和单色；SGR 0 后恢复所在面板的背景，避免终端组件切片产生条纹。

## 操作与响应式布局

- 宽度达到 100 列时使用 22 列侧栏，表单使用其余可用宽度，面板和操作栏延伸到右侧正常内边距；窄屏使用顶部分类。表单可滚动跟随当前选项，操作栏留在可见区域，内容短时跟在表单之后。
- Enter 打开选择列表，方向键或 Vim 导航，Enter 确认才暂存，Esc/q 取消。左右键保留快速调整。
- q 退出 Settings；未保存时确认放弃，保存进行中忽略退出。搜索/文本/数字/密钥编辑中 q 作为普通输入，不关闭页面。
- Tab 切换分类、表单、操作和搜索；Ctrl+S 保存，Ctrl+O 进入原高级检查。选择列表、编辑、确认或草稿未处理时不能跳走。
- 错误与保存状态应在可见操作区显示；权限说明无法完整显示时，不得确认保存完全访问权限。

## 最新修正验收：宽屏与共享主题

用户实际终端截图暴露两个问题：102 列限宽导致右侧大片无内容区域；Settings 独立绿色调色板没有跟随主页面主题。上述两处已修复，并重新通过当前门禁后安装到真实 `tui` profile。

- [最终覆盖率日志](../.artifacts/settings-layout-theme-coverage.log)：179 个测试文件、2134 项测试通过，每文件四项覆盖率 100%。Orbs 24 个测试文件、183 项测试通过；两包类型检查、构建、Orbs examples 和运行入口检查通过。
- [真实终端日志](../.artifacts/settings-layout-theme-official-e2e.log)：`OFFICIAL_DSH_E2E_OK`，17 页 × 5 尺寸通过，Settings 主题保存/取消/恢复及 q/picker 操作保持正常。160/200 列新回归先失败后通过；主题新增主页面颜色一致、自定义颜色及实时主题更新测试。
- 独立只读复核通过：160/200 列右边框分别位于零基列 158/198，主题色与主页面一致，80 列及 mono 未见本次改动造成的裁切或焦点退化。[修正后 160 列预览](../.artifacts/settings-layout-theme-20260908/settings-160x40-auto.png)仍为实际组件输出的近似字体预览，不是真实终端截图。
- [候选包清单](../.artifacts/settings-layout-theme-install-recovery/new-packages.json)记录本轮源码指纹及固定包：`dsh-tui-0.0.0-9281077877d5dc3c.tgz`、`pi-tui-orbs-0.1.0-caef090daee517c3.tgz`。
- [实际安装日志](../.artifacts/settings-layout-theme-install-recovery/install-executed.log)：安装退出码 0，DSH-TUI 1084 文件 digest `fa3cc5a09b901b51`、Orbs 100 文件 digest `4bec9814d0103828` 均与当前构建匹配；隔离启动达到 idle/hostReady，退出码 0、终端恢复 normal，用户配置散列保持不变。本轮独立恢复材料已准备，未执行回退，未提交或推送。

## 首轮验收记录（宽屏与共享主题修正之前）

2026-09-08，本轮 Settings 框架重做已通过最终门禁并安装到真实 `tui` profile。此次文档收尾直接核对了下列日志、清单和预览元数据；Orbs 最终测试及独立审阅结论依据主任务报告。历史验证数字不作为本轮门禁。

| 检查 | 最终结果与证据 |
|---|---|
| 整仓测试与覆盖率 | [最终 coverage 日志](../.artifacts/settings-framework-coverage.log)：179 个测试文件、2131 项测试全部通过；`vitest.config.ts` 保持 `perFile: true`，Statements、Branches、Functions、Lines 每文件均要求 100%，本轮通过。 |
| 官方 Harness E2E | [第 3 次运行日志](../.artifacts/settings-framework-official-e2e-attempt-3.log) 返回 `OFFICIAL_DSH_E2E_OK`；17 页覆盖 80×24、100×30、140×30、200×30、80×6，共 85 个页面尺寸组合。包含 q 干净退出/未保存确认、picker 确认/取消、搜索和编辑中输入 q、真实文档保存 mono/取消保留/恢复 auto、完全访问权限警告及取消不写入；Settings 场景模型请求为 0。 |
| Orbs 独立门禁 | 主任务报告最终 24 个测试文件、179 项测试及 types、build、examples 检查通过。较早的 `settings-orbs-*.log` 属于前一阶段，不代表此次最终结果。 |
| 独立审阅 | 主任务报告 `impeccable_finish_reviewer` 最终通过；关闭开关焦点不清晰的 P1 已修复，auto/mono 下控件的 3 个单元格均复核为加粗、下划线。结论也记录于 [候选包清单](../.artifacts/settings-framework-install-recovery/new-packages.json) 的 `reviewVerdict`。 |

### 视觉材料与证据边界

[120×30 auto](../.artifacts/settings-framework-20260908/settings-120x30-auto.png)、[120×30 mono](../.artifacts/settings-framework-20260908/settings-120x30-mono.png)、[80×24](../.artifacts/settings-framework-20260908/settings-80x24-auto.png)、[40×12](../.artifacts/settings-framework-20260908/settings-40x12-auto.png) 以及关闭开关的 [auto](../.artifacts/settings-framework-20260908/settings-toggle-off-auto.png)/[mono](../.artifacts/settings-framework-20260908/settings-toggle-off-mono.png) 图片，均由真实 Settings 组件的 ANSI 输出经 `@xterm/headless` 提取单元格，再用近似字体绘制，**不是实际终端截图**。输入使用合成的内置偏好值，不读取真实 profile、凭据或 Session；方法、默认背景假设和源码散列见 [visual-summary.json](../.artifacts/settings-framework-20260908/visual-summary.json)。实际终端 E2E 的屏幕与交互记录在 [screens.json](../.artifacts/official-e2e-workspaces-uR23pr/screens.json) 和 [interactions.json](../.artifacts/official-e2e-workspaces-uR23pr/interactions.json)。

Settings 与主页面共用终端字体和字号；图片中的字体近似不能证明用户终端的具体字体外观。本轮实现范围仍仅为 Settings。

### 固定包、安装与恢复

[new-packages.json](../.artifacts/settings-framework-install-recovery/new-packages.json) 标记 `candidateStatus: ready`，固定以下包与源码指纹：

| 对象 | SHA-256 |
|---|---|
| `dsh-tui-0.0.0-498991bf26e4a3ea.tgz` | `498991bf26e4a3ea5a5e2229b4b0586318a5948e76bd1d83c60833acd039e222` |
| `pi-tui-orbs-0.1.0-1c1c6c20d8d2cd6e.tgz` | `1c1c6c20d8d2cd6e4edc83ee593a86367484ea04d299a6aad0af4268d90090c8` |
| DSH-TUI 源码，271 文件 | `0032c14727e88a564a1f7a4603760166fa956a08643e66023d41216950d55fe9` |
| Orbs 源码，25 文件 | `b8dba09c876743138aa622c0b47c4e4d47f410d46e4ae629ece6d23ebd898729` |

主任务实际安装命令退出码为 0；[install-executed.log](../.artifacts/settings-framework-install-recovery/install-executed.log) 记录：

- `DSH_TUI_INSTALL_OK files=1084 digest=4ff130814ae1bc5d`。
- `DSH_TUI_ORBS_INSTALL_OK files=100 digest=1dde36539821038c`。
- 隔离存储启动达到 `idle=true`、`hostReady=true`，随后 `exit=0`、`terminalRestored=true`、`finalBuffer=normal`。
- 安装后 `--config` 校验通过，用户 `cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 保持原散列。

恢复材料与脚本保留在 [settings-framework-install-recovery](../.artifacts/settings-framework-install-recovery/)；已核验材料，但**未实际执行回退**。其中 `verification-results.json` 的 `installed: false` / `startupExecuted: false` 描述安装前的材料验证阶段，当前安装状态以 `install-executed.log` 为准。本轮未提交、未推送，保留现有 dirty 工作树。
