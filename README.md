# DSH-TUI

DSH-TUI 是 DeepSeek Harness 的终端聊天界面插件。它把日常对话保持得尽量安静：用户消息、执行摘要和最终回答构成主时间线；Session、Diff、Models、Skills 等目录则使用独立的二级页面。

当前版本面向 DeepSeek Harness `0.1.1-rc.2`，仍处于开发阶段。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- PowerShell 7+
- 安装到 DSH profile 或运行官方 E2E 时，需要已构建的 DSH CLI；默认位置是 `..\deepseek-harness\apps\cli\lib\bin.js`

Orbs 源码已包含在 `packages/pi-tui-orbs/`，保留独立 MIT 包、版本和测试；克隆本仓库即可安装依赖、构建和打包，不需要另外准备同级 Orbs。来源与基线摘要见 [SOURCE.md](packages/pi-tui-orbs/SOURCE.md)。

推荐的目录结构：

```text
DSH-Project/
├─ deepseek-harness/
└─ dsh-tui/
   └─ packages/pi-tui-orbs/
```

首次安装依赖：

```powershell
Set-Location 'D:\Projects\DSH-Project\dsh-tui'
pnpm install --frozen-lockfile
pnpm run build
```

根 lockfile 同时锁定两个 workspace 包。`build` 和 `typecheck` 会先构建 Orbs；只验证组件库可运行 `pnpm --filter pi-tui-orbs run verify`。`pnpm run pack:local` 只构建并生成双包，不启动 Harness。

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
$orbsRoot = (Resolve-Path -LiteralPath '.\packages\pi-tui-orbs').Path
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
| `/models` | 模型选择 | `↑/↓` 或 `j/k` 选模型，`←/→` 独立调推理强度，`Enter` 应用，`Ctrl+S` 设默认，`r` 刷新 |
| `/modes` | Agent mode 目录 | `j/k` 选择，`Enter` 应用，`r` 刷新 |
| `/skills` | Skills 目录与详情 | `j/k` 选择，`Enter` 查看，`r` 刷新 |
| `/tools` | Tools 目录 | `j/k` 选择，`r` 刷新 |
| `/mcp` | MCP 目录 | `j/k` 选择，`r` 刷新 |
| `/preferences` | DSH-TUI 偏好 | `j/k` 选择，`Enter` 进入编辑，`h/l` 切区域，`r` 重载 |
| `/settings` | 通用、模型与服务、插件、Agent 预设设置 | `[` / `]` 切分类，`Enter` 修改，`Ctrl+S` 保存表单草稿，`q` 退出，`Esc` 取消，`Ctrl+O` 高级配置 |
| `/permission` | 当前权限与预设 | 选择官方预设；扩大权限前再次确认，默认取消；`r` 清除本会话记住的审批范围 |

新 Feature 的页面资源在打开 route 时创建；离开页面会取消对应的 loader、watcher 和动画。部分数据源仍由 legacy compatibility port 提前准备，旧 Controller 路径也仍处于迁移期，详见[开发说明](./docs/development.md)。

`/model` 和 `/mode` 的无参数形式仍作为旧入口使用，补全菜单只显示 `/models` 与 `/modes`。模型每行只出现一次，推理强度是当前所选模型的独立选项。

模型切换需要 Agent 空闲、当前 Session 可写，且所选模型可路由；偏好保存也需要可写的 Settings 服务。不满足条件时，页面会显示原因，不会强行应用。

### 模型与服务

在 `/settings` 切到“模型与服务”，可查看已有提供商、设置新会话默认模型。在该分类按 `n` 或 `/` 打开“添加提供商”浮窗，直接输入名称搜索 DSH 动态目录，`↑/↓` 选择、`Enter` 打开管理面板。内置服务从目录选择；“自定义兼容服务”可填写显示名称、服务类型、服务地址和模型 ID，再按官方认证流程配置凭据。

管理面板按“连接配置”“连接测试”“更多操作”分组。用 `↑/↓` 或 `Tab` 选择，`Enter` 编辑或执行；`c` 配置或更换凭据，`m` 选择测试模型，`t` 测试连接。添加、认证和配置都在浮窗中完成，操作提示位于屏幕底部。密钥输入会遮罩显示；只读配置或不可用的服务会禁用相应操作。

测试只在明确触发后发送一次独立的短模型请求，不携带当前对话和工具，也不写入 Session 或改变模型选择。测试期间管理面板保持可见，其他操作暂时禁用，按 `Esc` 取消。测试按钮下方显示进行中、成功、失败、输出受限或已取消的结果；收到有效响应时显示耗时秒数。更换提供商、测试模型或连接配置会清除旧结果。“已配置”表示凭据状态，不等于连接测试通过；它与“当前默认”、光标焦点使用不同的视觉状态。

