# DSH-TUI

DSH-TUI 是 DeepSeek Harness 的终端聊天界面插件。它把日常对话保持得尽量安静：用户消息、执行摘要和最终回答构成主时间线；Session、Diff、Models、Skills 等目录则使用独立的二级页面。

当前版本面向 DeepSeek Harness `0.1.1-rc.2`，仍处于开发阶段。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- PowerShell 7+
- 同级目录中的 `pi-tui-orbs` 和 `deepseek-harness`
- 已构建的 DSH CLI：`..\deepseek-harness\apps\cli\lib\bin.js`

推荐的目录结构：

```text
DSH-Project/
├─ deepseek-harness/
├─ dsh-tui/
└─ pi-tui-orbs/
```

首次安装依赖：

```powershell
Set-Location 'D:\Projects\DSH-Project\dsh-tui'
pnpm install --frozen-lockfile
```

开发时最短的“打包、安装、启动”流程只有一条命令：

```powershell
pnpm run dev:profile
```

它会依次完成：

1. 构建 `pi-tui-orbs` 与 `dsh-tui`。
2. 生成带内容摘要的两个 `.tgz` 包。
3. 强制安装到 DSH 的 `tui` profile。
4. 校验安装包与当前源码构建产物一致。
5. 启动真实 DSH-TUI。

安装成功时会看到：

```text
DSH_TUI_INSTALL_OK
DSH_TUI_ORBS_INSTALL_OK
DSH_TUI_LAUNCH profile=tui
```

### 再次启动

如果已经安装好，不需要重新打包：

```powershell
$dshCliPath = 'D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js'
node $dshCliPath --profile tui
```

如果源码有变化，请重新执行 `pnpm run dev:profile`，不要依赖同一个 `file:` 依赖规格覆盖旧副本。

## 手动打包和安装

需要把“打包”和“启动”拆开时，在 `dsh-tui` 根目录执行：

```powershell
$dshTuiRoot = (Resolve-Path -LiteralPath '.').Path
$orbsRoot = (Resolve-Path -LiteralPath '..\pi-tui-orbs').Path
$dshCliPath = 'D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js'

$packOutput = & pnpm --dir $dshTuiRoot run pack:local
if ($LASTEXITCODE -ne 0) { throw 'DSH-TUI local pack failed.' }

$dshTuiTarball = ($packOutput |
  Where-Object { $_ -like 'DSH_TUI_TARBALL=*' } |
  Select-Object -Last 1).Substring('DSH_TUI_TARBALL='.Length)
$orbsTarball = ($packOutput |
  Where-Object { $_ -like 'DSH_TUI_ORBS_TARBALL=*' } |
  Select-Object -Last 1).Substring('DSH_TUI_ORBS_TARBALL='.Length)

$dshTuiTarball
$orbsTarball
```

把同一次打包生成的两个包一起安装：

```powershell
& node $dshCliPath plugin --profile tui add --force --prefer-offline `
  $orbsTarball $dshTuiTarball
if ($LASTEXITCODE -ne 0) { throw 'DSH profile installation failed.' }
```

校验 profile 中真正安装的文件：

```powershell
$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
} else {
  $env:DSH_HOME
}
$profileRoot = Join-Path $dshHome 'profiles\tui'

& node '.\scripts\verify-installed-package.mjs' `
  $dshTuiRoot (Join-Path $profileRoot 'node_modules\dsh-tui') `
  $orbsRoot (Join-Path $profileRoot 'node_modules\pi-tui-orbs')
