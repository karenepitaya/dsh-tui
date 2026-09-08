# 提供商管理表单与测试反馈 · 2026-09-08

本轮根据用户提供的管理面板截图继续修正 Settings，沿用 pi-tui + Orbs、主页面字号与共享主题。原工作区保留，没有 commit / push。

## 使用变化

- 管理浮窗分为连接配置、连接测试、更多操作。名称与地址显示为输入槽，测试模型为选择器，操作显示为按钮；已有认证显示状态和“更换”按钮。
- “测试连接”是主操作；运行时留在原表单中，测试按钮旁显示进度，其他操作暂不可用，可按 Esc 取消。
- 成功显示绿色“连接成功”及秒级耗时，失败显示红色“连接测试失败”和检查提示，受限响应与取消分别显示明确状态。单色主题通过符号和文字保持可辨。
- 结果紧邻测试按钮，抑制旧的灰色重复 notice。切换提供商、变更测试模型或连接配置后清除旧结果；取消后的迟到结果不能覆盖当前状态。
- “断开连接”“重置服务配置”以危险操作颜色区分。确认说明完整换行，无法显示完整后果的小窗口只能取消，放大后方可确认。
- 快捷键继续放在独立屏幕底栏，未加入三栏布局。

认证、请求与持久化仍通过原有 DSH 端口。断开只移除已保存凭据；重置只撤销该服务的用户配置并保留密钥，有原始配置时恢复，否则移除该自定义配置。没有把重置改造成删除服务端资源。

## 验收

重启现有 `tui`，进入 `/settings` → 模型与服务，打开已配置的服务。检查初始字段与按钮层级，选择模型并测试，确认运行进度和结果就在按钮旁；测试中按 Esc 检查取消反馈。将终端缩至较窄尺寸，检查当前操作、反馈、返回提示及危险确认。

## 验证与安装状态

根包 184 文件、2270 测试通过，每源文件 statements / branches / functions / lines 均为 100%，没有调整阈值或加入忽略。Orbs 24 文件、223 测试，类型检查、构建及示例检查通过；根包 TypeScript、干净构建、产物 import 和官方 Loader 检查通过。

实际 Controller / Frame / Orbs 的六种管理状态（初始、测试中、成功、失败、输出受限、取消）覆盖四种尺寸与 auto / mono，共 48 场景。初始状态保留真正的默认认证字段焦点，其余状态聚焦测试操作。首轮发现窄屏只露出 badge 尾行，修复表单滚动边界后进行了第二轮最终检查。后续独立错误提示修正经 48 场景 ANSI / 文字 / 字符格逐字节等价核验，未冒充重新截图。

完整 Windows ConPTY 返回 `OFFICIAL_DSH_E2E_OK`，新增标记 `settings_provider_manage=form-three-sections+field-controls+running+success-green+failure-red+cancelled`。三个显式测试分别触发成功、HTTP 401 失败和等待中取消；均先确认运行状态仍在管理表单，再验证最终反馈。浏览请求为 0，显式测试恰好 3 次，Session 与设置文件未写入；实际模型身份、固定提示、无历史/工具及取消后无迟到成功都已检查。原有 17 页面、多尺寸、审批、交互结算、正常退出和终端恢复门禁继续通过。

另有 23 项 E2E helper/mock 测试通过。机械布局扫描无报告项，但该扫描不能替代 TUI 字符格与真实 ConPTY 的检查。

## 已安装版本

已通过官方 CLI 将最终两个固定包共同安装到现有 `tui` profile，运行中的旧进程需要重启。

| 包 | 固定文件 | SHA-256 |
| --- | --- | --- |
| DSH-TUI | `dsh-tui-0.0.0-2d4af7e76a7596b2.tgz` | `2d4af7e76a7596b299d955985819df0d52bd04a469f8e3c401b422e6243e8994` |
| Orbs | `pi-tui-orbs-0.1.0-80472e4ce2bcfe55.tgz` | `80472e4ce2bcfe55f2fa43e153ececa8263d0dd4a7af923031ff3b99fcfb75f9` |

安装后 DSH-TUI 1100 文件、Orbs 100 文件逐字节核验通过，校验器摘要前缀分别为 `f49b42341dc7ea9e`、`e24bca1d9192c3e7`。隔离存储启动达到 idle / hostReady，退出码 0，终端最终处于 normal；用户配置哈希保持一致，未覆盖真实 Session 数据。

源码及门禁证据已封存：DSH-TUI 源码指纹 `2a54a63a8c99464f270de0be31ea91c2031df8c55041dfd00be99ce445c61977`，Orbs `9eca0a88d7c9ddb62160931e57cf035181df6afe484cf58a0810d7c6f529e551`。固定包、六项门禁日志哈希、旧包与五个 profile 文件备份位于 `.artifacts/settings-provider-manage-install-recovery/`，执行结果见 `install-executed.log`。成功安装未执行失败回滚。

启动入口保持不变：`node "D:\Projects\DSH-Project\deepseek-harness\apps\cli\lib\bin.js" --profile tui`。

本轮本地证据位于 `.artifacts/settings-provider-manage-*`；Orbs 验证日志为 `.artifacts/settings-provider-form-orbs-final.log`。预览由真实 Controller/Frame/Orbs 的终端字符格生成，字体为近似绘制，不是真实 Windows Terminal 截图。测试使用隔离数据与本地 mock，不以预览或模拟结果声称真实供应商连通。
