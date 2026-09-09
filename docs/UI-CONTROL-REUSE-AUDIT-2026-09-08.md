# UI 控件复用审计 · 2026-09-08

> 后续修复：已在 pi-tui + Orbs 内加入公共 Button / SelectionList，原审计的 11 个动作入口已共用按钮投影，所列目录已接入共享选择行；ChoiceControl、ToggleControl 继续复用。Settings 重复布局、Provider 导航快照读取和连续 `j/k` 输入问题也已修复。实现、验证与测量边界见 [控件收拢与导航性能记录](UI-CONTROL-REUSE-AND-NAVIGATION-2026-09-08.md)。下文保留修复前的审计统计，不代表当前源码现状。

用户要求统计按钮、选项与开关的重复实现，并停止在各页面重复绘制同类控件。本次按当前生产源码进行只读审计；随后记录结论、更新 README 并同步 Git。**本次没有实施控件收敛，也不将提供商管理表单的交付视为组件统一完成。**

## 结论与统计口径

当前复用主要集中在框架容器、文字布局与主题颜色。Settings 已使用共享的 `ChoiceControl` 和 `ToggleControl`，但没有公共 `Button` 组件，按钮与部分选择列表仍由各处自行绘制。

| 类别 | 已核对的现状 |
| --- | --- |
| 按钮 / 执行动作 | 11 处独立绘制入口：Settings 内 4 处，其余业务 7 处；公共 Button 组件为 0 |
| 选项 / 选择列表 | 至少 14 条绘制路径；Settings 内为 ChoiceControl、SelectList、私有 dialog 列表 3 类 |
| 图形开关 | 1 个共享 ToggleControl，Settings 布尔字段已复用 |

“绘制入口”不是组件库套数，也不表示每处都必须具有完全相同的外观。统计排除 tests、examples、纯状态标识与快捷键提示；同一组件的多个消费者和已有外观变体不重复计数。选择列表覆盖已明确核对的实现，14 是下限，不是对所有导航行的穷尽数量。

## 按钮与动作的 11 处入口

