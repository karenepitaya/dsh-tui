# 提供商独立二级页 · 2026-09-09

管理页现在使用“提供商 · 管理”独立页头，去掉一级设置侧栏与重置按钮；添加提供商沿用相同表单布局。内部输入框、按钮、测试反馈及 Orb 动画继续复用。

有草稿时显示保存、取消和反馈，无草稿时不进入空操作栏。保存与取消留在管理页；q 从表单或操作栏返回模型列表并保持选中位置，不再关闭 Settings。Esc 在操作栏先返回表单，在编辑或测试中先取消当前操作。跨分类草稿事务与持久化边界不变。

修改限制在表单布局、提供商展示投影、管理返回分支及对应测试；移除变更造成的不可达退出分支。未改 Agent 预设、依赖或用户配置。

## 验证

- 新增 80/160 列独立页回归，先确认旧实现失败，再验证修复通过。
- 全仓 186 文件、2300 项测试通过；每文件 Statements、Branches、Functions、Lines 100%。[日志](../.artifacts/provider-page-coverage.log)
- Orbs 25 文件、237 项测试与类型、构建、示例检查通过。[日志](../.artifacts/provider-page-orbs.log)
- [类型检查](../.artifacts/provider-page-typecheck.log)、[针对性回归](../.artifacts/provider-page-targeted.log)
- 30 组字符格预览经过断言校验，人工查看宽屏管理页与窄屏输出；这是近似字体预览，实际终端验收单独执行。[管理预览](../.artifacts/provider-page-visual/control-reuse-idle-160x40-auto.png)
- 官方真实 ConPTY 门禁 26 项通过，包含独立页标题、无一级侧栏/重置、连接测试成功/失败/取消及终端还原。[日志](../.artifacts/provider-page-e2e.log)
- 构建、产物导入、Cordis 加载检查通过。[日志](../.artifacts/provider-page-build.log)

本轮保留已有未提交改动，未提交或推送；diff 空白检查通过。

## 安装交付

已安装到真实 tui profile。安装核对 DSH-TUI lib 1104 文件和 Orbs dist 112 文件；隔离存储启动达到 idle/hostReady，退出码 0，终端恢复 normal buffer。5 份保护配置哈希保持不变。旧包及 profile 文件备份保存在本次恢复目录，没有强制关闭用户终端。

- [安装与启动证据](../.artifacts/provider-page-install/install.log)
- [包与门禁日志哈希](../.artifacts/provider-page-install/verified.json)

重新启动 TUI 后生效。
