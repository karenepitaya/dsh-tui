# 设置分类标题精简 · 2026-09-09

分类由侧栏（窄屏为顶部分类导航）表达，右侧直接显示设置分组。移除重复分类标题及其布局占位，保留分组标题、字段说明和顶部操作区。独立提供商管理页保持独立页头。

只修改 SettingsWorkspace 布局、对应回归与记录；未改草稿、保存或返回逻辑。原有未提交改动保留。

## 验证证据

- [旧实现失败的回归](../.artifacts/category-title-red.log)
- [四分类与提供商针对性测试](../.artifacts/category-title-targeted.log)
- [终端渲染缓存回归](../.artifacts/category-title-driver.log)
- [Orbs 类型、237 项测试、构建及示例](../.artifacts/category-title-orbs.log)
- [通用页字符格预览](../.artifacts/category-title-visual/control-reuse-settings-general-160x40-auto.png)。保留 30 组字符格断言与预览；近似字体预览不代替真实终端验收。
- 全仓 186 文件、2302 项测试通过，每文件覆盖率四项均为 100%。[日志](../.artifacts/category-title-coverage.log)
- [类型检查](../.artifacts/category-title-typecheck.log)通过；代码自审与 diff 空白检查通过。
- 官方真实终端 26 项检查通过，包含页面导航、设置保存/取消、退出和终端还原。[日志](../.artifacts/category-title-e2e.log)
- 构建、产物导入和 Cordis 加载通过。[日志](../.artifacts/category-title-build.log)

## 安装

已安装到 tui profile，逐文件核验 DSH-TUI lib 和 Orbs dist；隔离存储启动达到 idle/hostReady，退出码 0，终端恢复 normal buffer。5 份保护配置哈希不变。旧包与 profile 文件已备份，没有强制关闭用户终端，未提交或推送。

[安装与启动日志](../.artifacts/category-title-install/install.log) · [包与门禁哈希](../.artifacts/category-title-install/verified.json)

重启 TUI 后生效。