| 位置 | 当前实现 |
| --- | --- |
| [Settings Field 表单 action](../packages/pi-tui-orbs/src/settings-workspace.ts#L99) | 手工拼接 `[ 按钮文字 ]`，独立决定 primary、danger、focused、disabled 样式 |
| [Settings Field 普通 action](../packages/pi-tui-orbs/src/settings-workspace.ts#L115) | 与 text 共用文本格 fallback，动作外观与表单按钮不一致 |
| [Settings 底部操作栏](../packages/pi-tui-orbs/src/settings-workspace.ts#L203) | 保存、取消、重置自行拼接并着色 |
| [Settings 确认弹窗](../packages/pi-tui-orbs/src/settings-workspace.ts#L387) | 再次自行拼接按钮并处理选中样式 |
| [审批动作组](../src/ui/approval-dock.ts#L106) | Allow once、Reject、Allow for session 独立处理箭头、禁用文字和颜色 |
| [计划审阅 decisionRow](../src/ui/frame.ts#L1141) | 根据决策类型与焦点绘制动作行 |
| [Goal 动作菜单](../src/ui/frame.ts#L1491) | 自行拼接箭头、标签与说明 |
| [权限紧凑确认](../src/ui/permission-workspace.ts#L116) | 同行绘制 Cancel / Confirm，独立处理禁用状态 |
| [权限完整确认](../src/ui/permission-workspace.ts#L126) | 分行绘制 Cancel / Confirm，另行决定选中颜色 |
| [创建子会话](../src/ui/frame.ts#L3294) | 自行绘制 CREATE CHILD 与运行中状态 |
| [恢复会话](../src/ui/frame.ts#L3526) | 自行绘制 RESUME SESSION 确认行 |

权限确认的紧凑与完整布局属于同一业务家族，但目前有两段独立动作绘制代码，所以计为两个入口。Settings 的普通 action 虽然没有按钮轮廓，仍是可执行动作，不能因其画成文本而漏计。

页眉“添加提供商”等入口提示不额外计成有独立焦点和状态的按钮。`Enter / Esc / q` 等快捷键说明也不计入。

## 已核对的 14 条选项 / 列表绘制路径

| 路径 | 复用边界 |
| --- | --- |
| [Orbs ChoiceControl](../packages/pi-tui-orbs/src/lab-controls.ts#L194) | radio、select、segmented 是同一个组件的外观变体，计 1 条 |
| [框架 SelectList](../packages/pi-tui-orbs/src/settings-workspace.ts#L451) | Settings 分类侧栏与普通 picker 共用，计 1 条 |
| [Settings dialog 列表](../packages/pi-tui-orbs/src/settings-workspace.ts#L413) | 提供商目录、默认模型和测试模型等共用私有行绘制；没有复用完整 SelectList |
| [Feature 行合成器](../src/ui/feature-surface-frame.ts#L338) | Models、Modes、Sessions、MCP、Tools、Skills、Preferences 共用上屏与焦点样式；各 nodes 仍自行拼行，不能称为完整共享选择器，也不硬算 7 套 |
| [CapabilityLens 目录](../src/ui/workspace-capability.ts#L95) | 兼容路径中的 Skills、Tools、MCP、Sessions 共用目录 renderer |
| [模型行](../src/ui/frame.ts#L2857) | modelPickerRowLine 自行绘制模型与选中标记 |
| [推理强度行](../src/ui/frame.ts#L2871) | effortPickerRowLine 是独立行生成函数；宽窄屏调用不重复计数 |
| [模式行](../src/ui/frame.ts#L2695) | modePickerRowLine 自行绘制 |
| [权限预设行](../src/ui/permission-workspace.ts#L63) | presetRow 自行处理 current、candidate 与不可选状态 |
| [连接提供商目录](../src/ui/frame.ts#L2383) | providerConnectRow 与目录样式独立于 Settings 提供商列表 |
| [认证选项](../src/ui/frame.ts#L2444) | 认证方法及挑战选项共用认证阶段的文字行处理，未使用公共选择控件 |
| [运行库设置 / 插件目录](../src/ui/workspace-runtime.ts#L142) | 独立绘制条目和状态 |
| [问题单选 / 多选](../src/ui/frame.ts#L1337) | 同一 optionRow 分支绘制单选圆点或 checkbox，计 1 条 |
| [命令候选菜单](../src/ui/frame.ts#L1082) | 自行绘制候选、选中箭头与说明 |

上述并非 14 个公开可复用组件；其中有框架控件、共享行管线和业务私有函数。共同问题是选择状态、焦点、徽标与布局仍分散在不同层级。

## 已有复用应保留

- [Settings Field](../packages/pi-tui-orbs/src/settings-workspace.ts#L109) 确实实例化 `ToggleControl` 与 `ChoiceControl`。两者通过 `paint` 接入主页面的语义主题，不应重新实现。
- [ToggleControl](../packages/pi-tui-orbs/src/lab-controls.ts#L353) 的 indicator / switch 是外观变体。旧 Preferences 中可编辑的 On / Off 是文字值；插件目录的 OFF 是状态标识，均不能算成另一套图形开关。
- [settings-page-frame](../src/ui/settings-page-frame.ts#L40) 与 [settings-providers-frame](../src/ui/settings-providers-frame.ts#L61) 负责数据投影，最终共用 SettingsWorkspace；两个业务文件不能算成两套完整 Settings UI。
- OrbsRuntime 的工厂只是包装原控件；`ControlPanel` 负责组织控件，不是新的一套 Choice / Toggle。SliderControl、ControlPanel 当前没有 DSH 生产实例化入口，不计入使用数量。

## 根因

1. 把“使用 pi-tui 容器、共享主题”误当成了“控件已经复用”。Box、HStack、VStack、文字截断和颜色 token 解决的是底层布局与着色，不会统一按钮行为。
2. 缺少公共按钮的状态契约。各处自行决定主次、危险、焦点、禁用和处理中状态，导致相同动作外观不同。
3. 新页面继续添加私有绘制分支。上一轮 provider 管理表单直接在 Field 中新增 action 分支，未先提取公共 Button；代码进入 Orbs 文件并不等于完成组件化。
4. 新旧渲染路径并存，部分目录只共享整行着色，不共享完整选择项。逐页修补会继续扩大这种差异。

## 后续执行顺序与验收

下一步先在现有 pi-tui + Orbs 框架内收拢基础控件，以 Settings 作为首批消费者，不更换框架或另建一套终端渲染系统。

1. 提取公共 Button，统一尺寸、间距及 normal / focused / disabled / busy 状态；primary、secondary、danger 作为明确变体。
2. 将分组、状态徽标、焦点与已选状态、限高滚动等能力收进共享选择列表，复用框架已有能力。保留 ChoiceControl 和 ToggleControl。
3. 用共享控件替换 Settings 的表单动作、普通动作、底部操作栏和确认弹窗绘制分支；页面只提供标签、状态、值及业务动作。
4. Settings 验收通过后再逐批接入其他页面。审批、权限与会话确认的业务判断仍由现有控制器负责，不在视觉统一中改变授权语义。

验收应能证明：修改公共控件即可影响所有 Settings 使用位置；同类控件的焦点、禁用和处理中表现一致；彩色与单色、宽窄窗口均可识别；快捷键提示保留独立底栏；确认内容、取消和迟到结果处理不退化。不能仅以测试数量或共用颜色声称视觉统一完成。

本次仅记录审计与更新文档，不宣称上述收敛已经实施。已完成的提供商管理功能及其上一轮验证、安装证据见 [管理面板交付记录](SETTINGS-PROVIDER-MANAGEMENT-2026-09-08.md)；后续源码有变化时需重新验证。
