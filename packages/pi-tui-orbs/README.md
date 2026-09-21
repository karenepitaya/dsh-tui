# pi-tui-orbs

面向 `@earendil-works/pi-tui` 的紧凑 Agent 状态、长时执行和流式回复动效。它遵循一个明确的层级：`User` 与 `Assistant` 是同级角色；`Loading / Thinking / Tool Call` 是 `Assistant` 下面的 status line；最终回复是 `Assistant` 的内容，不是另一种状态。

```text
User
  检查当前 Orb API，并给出最小 Agent TUI 方案。

Assistant
  ✓ Loading   3 files · done · 0.5 s
  ✓ Thinking  Plan ready · done · 0.8 s
  ● Tool Call read README.md · running
  Response · streaming
    Orb 应该只承担当前活动状态…
```

组件库有三种互不混用的活动语言：短状态使用呼吸 Orb，未知进度的长时间执行使用渐变色块轨道，Assistant 正文使用尾部 shimmer。完成的 status line 统一收束为 `✓`，不会再留下像“仍在运行”的小圆点。

## 开箱即用：OrbsRuntime

推荐从 `createOrbsRuntime()` 开始。它只需要接收宿主的刷新函数，随后统一提供共享 ticker、主题、glyph/color 偏好、组件工厂和生命周期：

```ts
import { createOrbsRuntime } from "pi-tui-orbs";

const orbs = createOrbsRuntime({
  requestRender: () => tui.requestRender(),
  theme: "catppuccin",
  motion: "auto",
  glyphs: "auto",
  color: "auto",
});

const thinking = orbs.createAgentStatus({
  kind: "thinking",
  detail: "正在规划下一步…",
});

const answer = orbs.createShimmerText({
  text: "正在整理最终回答。",
  active: true,
});

orbs.setTheme("github"); // 未显式指定 theme 的实例一起切换
orbs.destroy(thinking);  // 提前结束一个临时组件
orbs.dispose();          // 退出时释放其余 factory-created 组件和共享 host
```

Factory 创建的 motion components 由 runtime 托管；短生命周期组件应使用 `orbs.destroy(component)` 提前解除跟踪并销毁。创建时显式传入 `theme` 相当于 pin：它不会随 `orbs.setTheme()` 改变。

Factory 直接接收原组件的 Options，没有引入第二套配置语义：`Orb / GradientBar / AnimatedFrames` 用 `autoplay`，`ShimmerText / StreamingText` 用 `active`，`AgentRequestStatus / AgentStatus / ExecutionStatus / ModelStatusline` 用各自的 `phase`，`TodoList` 根据 active item 自动决定是否运行；静态的 `EffortMeter` 只接收当前 `effort`。

DIY 不需要换一套 API。现有类仍全部公开，直接复用 `orbs.host` 即可；这种实例不归 runtime 托管，需要调用方自行 `dispose()`：

```ts
import { ShimmerText } from "pi-tui-orbs";

const custom = new ShimmerText(orbs.host, {
  text: "Custom motion",
  active: true,
  theme: "clay",
  trailLength: 20,
});

custom.dispose();
```

## Model Statusline

`ModelStatusline` 是应用外壳里固定的一行模型信息，不属于 User/Assistant transcript。初版只处理五个槽位：`mode / model / effort / context / status`。

```text
Build · MiMo-V2.5-Pro · [━━━─] high  ctx ━━──── 26.6k/128k 21% · ● Generating
```

- `mode` 使用主题强调色，`model` 保持最高可读性。
- `effort` 使用横向带框的四格 meter：`[━───] / [━━──] / [━━━─] / [━━━━]` 表达 `low / medium / high / xhigh`，因此一眼就能看出当前值在完整量程中的位置。ASCII 环境对应 `[=---] / [==--] / [===-] / [====]`。
- `context` 是静态 determinate 微进度条；70% 起进入 warning 色，90% 起进入 error 色。超出 limit 时轨道保持满格，但数值继续显示真实百分比。
- `status` 只有 `active` 使用呼吸 Orb；`idle / complete / error` 分别收束为 `○ / ✓ / !`。
- 响应式档位只由 viewport 决定：`>=72` cells 使用 full，`32–71` 使用 compact，`<32` 使用 tiny。status 文案或 context 数字变化不会让同一宽度突然换档；固定槽位预算保证 `ctx` 与 status glyph 不左右抖动。极窄时只保留 `model · context% · status`，并始终只渲染一行。

