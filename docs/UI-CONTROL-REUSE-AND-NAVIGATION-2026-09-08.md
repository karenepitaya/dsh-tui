# 控件收拢与导航性能 · 2026-09-08

本轮响应上一轮控件复用审计及“移动操作明显卡顿”的反馈，沿用 pi-tui + Orbs，不替换框架。工作基于 `3861d88`；没有新增功能页面，也未重做各页面的信息布局。

开发开始于 2026-09-08，最终打包、安装与启动核验于 2026-09-09 完成。本轮未 commit / push。

## 控件复用

- Orbs 新增公共 `Button`、`SelectionList`；公开 `projectButton`、`projectChoiceRow`，供原有纯文字 Frame 使用同一套文字、焦点与选择标记。
- 原审计 11 个动作绘制入口均接入公共按钮：Settings 表单动作、普通动作、底栏、确认框，以及审批、Plan、Goal、两种权限确认、创建与恢复会话。主要、危险、禁用和处理中状态由公共投影定义，控制器仍决定动作是否允许。
- Settings 的 picker、提供商目录、模型分组和分类列表使用 SelectionList。Feature 与 legacy 目录共用选择行投影，保留各自的数据、搜索、键盘路由和业务状态。
- 复核时另补齐运行库设置字段、Jobs 与 Activity 列表三处选择行，以及极窄权限确认的逐按钮颜色。危险确认的尺寸与证据门禁、默认取消均保留。
- ChoiceControl 的 radio / select / segmented 外观、ToggleControl 的开关继续复用，没有另造第二套。
- 快捷键保持独立底栏；沿用主页面字号与语义主题。状态标记不依赖颜色，单色仍能识别选择和危险确认。

根包的 `src/presentation/control-projection.ts` 只把公共控件语义映射到 Frame 的颜色角色，不执行 IO、不生成 ANSI，也不包含第二套按钮绘制逻辑。

## 移动卡顿的原因与修复

1. Settings 计算高度、当前位置和可见内容时重复绘制同一字段，每帧最多 5 次；现在每字段每帧只绘制 1 次，宽度已满足的行跳过重复截断。
2. Provider 页面先生成普通设置页后覆盖成提供商页，随后终端再按主题布局；Controller 现在直接选择最终页面。Pi driver 接收组件模型后只布局一次，其余不支持延迟布局的消费者仍可取得完整 Frame。
3. pi-tui 同帧同宽多次请求渲染，之前重复生成内容；FrameComponent 缓存该次结果，收到新帧、宽度或主题失效时重新生成。
4. Provider 每次移动多次读取全量 Settings 快照；展示现在复用快照，设置变化、刷新、操作结束和重新打开会失效。写入前仍读取实时权限，不用展示缓存代替授权判断。
5. 终端把重复按键合为 `jjk` 等同一输入块时，导航曾将它当作整段文字忽略；现在仅在非编辑导航状态逐键处理 `j/k`，保留 arrows 偏好以及搜索、编辑、粘贴、输入法的完整文本语义。

没有增加延时、降低重绘频率或通过吞掉输入来改善数字。

## 布局测量

`scripts/navigation-render-benchmark.mjs` 使用 SettingsProvidersController、Frame 投影与 Orbs 布局，五种场景结合导航方式和三种窗口构成 27 个配置，每个配置 80 次导航。普通表单直接投影选择位置，提供商场景经过控制器；不包含 App Controller、帧调度器与实际终端。相同 fixture 的修复前和修复后均核对选择位置，未触发存储写入或外部请求。

| 场景与窗口 | 修复前 P50 / P95 | 修复后 P50 / P95 |
| --- | --- | --- |
| 设置表单 80×24 | 70.24 / 111.18 ms | 9.97 / 16.90 ms |
| 设置表单 160×40 | 224.20 / 278.21 ms | 25.15 / 32.94 ms |
| 提供商主页 160×40 | 244.01 / 306.67 ms | 49.85 / 63.18 ms |
| 提供商目录 80×24 | 6.95 / 7.72 ms | 0.94 / 1.56 ms |
| 提供商管理 80×24 | 3.80 / 7.08 ms | 0.91 / 1.33 ms |

这些是同机布局 CPU 诊断数据，包含其他本地任务运行时的噪声，不是 Windows Terminal 的按键到屏幕延迟，也不是所有机器的性能承诺。提供商主页仍比目录开销高，本轮没有声称全产品所有页面都达到同一帧率。