if ($LASTEXITCODE -ne 0) { throw 'Installed package verification failed.' }
```

最后启动：

```powershell
node $dshCliPath --profile tui
```

`pi-tui-orbs` 是独立的必需 peer package；只安装 DSH-TUI 的 tarball 不是完整安装。

## 日常对话

主界面不使用 `YOU` / `DSH` 标签和普通消息卡片。用户消息以低对比背景条区分，Assistant 正文保持无框；同一轮内部紧凑，不同轮之间留出一行。

- 在底部 `> ` 后输入内容，按 `Enter` 提交。
- 输入框保持实底弱边框；多行内容和附件只改变高度。
- `Shift+Enter` 插入换行。
- 请求提交后，Orb 会出现在 Assistant 时间线尾部；首个可持久化回答内容出现后停止。
- `Ctrl+O` 在当前 Session 的 Compact / Verbose 视图之间切换。
- `Ctrl+C` 依次用于取消当前请求、清空草稿或退出，具体取决于当前状态。

### Compact 与 Verbose

Compact 是默认视图：

- 显示用户问题和最终回答。
- 有执行过程时只保留一行安全摘要。
- 不构造详细工具输出，也不展示原始 reasoning。

Verbose 用于排查执行过程：

- 按时间顺序展开当前 Session 的安全阶段摘要、工具参数、结果、Diff、错误和截断提示。
- 不把原始私有 thinking 截断后伪装成摘要。
- 再按一次 `Ctrl+O` 返回 Compact；Prompt 草稿、焦点和滚动锚点会保留。

## 二级页面

在聊天输入框输入以下命令并提交：

| 命令 | 页面 | 常用操作 |
| --- | --- | --- |
| `/sessions` | Session 目录与详情 | `j/k` 选择，`Enter` 或 `l` 打开；先查看 cold Session 详情，再按 `a` 确认恢复；`f` fork，`r` 刷新 |
| `/diff` | 当前 Diff | `j/k` 移动，`[/]` 切换 hunk，`Enter` 折叠或展开 |
| `/models` | Model 目录 | `j/k` 选择，`Enter` 切换，`Ctrl+S` 保存默认值，`r` 刷新 |
| `/modes` | Agent mode 目录 | `j/k` 选择，`Enter` 应用，`r` 刷新 |
| `/skills` | Skills 目录与详情 | `j/k` 选择，`Enter` 查看，`r` 刷新 |
| `/tools` | Tools 目录 | `j/k` 选择，`r` 刷新 |
| `/mcp` | MCP 目录 | `j/k` 选择，`r` 刷新 |
| `/preferences` | DSH-TUI 偏好 | `j/k` 选择，`Enter` 进入编辑，`h/l` 切区域，`r` 重载 |
| `/settings` | DSH 全局 Settings 与插件配置 | `[/]` 切 Settings/Plugins，Tab 切列表/详情，Enter 编辑字段，Ctrl+S 恢复继承值 |
| `/permission` | 当前权限与预设 | 选择官方预设；扩大权限前再次确认，默认取消 |

新 Feature 的页面资源在打开 route 时创建；离开页面会取消对应的 loader、watcher 和动画。部分数据源仍由 legacy compatibility port 提前准备，旧 Controller 路径也仍处于迁移期，详见[开发说明](./docs/development.md)。

模型切换需要 Agent 空闲、当前 Session 可写，且所选模型可路由；偏好保存也需要可写的 Settings 服务。不满足条件时，页面会显示原因，不会强行应用。

### 键盘模式

- Chat 默认处于 Insert 模式，普通按键直接输入。
- 二级页面默认处于 Normal 模式；默认 `both` 配置下，`j/k/h/l` 和方向键都可用于导航。
- 需要在支持搜索的页面输入查询时，按 `/` 或 `i` 进入搜索，`Enter` 应用查询并回到列表。
- `Esc` 一次返回上一层，搜索状态也一样；字段编辑和短确认先返回它们的上一级。
- `Tab` / `Shift+Tab` 切换区域；详情中的 `j/k`、方向键和 `PageUp/PageDown` 滚动长内容。Diff 的 `h/l` 保留折叠/展开含义。
- `Enter` 执行当前页面的主要操作，`r` 在支持的页面刷新。

`navigationKeys` 可以设为 `arrows`（只用方向键）、`vim`（只用 hjkl）或默认的 `both`。无论选择哪一种，Insert 模式都不会吞掉正常文字输入。

### 审批与图片

权限审批固定在输入框上方，显示实际调用参数、cwd、当前与请求权限以及队列位置。默认选择拒绝；`1` / `2` 选择一次允许或拒绝，`←/→` 切换动作、`Enter` 确认，`↑/↓` 滚动证据，`Esc` 拒绝当前项。审批期间草稿和附件保留。窗口过小或关联证据缺失时禁止允许；小高度窗口优先显示审批区域。

`/permission` 管理官方权限预设，`custom` 只读。`never` 表示自动拒绝审批请求。普通审批不提供永久允许或记住授权。

复制图片后按 `Ctrl+V` 添加；终端拦截该按键时可用 `/paste-image`。`/attach <path>` 仍可从路径添加图片。普通文本或路径的粘贴保持文本，失败时保留草稿和已有附件；只有明确触发粘贴图片时才读取剪贴板。

## 主题与偏好

`/preferences` 可直接调整密度、导航键、动画、布局和默认 transcript 模式。偏好通过 DSH 官方 Settings 服务保存在 `dsh-tui` namespace，而不是由 TUI 复制 Session 或 transcript 数据。

`/settings` 仍然打开原有的 DSH 全局设置目录，用于检查和编辑所有可用 namespace；它不会被只管理 `dsh-tui` namespace 的偏好页替代。

默认文件位置是：

```text
$DSH_HOME/settings.yaml
```

如果未设置 `DSH_HOME`，Windows 上通常是 `%USERPROFILE%\.dsh\settings.yaml`。

也可以直接编辑该文件：

```yaml
dsh-tui:
  version: 1
  density: compact
  navigationKeys: both
  reducedMotion: false
  layoutMode: auto
  defaultTranscriptMode: compact
  theme:
    preset: auto
    palette:
      primary: "#d8dee9"
      accent: "#7aa2f7"
      muted: "#78839a"
      user: cyan
      assistant: "#c0caf5"
      success: green
      warning: yellow
      error: red