```ts
const statusline = orbs.createModelStatusline({
  mode: "Build",
  model: "MiMo-V2.5-Pro",
  effort: "high",
  context: { used: 26_641, limit: 128_000 },
  status: { phase: "active", label: "Generating" },
});

statusline.update({
  context: { used: 48_200, limit: 128_000 },
  status: { phase: "complete", label: "Done" },
});
```

### 独立 EffortMeter

`EffortMeter` 也是可单独复用的静态组件，不依赖动画 ticker。宽度足够时使用 full 形态 `[━━━─] high`；紧凑槽位使用 compact 形态 `[━━━─]`，只隐藏文字标签，不丢失外框、已填充程度和剩余量程。低于完整四格所需宽度时，组件再按可用 terminal cells 安全收缩。

```ts
const effort = orbs.createEffortMeter({
  effort: "high",
});

effort.setEffort("xhigh");
```

直接构造时使用相同 API：`new EffortMeter(orbs.host, { effort: "medium", theme: "clay" })`。Unicode/ASCII glyph、color mode 与主题均沿用 runtime 的宿主能力；它只在值或主题确实变化时请求刷新。

可交互实验台复用现有 `ChoiceControl`、`SliderControl` 和 `ControlPanel`：

```powershell
pnpm run demo:statusline
```

使用 `↑ / ↓` 选择 Mode、Model、Effort、Context、Status，`← / →` 调整；`1–5` 切换主题，`R` 重置，`Q` 退出。页面同时显示当前终端宽度和固定 48 cells 的 compact preview。

真实 Agent 场景使用 pi-tui 的 `VStack + ScrollView`：只有 transcript 滚动，header、`ModelStatusline` 和快捷键 footer 固定。Conversation、Execution、Todos、Goals 的事件会分别更新 mode、effort、context 和 status：

```powershell
pnpm run demo
```

```ts
tui.setLayoutRoot(new VStack([
  { component: header, basis: 1, shrink: 0 },
  { component: new ScrollView(transcript, { follow: "end", primary: true }), grow: 1, minSize: 1 },
  { component: statusline, basis: 1, shrink: 0 },
  { component: footer, basis: 1, shrink: 0 },
]));
```

## 1-cell 呼吸 Orb

Unicode 使用 `· / • / ●`，严格 7-bit ASCII 使用 `. / o / O`。Orb 只占一个 terminal cell，颜色沿主题的 `low → medium → high → core` ramp 连续插值。

呼吸能量由 monotonic elapsed time 直接计算：

```text
0–10%    rest
10–45%   inhale  cubic-bezier(0.33, 0, 0.20, 1)
45–50%   apex
50–100%  exhale  1 - cubic-bezier(0.40, 0, 0.67, 1)
```

`cubicBezier()` 会先求解 `x(t) = progress`，再读取 `y(t)`。普通 Orb 默认使用 50 ms cadence；`tickMs` 可在 `16..1000` ms 内按场景调低刷新频率。所有活动组件仍共享同一个 host timer，实际 cadence 由当前最快的 lease 决定；速度档位只改变运动周期，不会增加 timer 数量。

| Speed | Orb 周期 | Gradient Bar 往返 | StreamingText 周期 |
| --- | ---: | ---: | ---: |
| `slow` | 2.20 s | 1.80 s | 1.40 s |
| `normal` | 1.60 s | 1.30 s | 1.00 s |
| `fast` | 1.20 s | 0.90 s | 0.76 s |

## Agent request lifecycle status

`AgentRequestStatus` 表达一次用户 prompt 对应的完整 Agent turn，而不是某一次 provider request。请求关联、`requestId`、持久化事件和重试归属仍由宿主应用负责；Orbs 只保存当前展示阶段和简短描述。

| Phase | 含义 | Motion |
| --- | --- | --- |
| `submitted` | 本地已经接受 prompt | active |
| `waiting` | 等待模型或下一步事件 | active |
| `reasoning` | 正在推理和规划 | active |
| `tool` | 正在执行工具步骤 | active |
| `responding` | 正在形成用户可见回复 | active |
| `succeeded` | 本次 turn 已完成 | stopped |
| `failed` | 本次 turn 失败 | stopped |
| `cancelled` | 本次 turn 被取消 | stopped |

