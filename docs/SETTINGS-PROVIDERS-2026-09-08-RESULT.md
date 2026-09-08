# Settings 提供商浮窗 · 2026-09-08

> 后续截图反馈已修复并重新安装：模型按提供商分组、去重与去副标题、独立快捷键底栏、状态色、目录限高滚动。当前包和最终门禁见 [列表修正交付记录](SETTINGS-PROVIDERS-2026-09-08-POLISH.md)。下文保留前一轮的包及验证结果。

本轮仅继续 Settings 的“模型与服务”：复用 DSH 动态提供商目录，提供添加、配置和显式测试，并以 pi-tui + Orbs 浮窗呈现。原有脏工作区保留，没有提交或推送。

## 使用

重启现有 `tui` 后进入 `/settings`，选择“模型与服务”。`[` / `]` 可切换分类。

- 首页显示新会话默认模型与已配置服务。按 `n` 或选择“添加提供商”打开可搜索目录，供应商名称无需手输。
- 选择服务并 Enter 打开配置浮窗；可配置凭据、选择测试模型、测试连接、修改基本信息或进入高级设置。精细协议参数不再铺在首页。
- 浮窗内 `t` 测试、`c` 配置凭据、`m` 选择测试模型、`a` 高级设置；操作也可上下选择后 Enter 执行。`q` / Esc 返回，搜索和输入中的 q 是普通字符。
- 自定义兼容服务仅填写名称、服务类型、地址和模型 ID，再通过官方凭据流程完成配置。服务类型选项来自当前 DSH schema。
- 修改新会话默认模型不切换当前会话，并清除旧模型的推理强度覆盖。

测试按钮发出固定的 `Reply with OK.` 请求，没有工具、项目文件或历史会话。结果显示耗时；额度不足、超时、认证失败和取消分别反馈。浏览目录不会请求模型。测试可能产生供应商费用，只有用户触发才执行。

## 验证与实现

- 根包：184 文件、2243 测试通过；每个源文件的 statements、branches、functions、lines 覆盖率均为 100%，没有降低阈值或加入忽略。
- Orbs：24 文件、199 测试通过；typecheck、build、示例类型检查通过。根包 TypeScript、构建、产物 import 与官方 Loader 检查通过。
- 官方 Windows ConPTY：`OFFICIAL_DSH_E2E_OK`。保留 17 页面 × 5 尺寸的原有验证，并新增提供商首页、目录、配置浮窗、选择模型、显式测试和 q 返回。目录浏览请求 0，显式测试请求 1，Session 写入 0；进程退出与终端恢复通过。
- 视觉：实际组件字符格预览覆盖六种状态、四种尺寸及 auto/mono。修复搜索占位提示、即时操作误报“已保存”、地址过早截断和裸协议名。预览使用真实组件输出，字体绘制为近似；不能称作真实终端截图。
- 回归覆盖认证取消、秘密遮罩、迟到结果、目录撤回、编辑冲突保留输入、部分创建成功可继续、父页草稿与确认，以及内置模型目录不能被“添加一个 ID”隐式替换。

主要入口：`src/settings/providers-controller.ts`、`src/ui/settings-providers-frame.ts`、`src/settings/provider-custom.ts`。Harness 调用仍仅在 `src/dsh/provider-connection.ts` 与 `src/dsh/provider-test.ts`，没有另建认证系统或修改 Harness 核心。

本轮集成测试使用隔离 profile 与本地 mock，未调用用户的真实付费模型接口。原高级配置检查器继续保留，未把整个产品的其他页面一起重做。

本地验证日志、字符格与恢复材料位于 `.artifacts/settings-providers-*`。该目录受 Git 忽略，恢复材料可能含用户配置，不应提交或输出内容。

## 已安装版本

已通过官方 CLI 将两个固定本地包共同安装至现有 `tui` profile；运行中的旧进程需要重启。没有替换用户的 Session 数据。

- DSH-TUI：`dsh-tui-0.0.0-57a8dfb570827d99.tgz`，SHA-256 `57a8dfb570827d99ff539679ff1d3941a77cdc0a2facfb76c5bb546b02cb3829`；安装树 1100 文件，摘要前缀 `6aafae7af6758e65`。
- Orbs：`pi-tui-orbs-0.1.0-13e955f773cda49d.tgz`，SHA-256 `13e955f773cda49d2ea2596defbf151bfe6c52455be9b2b13bc4fbf864c720a7`；安装树 100 文件，摘要前缀 `d8d7f0e3c246970d`。
- 安装后隔离启动达到 idle / hostReady，退出码 0，终端回到 normal；受检用户配置哈希未变。
- 源码指纹：DSH-TUI 275 文件 `06b7d2d28669391333f9f5a5dfb98e9c8d03ea347e5ae016400ac1a3c139110f`；Orbs 25 文件 `beaf194d3437bfe761c0642811560c79e065196b25ee4ae7df9a414059a86396`。
- 固定包、六项门禁日志哈希、源码指纹、旧包和配置恢复材料均在 `.artifacts/settings-providers-install-recovery/`；安装日志为 `install-executed.log`。本次成功安装未执行失败回滚，不能称回滚端到端已演练。

启动入口保持不变：`node "D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js" --profile tui`。本轮没有调用真实供应商接口；可在浮窗中使用测试按钮验证用户自己的连接。