```

`theme.palette` 使用语义角色，可填写 `#RRGGBB` 或 ANSI 颜色名。可用角色包括：

```text
primary accent muted user assistant reasoning tool command dashboard
activity interaction composer telemetry success warning error border code
```

终端不支持 True Color 时，颜色会按 `#RRGGBB -> ANSI 256 -> ANSI 16 -> mono` 降级。旧的 `theme.colors` ANSI 配置仍兼容；同一角色同时出现时，`palette` 优先。设置 `NO_COLOR` 可强制单色，`TERM=dumb` 会关闭 SGR 样式。

偏好修改会热应用到正在运行的产品；无效的外部编辑会保留该 namespace 最近一次有效值。

## 当前边界

- 只适配精确固定的 DeepSeek Harness `0.1.1-rc.2`。
- 本仓库只处理 TUI，不包含 Desktop。
- Feature API 仍从 `dsh-tui/experimental` 导出，不承诺第三方稳定兼容。
- Sessions、Diff、Models、Modes、Skills、Tools、MCP 和 Preferences 已按 Feature 合同接入；DSH 全局 Settings 继续走兼容入口。旧 Chat、Controller 和部分兼容 port 仍在渐进迁移，不能据此认为 Milestone 5 已全部完成。
- Quick Start 暂停使用；真实 Goal、Plan 和 Todo 状态仍保留。
- 不提供不受信任的任意外部 TUI slot，也不新增 DSH 协议或持久化格式。

## 开发与验证

架构边界、生命周期、完整门禁和人工验收清单见 [docs/development.md](./docs/development.md)。常用命令：

```powershell
pnpm run typecheck
pnpm run test
pnpm run verify
pnpm run pack:local
```

`pnpm run verify` 会执行类型检查、覆盖率门禁、官方 DSH E2E、构建产物 import 和 loader 检查。

## License

[MIT](./LICENSE)