组件默认从 `submitted` 开始，因此宿主可以在处理 Enter 的同一同步路径里创建它，不必等待远端 SSE。后续事件始终更新同一个实例；终态会立即释放 motion lease，但仍能渲染稳定的完成、失败或取消标记。

只需要这条状态线时，应使用窄入口，避免加载 root `OrbsRuntime` 的完整组件图：

```ts
import { createAgentRequestRuntime } from "pi-tui-orbs/agent-request";

const requestUi = createAgentRequestRuntime({
  requestRender: () => tui.requestRender(),
  motion: "auto",
  glyphs: "auto",
  color: "auto",
});

const status = requestUi.createAgentRequestStatus({
  description: "Prompt accepted",
});

status.update({ phase: "waiting", description: "Waiting for the model" });
status.update({ phase: "reasoning", description: "Planning the next step" });
status.update({ phase: "tool", description: "Reading project files" });
status.update({ phase: "responding", description: "Writing the answer" });
status.update({ phase: "succeeded", description: "Request completed" });
```

每个活动实例只持有一个 Orb lease；`AgentRequestStatus` 默认使用 100 ms（10 fps）cadence，同一 runtime 的所有实例继续复用一个 `MotionHost` timer。settled 后 lease 数量归零。`update({ phase, description })` 会原子更新一帧，适合把冗长 reasoning/tool payload 压缩成宿主生成的一行 description。

可交互检查全部八个阶段：

```powershell
pnpm run demo:request-status
```

## Assistant status line

`AgentStatus` 只表达 Assistant 内部的过程状态：

| Kind | Active | Complete | Error |
| --- | --- | --- | --- |
| `loading` | 呼吸 Orb | `✓` | `!` |
| `thinking` | 呼吸 Orb | `✓` | `!` |
| `tool` | 呼吸 Orb，标签为 `Tool Call` | `✓` | `!` |

正常流程只使用当前主题的一套 accent ramp；完成态不强行变绿，只有错误引入 error 色。长 payload 会在固定 12 列前缀后换行，窄终端不会溢出。

```ts
import { AgentStatus, MotionHost, StreamingText } from "pi-tui-orbs";

const motion = new MotionHost(() => {
  // 转发给你的 pi-tui 根组件，例如：tui.requestRender()
}, {
  color: "auto",
  glyphs: "auto",
  motion: "auto",
});

// 把它添加到 Assistant 角色容器内，并由调用方负责两格缩进。
const thinking = new AgentStatus(motion, {
  kind: "thinking",
  detail: "Planning the next step…",
  theme: "catppuccin",
  speed: "normal",
});

thinking.setDetail("Plan ready · done · 1.1 s");
thinking.setPhase("complete");

const response = new StreamingText(motion, {
  text: "",
  active: true,
  theme: "catppuccin",
  speed: "normal",
});
response.append("这是 Assistant 正在生成的回复。");
response.setActive(false);
```

Agent reducer 只保存业务事件；动画相位属于视图层，不进入 transcript、revision 或持久化事件。

## GradientBar 与 ExecutionStatus

`GradientBar` 是一条固定宽度的 indeterminate activity bar：它表示“仍在运行，但当前没有可信百分比”，不能冒充真实进度。默认使用 8 个 `▄` 半高色块，Gaussian 色带沿轨道左右往返；余弦轨迹让两端自然减速，所有实例继续共享同一个 50 ms ticker。

```text
Assistant
  Build · pi-tui-orbs · checking visible cells
    · ▄▄▄▄▄▄▄▄ · esc interrupt
```

`ExecutionStatus` 负责长任务的生命周期、元信息、计时和可选中断提示。完成后两行立即折叠为一行：

```text
  ✓ Build · pi-tui-orbs · checking visible cells · 11.0 s
```

```ts
import { ExecutionStatus, GradientBar } from "pi-tui-orbs";

const bar = new GradientBar(motion, {
  cells: 8,
  autoplay: true,
  theme: "github",
  speed: "normal",
});

const build = new ExecutionStatus(motion, {
  label: "Build",
  detail: "pi-tui-orbs · compiling preview scenes",
  interruptible: true,
  theme: "github",
});
build.setDetail("pi-tui-orbs · checking visible cells");
build.setPhase("complete");
```