默认模型列表按提供商分组，模型名称不重复附加 ID；同名提供商会用 ID 区分。“新会话默认模型”只影响后续新建会话，当前会话切换仍使用 `/models`。提供商字段和默认模型在确认后直接保存，不需要再按 `Ctrl+S`；自定义服务需填写完成后选择“添加并配置凭据”。其他分类已有的表单草稿会保留，进入高级配置前需先保存或取消这些草稿。

“断开连接”移除已保存的凭据，保留服务地址和模型配置；“重置服务配置”保留密钥、恢复原始配置，没有原始配置的自定义服务会移除。两者都先进入默认选中“取消”的确认框；窗口不足以完整显示确认内容时，需放大后才能执行。浮窗中按 `Esc` 返回或取消操作；未执行操作且不在输入或搜索状态时，也可按 `q` 返回。

### 键盘模式

- Chat 默认处于 Insert 模式，普通按键直接输入。
- 二级页面默认处于 Normal 模式；默认 `both` 配置下，`j/k/h/l` 和方向键都可用于导航。
- 需要在支持搜索的页面输入查询时，按 `/` 或 `i` 进入搜索，`Enter` 应用查询并回到列表。
- `Esc` 一次返回上一层，搜索状态也一样；字段编辑和短确认先返回它们的上一级。
- `Tab` / `Shift+Tab` 切换区域；详情中的 `j/k`、方向键和 `PageUp/PageDown` 滚动长内容。Diff 的 `h/l` 保留折叠/展开含义。
- `Enter` 执行当前页面的主要操作，`r` 在支持的页面刷新。

`navigationKeys` 可以设为 `arrows`（只用方向键）、`vim`（只用 hjkl）或默认的 `both`。无论选择哪一种，Insert 模式都不会吞掉正常文字输入。

### 审批与图片

权限审批固定在输入框上方，先显示要执行的操作、实际命令、工作目录和申请的权限；长请求说明和原因默认最多两行，`Ctrl+O` 展开完整说明、原始参数和审计标识。默认拒绝；`1` 允许一次，`2` 拒绝，支持会话记忆时 `3` 选择会话内允许。数字键或 `←/→` 只切换选择，`Enter` 才确认；`↑/↓` 或 `PageUp/PageDown` 滚动详情，`Esc` 拒绝。审批期间草稿和附件保留。窗口过小或关联证据缺失时禁止允许；因窗口过小被阻止的提交会复位到拒绝，放大后需要重新选择。

会话内允许仅记住当前连接中的同一工具、同一工作目录、相同当前权限与申请权限；同一范围内的不同命令也会放行，选择该项时会显示此范围。它不修改会话权限预设，不永久保存；断开、权限变化或在 `/permission` 按 `r` 后清除。每次自动放行仍留下官方审批记录。

`/permission` 管理官方权限预设，`custom` 只读。`never` 表示自动拒绝审批请求。

复制图片后按 `Ctrl+V` 添加；终端拦截该按键时可用 `/paste-image`。`/attach <path>` 仍可从路径添加图片。普通文本或路径的粘贴保持文本，失败时保留草稿和已有附件；只有明确触发粘贴图片时才读取剪贴板。

## 主题与偏好

`/preferences` 可直接调整密度、导航键、动画、布局和默认 transcript 模式。偏好通过 DSH 官方 Settings 服务保存在 `dsh-tui` namespace，而不是由 TUI 复制 Session 或 transcript 数据。

`/settings` 使用 pi-tui 与 Orbs 组件：宽屏侧栏分类、窄屏顶部分类，分组表单区分选择框、分段选项、开关和文本输入，字号与主页面一致。普通设置分类中，`Tab` 在表单、操作栏、搜索和分类之间切换，`/` 搜索当前分类；“模型与服务”的目录与浮窗操作见上文。方向键或 Vim 键位遵循导航偏好。普通表单的选择框按 `Enter` 打开列表，确认后才修改，左右键可快速切换。

普通设置表单的修改先留在草稿，`Ctrl+S` 保存；`q` 退出设置，未保存时先确认，`Esc` 取消编辑。搜索和输入框中的 `q` 是普通字符，选择列表或确认框中的 `q` 取消当前操作。“恢复默认”只暂存当前分类的继承值，仍需保存。表单中的密钥不会回显，输入框留空保持已有值。默认权限和 Agent 预设只影响新会话；完全访问权限保存前需明确确认。

配置继续使用 DSH Settings，终端偏好写入 `dsh-tui` namespace。复杂集合、凭据引用与插件运行信息不作为普通文本随意修改；无草稿时按 `Ctrl+O` 进入原有高级配置检查。`/preferences` 保留兼容，两入口共享同一份偏好并支持实时刷新。

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
- 控件复用尚未统一：Settings 和提供商管理复用 Orbs 工作区、表单与确认框，但审批、Plan、Goal、Session 等动作仍有各自的绘制入口。共享主题和行着色不代表共用一个按钮组件；当前清单与边界见 [控件复用审计](./docs/UI-CONTROL-REUSE-AUDIT-2026-09-08.md)。
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