证据：`.artifacts/control-reuse-navigation-before.json`、`control-reuse-navigation-after-fallback.json`、`control-reuse-navigation-after-deferred.json` 和 `control-reuse-navigation-comparison.json`。兼容完整 Frame 的 fallback 与生产 Pi 延迟布局两种模式均验证选择位置；最终生产数据使用 deferred 模式。

## 实际终端与回归

完整官方 Windows ConPTY 门禁通过，runner 耗时 73.34 秒，含脚本准备的外层总耗时 75.70 秒。原有 17 页面、多尺寸、审批与交互结算、恢复会话、正常退出及终端恢复继续通过。测试使用隔离存储和本地 mock，没有调用真实供应商。

新增连续导航验证覆盖 120 次输入、72 个预期选择终点，包括方向键、`j/k` 及同一输入块内的重复按键。100×30 窗口中，每个场景 24 个样本：

| 场景 | P50 | P95 |
| --- | --- | --- |
| 主题选择器 | 31.15 ms | 32.21 ms |
| 提供商目录 | 31.48 ms | 32.40 ms |
| 提供商管理 | 31.07 ms | 45.98 ms |

该延迟从 PTY 写入开始，到 xterm 解析出符合预期的完整帧为止，没有人为加入 settle 等待；不包含显示器实际呈现时间。连按验证最终选择正确，不要求每个中间位置都单独上屏。每个场景有 48 次完整 VT 帧，因此“布局一次”不表示“只刷新一次终端”。实际样本见 `.artifacts/official-e2e-workspaces-64BhAR/navigation-latency.json`。

最终根包 185 文件、2287 测试通过，每源文件 statements / branches / functions / lines 均为 100%。Orbs 25 文件、236 测试及类型、构建、示例检查通过；E2E 辅助测试 25 项通过。并行运行时曾有一个既有长元数据测试触及默认 5 秒超时，隔离覆盖诊断中耗时 1.33 秒；最终完整覆盖限制为 2 个 worker 后通过，没有修改测试超时或完整覆盖门禁阈值。

首轮复用回归保留了异常标识控制字符的替代符号显示，修正窄屏确认按钮的语义着色，并将旧测试的私有箭头和间距断言同步为公共投影。终端验收也同步了 Settings 与 Plan Review 的旧标记判定。

30 组实际输出预览覆盖通用设置、放弃草稿确认、提供商初始/成功/失败，以及三种尺寸和 auto / mono。集中检查了六张代表图，未再修改视觉；ANSI、文字和字符格完整保留在 `.artifacts/control-reuse-visual-20260908/`。这些是程序输出生成的字符格预览，字体近似，不是真实 Windows Terminal 截图。40×12 通用页仍使用原有单行快捷键省略方式，其余浮窗快捷键可在独立底栏换行。

## 已安装与验收入口

最终 TypeScript、双包干净构建、产物 import 及官方 Loader 检查通过。通过官方 CLI 将同次构建的两包安装到现有 `tui` profile；运行中的旧 TUI 需要重启。

| 包 | 固定文件 | SHA-256 |
| --- | --- | --- |
| DSH-TUI | `dsh-tui-0.0.0-913dd47cfbe0217b.tgz` | `913dd47cfbe0217be2494cadc9e1813b096404c2d03e18dea2137ca773fabde4` |
| Orbs | `pi-tui-orbs-0.1.0-5099cf0809c2d54b.tgz` | `5099cf0809c2d54b13d2d238334614a12c437cc450d62a3648a0c48a925a8fc7` |

安装后 DSH-TUI 1104 个文件、Orbs 112 个文件逐字节核验一致，摘要前缀分别为 `249280f6d7913938`、`fff1f873e79aa59d`。隔离存储启动达到 idle / hostReady，退出码 0，最终终端为 normal；用户配置哈希不变，未覆盖真实会话。

恢复材料和成功日志位于 `.artifacts/control-reuse-navigation-install-recovery/`。材料包含安装前的两包和五个 profile 文件备份，最终候选包、当前门禁证据与源码指纹已封存。安装成功，未执行回滚。Orbs 门禁日志明确标为本轮已执行命令的结果整理，不冒充原始 shell 输出；其余门禁日志保留各次实际命令输出。

启动命令保持不变：

```powershell
node "D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js" --profile tui
```

验收时进入 `/settings`，连续使用方向键和 `j/k` 移动；再打开模型列表、提供商目录与管理面板。观察移动跟手程度，以及按钮焦点、禁用、成功/失败反馈和 `q` 返回。搜索或编辑中输入 `j/k` 应仍作为文字保留。