reduced motion 使用居中的静态渐变；`NO_COLOR` 使用静态密度字符且不申请 timer；窄终端会先缩短轨道，再隐藏 `esc interrupt`。

## ShimmerText 可控流光

`ShimmerText` 是独立的整段文字流光原语；它不承担流式回复状态，也不会逐字显示内容。v2 的招牌不是一团对称 Gaussian 光斑，而是有明确行进方向的彗尾：短而明亮的 core 在前，亮度沿 trail 向后衰减。可见文字始终完整；默认底色只从 `muted` 向 `label` 提亮 10%，让载体保持暗灰，移动流光再连续经过主题 `core`，峰值轻触 `label`。

```ts
import { SHIMMER_VELOCITIES, ShimmerText } from "pi-tui-orbs";

const shimmer = new ShimmerText(motion, {
  text: "工具调用已经完成，正在整理最终回复。",
  active: true,
  theme: "catppuccin",
  speed: "slow",
  direction: "left-to-right",
  loop: "wrap",
  curve: "soft",
  bandWidth: 2,       // 明亮 core 的 terminal-cell 宽度
  trailLength: 12,   // 只拖在行进方向后方
  holdMs: 600,       // 下一次循环前留出呼吸间隔
  baseBrightness: 0.10,     // 载体文字：muted → label
  shimmerBrightness: 0.90, // 移动 core / trail 的提亮强度
});

SHIMMER_VELOCITIES[shimmer.speed]; // 12 cells/s

shimmer.pause();       // 冻结在当前 ANSI 帧
shimmer.resume();      // 从冻结位置继续
shimmer.restart();     // 从所选方向的起点重播
```

- `direction`：`left-to-right / right-to-left`，只改变光带，不反转文字。
- `speed`：`slow / normal / fast` 分别为 `12 / 20 / 32 cells/s`。遍历时间由可见文本长度、core 和 trail 共同决定，不再把任意长度的文本强塞进同一个固定周期。
- `loop`：`wrap` 从轨道外穿越后重来；`ping-pong` 在两端反射；`once` 单次越过后进入 `finished` 并释放 motion lease。
- `curve`：`linear` 匀速；`soft` 使用 `cubic-bezier(0.42, 0, 0.58, 1)` 在端点柔和减速。
- `bandWidth` 是前方亮核的宽度；`trailLength` 是只向后延伸的衰减尾迹；二者都以 terminal cells 计量。`holdMs` 是每次 traversal 完全越过离屏端点后的停顿：wrap 停顿后从起点重来，ping-pong 停顿后反向；once 到端点立即结束，不消费 hold。
- `baseBrightness` 与 `shimmerBrightness` 都是 `0..1`，但职责分离：前者控制载体文字的暗灰明度，后者控制移动光带的提亮强度。`intensity` 暂时保留为 `shimmerBrightness` 的兼容别名；新代码应使用语义更明确的新名称。
- `shimmerBrightness: 0` 会保留可调的暗色载体文字，同时停止申请动画 lease；重新调高后从起点恢复动效。
- 运行中切换 speed 会保留当前光带位置；pause/resume 不会重播。多行文本共享最长一行的 cell 轨道，因此同一时刻的光带 X 坐标一致。
- 实例首次获得正宽度后才申请动画资源；`once` 的结束 deadline 也由同一个共享 ticker 管理，即使随后被隐藏也会释放 lease，不会为每个组件创建额外 timer。
- reduced motion 与 `NO_COLOR` 输出静态原文且不申请 ticker；CJK、emoji 和组合字符按 grapheme 与 terminal cell 计算。

## 可复用 Lab controls

参数实验台使用四个独立公共组件，而不是把快捷键和排版硬编码进 Demo：`ChoiceControl<T>` 表达 radio choice，`SliderControl` 表达强度或数值区间，`ToggleControl` 表达开关，`ControlPanel` 负责对齐标签、保存焦点、处理方向键与 Enter，并把动作委托给当前行。

```ts
const brightness = orbs.createSliderControl({
  label: "Text brightness",
  min: 0,
  max: 1,
  step: 0.05,
  value: 0.10,
  formatValue: (value) => `${Math.round(value * 100)}%`,
  onChange: (value) => shimmer.setBaseBrightness(value),
});

const effect = orbs.createToggleControl({
  label: "Effect",
  value: true,
  onChange: (enabled) => shimmer.setShimmerBrightness(enabled ? 0.90 : 0),
});

const controls = orbs.createControlPanel([effect, brightness]);
tui.addInputListener((data) => {
  if (controls.handleInput(data)) return { consume: true };
});
```

Runtime 会把自己的主题与已经解析的 glyph/color 偏好注入控件，并让有效交互自动请求一次刷新。直接构造控件时仍可传主题名或自定义 `OrbTheme`、Unicode/ASCII glyph、`always/never` color mode；`new ControlPanel(controls, { requestRender })` 可选择接入宿主刷新。所有控件对 ANSI 与窄终端做安全截断；自定义控件只需实现公开的 `LabControl`，不需要知道标签对齐宽度等内部布局字段。

## 公共按钮与选择列表

`Button`、`SelectionList` 实现 pi-tui `Component`，通过 `setModel` / `setTheme` 更新。宿主仍负责键盘路由、选中状态和业务动作；组件不创建独立事件循环。`ChoiceControl` 与 `ToggleControl` 继续负责行内选择和开关。

```ts
import { Button, SelectionList, projectButton, projectChoiceRow } from "pi-tui-orbs";

const button = new Button({ label: "测试连接", intent: "primary", focused: true }, theme);
const list = new SelectionList({
  items: [
    { id: "alpha/chat", group: "团队服务 (alpha)", label: "Chat", badge: "当前默认", tone: "accent" },
    { id: "beta/chat", group: "团队服务 (beta)", label: "Chat", badge: "已配置", tone: "success" },
  ],
  selectedIndex: 1,
  height: 8,
}, theme);

// 旧 Frame 等纯文字宿主直接消费同一投影，投影中没有 ANSI。
const action = projectButton({ label: "断开连接", appearance: "action", intent: "danger", focused: true });
// { text: "› 断开连接", role: "error" }
const row = projectChoiceRow({ id: "allow", label: "允许", kind: "multi", checked: true }, { selected: true });
// [{ text: "› ☑ 允许", role: "focus" }]
```

`theme` 使用 `ControlTheme.paint(role, text)`，默认不加颜色；Settings 的现有主题可直接传入。纯投影返回 `ControlSpan`（`text` / `role`），Component 使用该投影后才着色。`width` 可省略，此时不裁剪也不补齐；传入宽度时按 terminal cells 裁剪，过滤输入中的终端控制序列。

- Button 的 `button` 外观为 `[ label ]`，`plain` 用于底部操作条，`action` 用于操作行。三者的焦点标记均由公共投影生成；`primary` / `danger` 保留强调或危险语义，`disabled` / `busy` 优先。忙碌状态带 `…`，单色下仍可识别。
- 选择行的焦点、勾选与 badge 分开表达；radio 使用 `◉ / ○`，multi 使用 `☑ / ☐`。badge 独立着色，单色时保留文字。
- `SelectionList` 的连续 `group` 是不可选标题，不计入 `selectedIndex`；滚动保留分组上下文及选中项。列表只格式化和着色可见行，`description` 由组件放在条目下方，不会混入纯行投影。
- Settings 的表单 action、普通 action 字段、底部操作、确认操作共用 Button；picker、dialog、宽屏分类栏共用 SelectionList。主页面每个字段每帧只布局一次，后续 pi-tui 容器消费已渲染行；独立底部快捷键与确认尺寸门禁保持不变。

## StreamingText shimmer

`StreamingText` 继续作为更窄的旧语义组件，仅修饰当前正在生成的 Assistant 正文尾部。它刻意保留原来的 `slow 1.40 s / normal 1.00 s / fast 0.76 s` 固定周期和对称 Gaussian sweep，不继承 `ShimmerText` v2 的 cells/s、core、directional trail 或 hold 控件：

- 默认取最后 8 个 grapheme；范围限制为 6–10 个，并限制在约 12 个 terminal cells 内。
- 高光按可见 cell 位置连续扫过，CJK、emoji 和组合字符不会按 UTF-16 单元拆开。
- 新 delta 只更新尾部窗口，不重置 sweep；稳定前缀不参与动画。
- complete 后立即恢复普通正文，不再持有 ticker。
- reduced motion、`NO_COLOR`、`TERM=dumb` 或无色环境严格退化为静态原文。

## Todos 与 Goals

它们共享同一套主题和单活动 Orb，但语义不同：

```text
Todos · 1/3                    Goals · 1/3
  [✓] Complete Inspect API      ◆ Goal 1/3  Complete Understand API
  [●] Active   Build preview    ● Goal 2/3  Active   Design previews
  [ ] Pending  Verify output        Now · Conversation scene
```

- `TodoList` 已是公共组件。Todo 是可执行叶子任务：建立列表后全部可见，组件拒绝同时出现两个 active 项。
- Goal 是结果容器：逐个揭示，活动 Goal 可带一条 `Now` 描述当前动作，完成后保留 outcome。

```ts
import { TodoList } from "pi-tui-orbs";

const todos = new TodoList(motion, {
  items: [
    { title: "Inspect API", state: "complete" },
    { title: "Build preview", state: "active" },
    { title: "Verify output", state: "pending" },
  ],
  theme: "catppuccin",
});
```

## 五套极简主题

主题只改变前景色，不接管用户的终端背景：

| Theme | 背景参考 | Core | 定位 |
| --- | --- | --- | --- |
| `catppuccin` | `#1E1E2E` | `#CBA6F7` | Mocha palette |
| `github` | `#0D1117` | `#4493F8` | GitHub dark primitives |
| `claude` | `#141413` | `#D97757` | Claude 品牌视觉方向 |
| `openai` | `#111111` | `#FFFFFF` | 黑白高对比 |
| `clay` | `#171411` | `#C4A484` | 原创低饱和陶土色 |

Catppuccin 与 GitHub 使用公开 palette/primitives 作为端点；Claude 是品牌方向而非公开 design-token 的逐项复刻；OpenAI 采用黑白原则；Clay 为本项目自定义方案。参考：[Catppuccin Palette](https://catppuccin.com/palette/)、[GitHub Primer Primitives](https://github.com/primer/primitives)、[OpenAI Design Guidelines](https://openai.com/brand/)、[Anthropic Newsroom](https://www.anthropic.com/news)。

## 按组件运行 Demo

`demo:orb` 到 `demo:todos` 以及 `demo:effort` 都进入同一个 registry-driven `component-lab`：每个组件只注册自己的 specimen、控件与 reset 行为，终端外壳、主题切换、输入路由和 Lab controls 完全共享。新增组件不需要再复制一份 Demo 应用。

| Command | 展示内容 | Demo 类型 |
| --- | --- | --- |
| `pnpm run demo` | Conversation / Execution / Todos / Goals 的完整 Agent 场景 | 集成 Gallery |
| `pnpm run demo:gallery` | 与 `demo` 相同的完整 Agent 场景 | 集成 Gallery 别名 |
| `pnpm run demo:orb` | 1-cell 呼吸 Orb | 通用 component lab |
| `pnpm run demo:effort` | 横向带框 EffortMeter | 通用 component lab |
| `pnpm run demo:gradient` | indeterminate 渐变色块轨道 | 通用 component lab |
| `pnpm run demo:request-status` | Prompt 提交到终态的 Agent turn 状态线 | 通用 component lab |
| `pnpm run demo:agent-status` | Loading / Thinking / Tool Call 状态行 | 通用 component lab |
| `pnpm run demo:execution` | 长任务生命周期与中断提示 | 通用 component lab |
| `pnpm run demo:streaming` | Assistant 正文尾部 shimmer | 通用 component lab |
| `pnpm run demo:todos` | Todo 状态推进 | 通用 component lab |
| `pnpm run demo:shimmer` | ShimmerText 的方向、循环、拖尾与明度 | 专用 Shimmer Lab |
| `pnpm run demo:statusline` | 五槽位 ModelStatusline 与响应式预览 | 专用 Statusline Lab |
| `pnpm run demo:form` | FormWorkspace 表单、列表 body、中英文案切换与确认弹层 | 专用 Form Lab |

通用 component lab 使用 `↑ / ↓` 选择控件、`← / →` 调整、`Enter` 切换开关、`1–5` 换主题、`R` 重置、`Q` 退出。Shimmer 和 Statusline 的参数空间更大，因此保留专门的 Lab，而不是把所有控制项塞进通用外壳。

## 四场景 Preview

```powershell
pnpm install
pnpm run verify
pnpm run demo
```

- `C` — Conversation：依次演示 loading、thinking、tool call 和 Assistant 流式回复。
- `E` — Execution：运行 11 秒渐变色块 Build，再让正文 shimmer 保持 4 秒，便于肉眼验收长期动画。
- `T` — Todos：先建立三个 Todo，再逐项 active → complete。
- `G` — Goals：逐个揭示 Goal，通过 `Now` 推进当前动作并记录 outcome。

按 `1–5` 切换主题，`S / M / F` 切换速度，空格暂停/继续，`N` 单步，`R` 重播，`Q` 或 `Ctrl+C` 退出。

## Shimmer Lab

独立实验台不会挤占 Agent Gallery 的 C/E/T/G 场景：

```powershell
pnpm run demo:shimmer
```

- Focus 是一个 specimen-first inspector：上方只保留真实句子，下方用 `↑ / ↓` 选择控件、`← / →` 调值，`Enter` 激活当前 Toggle。Speed、Direction、Loop 使用 radio，Core、Trail、Text brightness、Shimmer brightness、Hold 使用短滑杆，Soft curve 与 Effect 使用开关。
- Text brightness 与 Shimmer brightness 是两条独立滑杆；Effect 关闭后载体文字仍保留当前暗灰明度，但组件不再占用共享 ticker。
- `A / B / C` 载入 Stream、Comet、Pendulum 三种预设；`1–5` 换主题，`Space` 暂停/继续，`R` 从头重播，`V` 进入三预设同步 Compare，`Q` 退出。
- `A Stream`：`12 cells/s`、LTR wrap/soft、Core 2、Trail 12、Hold 600 ms、Text 10%、Shimmer 90%。
- `B Comet`：`32 cells/s`、RTL once/linear、Core 1、Trail 7、Hold 0、Text 5%、Shimmer 100%。
- `C Pendulum`：`12 cells/s`、LTR ping-pong/soft、Core 3、Trail 16、Hold 0、Text 15%、Shimmer 78%。
- Comet 的反向 `once` 便于确认单次完成后状态变为 `finished`；Compare 同步重播三个实例，并继续共享同一个 host ticker。

## FormWorkspace

`FormWorkspace` 是共享的表单页组件（原设置工作区组件的通用化），用 pi-tui 的 `Box`、`HStack`、`VStack`、`ScrollView` 组合分类导航、分组表单和弹层。右侧输入复用 Orbs 控件层的 `Button`、`SelectionList`、`ChoiceControl`、`ToggleControl`，不拥有键盘 reducer、配置文件或保存操作。`SliderControl` 属于控件实验台，不参与表单渲染。

```ts
import { FormWorkspace, type FormWorkspaceModel } from "pi-tui-orbs";

const model: FormWorkspaceModel = {
  height: 24,
  header: "应用设置",
  categories: [{ id: "general", label: "通用" }],
  activeCategoryId: "general",
  focus: "content",
  selectedFieldId: "theme",
  dirtyCount: 0,
  actions: [{ id: "reset", label: "重置设置" }],
  groups: [{
    id: "appearance", title: "外观", fields: [{
      id: "theme", label: "主题", description: "选择终端配色",
      control: { kind: "select", value: "auto", choices: [
        { value: "auto", label: "自动" }, { value: "dark", label: "深色" },
      ] },
    }],
  }],
};
const workspace = new FormWorkspace(model);
const lines = workspace.render(80);
workspace.setModel({ ...model, height: 30 });
```

- Model 可序列化；字段 id 和 choice value 在各自列表内唯一。adapter 在传入前负责值格式化和敏感信息脱敏，组件再移除字符串中的终端控制序列。展示完全由 model 驱动：宿主 reducer 拥有输入路由与副作用，组件只投影当前状态。
- 默认 `NEUTRAL_FORM_WORKSPACE_THEME` 输出纯文本。真实终端通过构造器第二参数或 `setTheme({ paint(role, text) })` 注入颜色和背景；paint 必须保持文字与终端 cell 宽度，不修改字体或字号。
- 宽屏分类栏固定为 22 列，与表单间隔 1 列；表单使用其余可用宽度并保留左右各 1 列内边距，分组框和保存栏随窗口展开。小于 100 列折叠成分类条，小于 10 行使用紧凑布局。选中字段跟随 `ScrollView` 滚动，保存栏跟在实际表单后面。
- `focus` 可为 `navigation`、`content`、`search`、`actions`。`actions` 由调用方完整给出（空列表隐藏操作条），按钮语义取自 action id（`save` 强调、`reset` 危险）。Model 的 `pending`、`writable`、`readonly`、`error` 只影响展示，调用方仍须在 reducer 中限制操作。
- `message` 替代通用保存状态，在固定动作区内完整换行，不随字段滚走；`messageTone` 可指定 `error`、`warning` 或 `muted`。组件根据消息实际高度分配空间；极小窗口仍保留当前字段和取消，超长通知以省略号提示放大查看。
- `modal` 支持 editor、picker、confirmation、dialog、form 五种。`getCursor()` 在 render 后返回 editor/search 的零基 cell 坐标；传入 cursor 使用已脱敏文字的 UTF-16 offset，长输入按 grapheme 边界横向滚动。pending 时不返回 cursor。
- 确认弹层的取消动作必须放在 `actions[0]`。调用方必须用导出的 `fitsFormConfirmation(width, height, modal)` 同时限制确认动作；内容不完整可见时组件只显示放大提示和取消入口。
- 设置 `body: { kind: "list", items, selectedIndex }` 后，内容区改为渲染一个有界 `SelectionList`（自管理滚动窗口，选中行跟随 `focus === "content"` 切换 focus/selected 涂装），`groups` 被完全忽略，宿主应传 `groups: []`。`body.emptyMessage` 缺省时回落到 `model.emptyMessage`；`body.disabledLabel` 可覆盖该列表的 `不可用` 后缀。
- `strings` 按键覆盖内置文案（`pendingLabel`、`readonlyLabel`、`unsavedLabel(count)`、`expandLabel`、`defaultHeaderAction`、`confirmationTooSmall`、`cancelLabel`、`cancelHint`、`searchPlaceholder`）；缺省即英文内置文案，传入导出的 `FORM_WORKSPACE_STRINGS_ZH` 可整套切换为中文。`SelectionList` 的空列表与禁用后缀默认为 `No options` / `unavailable`，中文宿主可使用导出的 `SELECTION_LIST_STRINGS_ZH`（`emptyMessage: 没有可选项`、`disabledLabel: 不可用`）。

控件层同时提供纯投影桥：`projectButton` / `projectChoiceRow`（以及包根导出的 `cleanControlText` / `clipControlText` / `clipControlSpans` / `controlWidth`）把同一模型投影为无语义的 `ControlSpan`（`text` + `role`），纯文字宿主（如旧 Frame 行渲染）与 ANSI 组件消费完全相同的文本，颜色只在最后由 `ControlTheme.paint` 注入。

`ChoiceControl` 新增 `appearance: "select" | "segmented"`，`ToggleControl` 新增 `appearance: "switch"`；两者支持 `valueOnly` 与 `paint`，供表单容器拥有标签与主题。未设置这些选项时，原有 radio/indicator 外观和交互保持兼容。表单表面的 `FormWorkspaceRole` 是 `ControlRole` 与表面角色 `FormWorkspaceSurfaceRole` 的并集，成员与旧版完全一致。

## 设计与许可边界

产品方向参考了 [AICSS Orbs](https://www.aicss.dev/components/orbs) 对紧凑 Agent 活动指示器的表达。长时执行场景参考了 OpenCode 官方 [spinner](https://github.com/anomalyco/opencode/blob/a5f7f8d3b50b01244ca397a43799d6375142043c/packages/tui/src/ui/spinner.ts#L25-L197) 与 [prompt 接线](https://github.com/anomalyco/opencode/blob/a5f7f8d3b50b01244ca397a43799d6375142043c/packages/tui/src/component/prompt/index.tsx#L1783-L1804) 所体现的 Knight Rider scanner 视觉语言，但没有移植其帧表、字符、颜色生成器或依赖。Gradient Bar 使用 monotonic time、余弦往返和 Gaussian cell energy；`ShimmerText` v2 则使用 terminal-cell velocity 与非对称 core/trail profile。两者都只做主题 RGB 插值；本包使用 MIT License。
