import {
  type Component,
  Container,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import {
  AgentStatus,
  colorizeThemeText,
  createOrbsRuntime,
  ExecutionStatus,
  type ModelEffort,
  type ModelStatusPhase,
  type ModelStatusline,
  Orb,
  ORB_THEMES,
  ORB_THEME_NAMES,
  StreamingText,
  TodoList,
  type AgentStatusKind,
  type MotionHost,
  type OrbSpeed,
  type OrbThemeName,
  type TodoItem,
} from "../src/index.js";

type ScenarioId = "conversation" | "execution" | "todos" | "goals";
type GoalState = "pending" | "active" | "complete" | "error";

interface GoalItem {
  readonly title: string;
  readonly state: GoalState;
  readonly outcome?: string;
  readonly now?: string;
}

type PreviewAction =
  | { readonly type: "status.append"; readonly kind: AgentStatusKind; readonly detail: string }
  | { readonly type: "status.complete"; readonly detail: string }
  | { readonly type: "execution.start"; readonly label: string; readonly detail: string }
  | { readonly type: "execution.update"; readonly detail: string }
  | { readonly type: "execution.complete" }
  | { readonly type: "todos.init"; readonly items: readonly string[] }
  | { readonly type: "todo.activate"; readonly index: number }
  | { readonly type: "todo.complete"; readonly index: number }
  | { readonly type: "goals.init"; readonly items: readonly string[] }
  | { readonly type: "goal.activate"; readonly index: number; readonly now: string }
  | { readonly type: "goal.now"; readonly index: number; readonly now: string }
  | { readonly type: "goal.complete"; readonly index: number; readonly outcome: string }
  | { readonly type: "context.update"; readonly used: number }
  | { readonly type: "response.start" }
  | { readonly type: "response.delta"; readonly text: string }
  | { readonly type: "response.complete" };

interface PreviewEvent {
  readonly at: number;
  readonly action: PreviewAction;
}

interface Scenario {
  readonly name: string;
  readonly prompt: string;
  readonly events: readonly PreviewEvent[];
}

interface ScenarioStatusline {
  readonly mode: string;
  readonly effort: ModelEffort;
  readonly initialContext: number;
}

const CONTEXT_LIMIT = 128_000;
const SCENARIO_STATUSLINE: Readonly<Record<ScenarioId, ScenarioStatusline>> = Object.freeze({
  conversation: { mode: "Chat", effort: "medium", initialContext: 18_400 },
  execution: { mode: "Build", effort: "high", initialContext: 22_800 },
  todos: { mode: "Plan", effort: "high", initialContext: 20_600 },
  goals: { mode: "Review", effort: "xhigh", initialContext: 24_200 },
});

const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  conversation: {
    name: "Conversation",
    prompt: "检查当前 Orb API，并给出最小 Agent TUI 方案。",
    events: [
      { at: 0, action: { type: "status.append", kind: "loading", detail: "Reading project context · running" } },
      { at: 520, action: { type: "status.complete", detail: "3 files · done · 0.5 s" } },
      { at: 520, action: { type: "context.update", used: 18_960 } },
      { at: 650, action: { type: "status.append", kind: "thinking", detail: "Planning the response · running" } },
      { at: 1_450, action: { type: "status.complete", detail: "Plan ready · done · 0.8 s" } },
      { at: 1_600, action: { type: "status.append", kind: "tool", detail: "read README.md · running" } },
      { at: 2_400, action: { type: "status.complete", detail: "108 lines · done · 0.8 s" } },
      { at: 2_400, action: { type: "context.update", used: 19_840 } },
      { at: 2_550, action: { type: "response.start" } },
      { at: 2_730, action: { type: "response.delta", text: "Orb 应该只承担活动状态。" } },
      { at: 3_020, action: { type: "response.delta", text: "User 与 Assistant 是同级角色，" } },
      { at: 3_310, action: { type: "response.delta", text: "过程状态收在 Assistant 内部。" } },
      { at: 3_900, action: { type: "response.complete" } },
      { at: 3_900, action: { type: "context.update", used: 20_120 } },
    ],
  },
  execution: {
    name: "Execution",
    prompt: "运行一个较长的 Build，并持续说明当前执行状态。",
    events: [
      {
        at: 0,
        action: {
          type: "execution.start",
          label: "Build",
          detail: "pi-tui-orbs · validating package graph",
        },
      },
      { at: 4_000, action: { type: "execution.update", detail: "pi-tui-orbs · compiling preview scenes" } },
      { at: 4_000, action: { type: "context.update", used: 23_340 } },
      { at: 8_000, action: { type: "execution.update", detail: "pi-tui-orbs · checking visible cells" } },
      { at: 8_000, action: { type: "context.update", used: 24_080 } },
      { at: 11_000, action: { type: "execution.complete" } },
      { at: 11_000, action: { type: "context.update", used: 24_640 } },
      { at: 11_200, action: { type: "response.start" } },
      {
        at: 11_400,
        action: { type: "response.delta", text: "长时任务使用独立的渐变色块轨道；" },
      },
      {
        at: 12_000,
        action: { type: "response.delta", text: "正文尾部则继续使用 shimmer。" },
      },
      { at: 16_000, action: { type: "response.complete" } },
    ],
  },
  todos: {
    name: "Todos",
    prompt: "把 Preview 重构拆成待办，并按顺序逐项完成。",
    events: [
      { at: 0, action: { type: "status.append", kind: "thinking", detail: "Breaking the work into tasks · running" } },
      { at: 520, action: { type: "status.complete", detail: "3 tasks planned · done · 0.5 s" } },
      {
        at: 650,
        action: {
          type: "todos.init",
          items: ["Inspect current hierarchy", "Build three replay scenes", "Verify visible terminal output"],
        },
      },
      { at: 800, action: { type: "todo.activate", index: 0 } },
      { at: 1_450, action: { type: "todo.complete", index: 0 } },
      { at: 1_450, action: { type: "context.update", used: 21_180 } },
      { at: 1_600, action: { type: "todo.activate", index: 1 } },
      { at: 2_450, action: { type: "todo.complete", index: 1 } },
      { at: 2_450, action: { type: "context.update", used: 21_760 } },
      { at: 2_600, action: { type: "todo.activate", index: 2 } },
      { at: 3_350, action: { type: "todo.complete", index: 2 } },
      { at: 3_350, action: { type: "context.update", used: 22_420 } },
      { at: 3_500, action: { type: "response.start" } },
      { at: 3_700, action: { type: "response.delta", text: "3 个 Todo 已依次完成，" } },
      { at: 3_980, action: { type: "response.delta", text: "Preview 可以进入视觉审阅。" } },
      { at: 4_450, action: { type: "response.complete" } },
    ],
  },
  goals: {
    name: "Goals",
    prompt: "先理解 API，再完成三个 Preview，最后定义验证门槛。",
    events: [
      { at: 0, action: { type: "status.append", kind: "loading", detail: "Loading repository · running" } },
      { at: 400, action: { type: "status.complete", detail: "Repository ready · done · 0.4 s" } },
      { at: 520, action: { type: "status.append", kind: "thinking", detail: "Identifying outcomes · running" } },
      { at: 950, action: { type: "status.complete", detail: "3 goals identified · done · 0.4 s" } },
      {
        at: 1_100,
        action: {
          type: "goals.init",
          items: ["Understand current API", "Design three previews", "Define verification gates"],
        },
      },
      { at: 1_200, action: { type: "goal.activate", index: 0, now: "Mapping components" } },
      { at: 1_550, action: { type: "goal.now", index: 0, now: "Tracing role and status ownership" } },
      { at: 1_900, action: { type: "goal.complete", index: 0, outcome: "component map captured" } },
      { at: 1_900, action: { type: "context.update", used: 24_940 } },
      { at: 2_000, action: { type: "goal.activate", index: 1, now: "Conversation preview" } },
      { at: 2_550, action: { type: "goal.now", index: 1, now: "Todos completion timeline" } },
      { at: 3_050, action: { type: "goal.now", index: 1, now: "Goals progression timeline" } },
      { at: 3_500, action: { type: "goal.complete", index: 1, outcome: "hierarchy approved" } },
      { at: 3_500, action: { type: "context.update", used: 25_780 } },
      { at: 3_620, action: { type: "goal.activate", index: 2, now: "Visible-screen checks" } },
      { at: 4_350, action: { type: "goal.complete", index: 2, outcome: "26 checks passed" } },
      { at: 4_350, action: { type: "context.update", used: 26_410 } },
      { at: 4_500, action: { type: "response.start" } },
      { at: 4_700, action: { type: "response.delta", text: "三个 Goal 已按结果顺序完成。" } },
      { at: 5_200, action: { type: "response.complete" } },
    ],
  },
};

class Indented implements Component {
  readonly #component: Component;
  readonly #columns: number;

  constructor(component: Component, columns: number) {
    this.#component = component;
    this.#columns = columns;
  }

  invalidate(): void {
    this.#component.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const indent = Math.min(this.#columns, safeWidth);
    const prefix = " ".repeat(indent);
    return this.#component.render(Math.max(0, safeWidth - indent)).map((line) => prefix + line);
  }
}

class GoalPreviewList implements Component {
  readonly #host: MotionHost;
  readonly #orb: Orb;
  #items: GoalItem[] = [];
  #visibleCount = 0;
  #theme: OrbThemeName;
  #enabled = true;

  constructor(host: MotionHost, theme: OrbThemeName, speed: OrbSpeed) {
    this.#host = host;
    this.#theme = theme;
    this.#orb = new Orb(host, { theme, speed });
  }

  invalidate(): void {
    this.#orb.invalidate();
  }

  setItems(items: readonly GoalItem[], visibleCount = 0): void {
    this.#items = items.map((item) => ({ ...item }));
    this.#visibleCount = Math.max(0, Math.min(items.length, visibleCount));
    this.#syncOrb();
    this.#host.requestRender();
  }

  updateItem(index: number, update: Partial<GoalItem>): void {
    const current = this.#items[index];
    if (current === undefined) return;
    this.#items[index] = { ...current, ...update };
    this.#visibleCount = Math.max(this.#visibleCount, index + 1);
    this.#syncOrb();
    this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    this.#theme = theme;
    this.#orb.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    this.#orb.setSpeed(speed);
  }

  start(): void {
    this.#enabled = true;
    this.#syncOrb();
  }

  stop(): void {
    this.#enabled = false;
    this.#orb.stop();
  }

  dispose(): void {
    this.#orb.dispose();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const visibleItems = this.#items.slice(0, this.#visibleCount);
    const completed = this.#items.filter((item) => item.state === "complete").length;
    const lines = [this.#style(`Goals · ${completed}/${this.#items.length}`, "label")];

    visibleItems.forEach((item, index) => {
      const marker = this.#marker(item.state);
      const stateLabel = `${item.state[0]?.toUpperCase() ?? ""}${item.state.slice(1)}`.padEnd(8);
      const state = this.#style(stateLabel, item.state === "error" ? "error" : "muted");
      const prefix = `  ${marker} Goal ${index + 1}/${this.#items.length}  ${state} `;
      const outcome = item.outcome === undefined ? "" : ` · ${item.outcome}`;
      const payload = item.state === "complete"
        ? this.#style(item.title + outcome, "muted")
        : item.title + outcome;
      lines.push(this.#fit(prefix + payload, safeWidth));

      if (item.state === "active" && item.now !== undefined) {
        const now = this.#style("Now · ", "muted") + item.now;
        lines.push(this.#fit(`      ${now}`, safeWidth));
      }
    });

    return lines;
  }

  #marker(state: GoalState): string {
    if (state === "active") {
      const orb = this.#orb.render(1)[0] ?? "";
      return this.#host.glyphs === "ascii" ? `<${orb}>` : orb;
    }

    const ascii = this.#host.glyphs === "ascii";
    const raw = state === "pending" ? (ascii ? "< >" : "◇")
      : state === "complete" ? (ascii ? "<+>" : "◆")
        : (ascii ? "<!>" : "×");
    const token = state === "error" ? "error" : state === "complete" ? "high" : "muted";
    return this.#style(raw, token);
  }

  #style(text: string, token: "label" | "muted" | "high" | "error"): string {
    if (this.#host.color !== "always") return text;
    return colorizeThemeText(text, token, ORB_THEMES[this.#theme]);
  }

  #fit(text: string, width: number): string {
    const output = truncateToWidth(text, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
  }

  #syncOrb(): void {
    const hasActive = this.#items.some((item) => item.state === "active");
    if (this.#enabled && hasActive) this.#orb.start();
    else this.#orb.stop();
  }
}

class ResponseSection implements Component {
  readonly #host: MotionHost;
  readonly #text: StreamingText;
  #theme: OrbThemeName;
  #streaming = true;

  constructor(host: MotionHost, theme: OrbThemeName, speed: OrbSpeed) {
    this.#host = host;
    this.#theme = theme;
    this.#text = new StreamingText(host, { active: true, theme, speed, tailLength: 8 });
  }

  invalidate(): void {
    this.#text.invalidate();
  }

  append(delta: string): void {
    this.#text.append(delta);
  }

  complete(): void {
    this.#streaming = false;
    this.#text.setActive(false);
    this.#host.requestRender();
  }

  start(): void {
    if (this.#streaming) this.#text.start();
  }

  stop(): void {
    this.#text.stop();
  }

  setTheme(theme: OrbThemeName): void {
    this.#theme = theme;
    this.#text.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    this.#text.setSpeed(speed);
  }

  dispose(): void {
    this.#text.dispose();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const palette = ORB_THEMES[this.#theme];
    const state = this.#streaming ? "streaming" : "done";
    const title = this.#host.color === "always"
      ? `${colorizeThemeText("Response", "label", palette)} ${colorizeThemeText(`· ${state}`, "muted", palette)}`
      : `Response · ${state}`;
    const bodyWidth = Math.max(0, safeWidth - 2);
    const body = this.#text.render(bodyWidth).map((line) => `  ${line}`);
    return [title, ...body];
  }
}

class ReplayPlayer {
  readonly #apply: (action: PreviewAction) => void;
  readonly #reset: () => void;
  readonly #changed: () => void;
  #events: readonly PreviewEvent[];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #cursor = 0;
  #playhead = 0;
  #anchorAt = 0;
  #playing = false;

  constructor(
    events: readonly PreviewEvent[],
    apply: (action: PreviewAction) => void,
    reset: () => void,
    changed: () => void,
  ) {
    this.#events = events;
    this.#apply = apply;
    this.#reset = reset;
    this.#changed = changed;
  }

  get state(): "playing" | "paused" | "complete" {
    if (this.#playing) return "playing";
    return this.#cursor >= this.#events.length ? "complete" : "paused";
  }

  setEvents(events: readonly PreviewEvent[]): void {
    this.#events = events;
  }

  restart(): void {
    this.#clearTimer();
    this.#cursor = 0;
    this.#playhead = 0;
    this.#anchorAt = performance.now();
    this.#playing = true;
    this.#reset();
    this.#changed();
    this.#schedule();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playhead += Math.max(0, performance.now() - this.#anchorAt);
    this.#playing = false;
    this.#clearTimer();
    this.#changed();
  }

  resume(): void {
    if (this.#playing || this.#cursor >= this.#events.length) return;
    this.#playing = true;
    this.#anchorAt = performance.now();
    this.#changed();
    this.#schedule();
  }

  step(): void {
    this.pause();
    const event = this.#events[this.#cursor];
    if (event === undefined) return;
    this.#playhead = event.at;
    this.#cursor += 1;
    this.#apply(event.action);
    this.#changed();
  }

  dispose(): void {
    this.#playing = false;
    this.#clearTimer();
  }

  #schedule(): void {
    if (!this.#playing) return;
    const event = this.#events[this.#cursor];
    if (event === undefined) {
      this.#playing = false;
      this.#changed();
      return;
    }
    const delay = Math.max(0, event.at - this.#playhead);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#playhead = event.at;
      this.#cursor += 1;
      this.#anchorAt = performance.now();
      this.#apply(event.action);
      this.#schedule();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

const tui = new TuiAltScreen(new ProcessTerminal());
const runtime = createOrbsRuntime({
  requestRender: () => tui.requestRender(),
  theme: "catppuccin",
  motion: "full",
  glyphs: "unicode",
  color: "always",
});
const host = runtime.host;
const header = new Text("", 0, 0);
const userRole = new Text("");
const userContent = new Text("");
const assistantRole = new Text("");
const assistantBody = new Container();
const footer = new Text("", 0, 0);
const transcriptDocument = new Container();

transcriptDocument.addChild(new Text(""));
transcriptDocument.addChild(userRole);
transcriptDocument.addChild(userContent);
transcriptDocument.addChild(new Text(""));
transcriptDocument.addChild(assistantRole);
transcriptDocument.addChild(assistantBody);
transcriptDocument.addChild(new Text(""));

let scenarioId: ScenarioId = "conversation";
let theme: OrbThemeName = runtime.theme;
let speed: OrbSpeed = "normal";
let currentStatus: AgentStatus | undefined;
let statusRows: AgentStatus[] = [];
let execution: ExecutionStatus | undefined;
let todos: TodoList | undefined;
let todoItems: TodoItem[] = [];
let goals: GoalPreviewList | undefined;
let goalCount = 0;
let completedGoals = 0;
let response: ResponseSection | undefined;
let stopped = false;
let player: ReplayPlayer;
let contextUsed = SCENARIO_STATUSLINE[scenarioId].initialContext;

const statusline: ModelStatusline = runtime.createModelStatusline({
  mode: SCENARIO_STATUSLINE[scenarioId].mode,
  model: "MiMo-V2.5-Pro",
  effort: SCENARIO_STATUSLINE[scenarioId].effort,
  context: { used: contextUsed, limit: CONTEXT_LIMIT },
  status: { phase: "idle", label: "Ready" },
  speed,
});
const transcript = new ScrollView(transcriptDocument, {
  follow: "end",
  primary: true,
  scrollbar: "auto",
});

tui.setLayoutRoot(new VStack([
  { component: header, basis: 1, shrink: 0, minSize: 1 },
  { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
  { component: statusline, basis: 1, shrink: 0, minSize: 1 },
  { component: footer, basis: 1, shrink: 0, minSize: 1 },
]));

function setModelStatus(phase: ModelStatusPhase, label: string): void {
  statusline.update({ status: { phase, label } });
}

function setContextUsage(used: number): void {
  contextUsed = used;
  statusline.update({ context: { used: contextUsed, limit: CONTEXT_LIMIT } });
}

function resetModelStatusline(): void {
  const snapshot = SCENARIO_STATUSLINE[scenarioId];
  contextUsed = snapshot.initialContext;
  statusline.update({
    mode: snapshot.mode,
    effort: snapshot.effort,
    context: { used: contextUsed, limit: CONTEXT_LIMIT },
    status: { phase: "idle", label: "Ready" },
  });
}

function activeLabel(kind: AgentStatusKind): string {
  switch (kind) {
    case "loading": return "Loading";
    case "thinking": return "Thinking";
    case "tool": return "Tool call";
  }
}

function updateChrome(): void {
  const palette = ORB_THEMES[theme];
  const tab = (id: ScenarioId, key: string): string => {
    const label = `[${key}] ${SCENARIOS[id].name}`;
    return colorizeThemeText(label, id === scenarioId ? "label" : "muted", palette);
  };
  header.setText(
    `${colorizeThemeText("pi-tui-orbs", "label", palette)}  `
    + `${tab("conversation", "C")}  ${tab("execution", "E")}  `
    + `${tab("todos", "T")}  ${tab("goals", "G")}`,
  );
  userRole.setText(colorizeThemeText("User", "label", palette));
  assistantRole.setText(colorizeThemeText("Assistant", "label", palette));
  userContent.setText(`  ${SCENARIOS[scenarioId].prompt}`);
  footer.setText(
    `${player?.state ?? "paused"} · C/E/T/G · 1–5 theme · S/M/F speed · `
    + "Space pause · N/R · Q exit",
  );
  tui.requestRender();
}

function appendStatus(kind: AgentStatusKind, detail: string): void {
  const status = runtime.createAgentStatus({ kind, detail, speed });
  statusRows.push(status);
  currentStatus = status;
  assistantBody.addChild(new Indented(status, 2));
  tui.requestRender();
}

function createExecution(label: string, detail: string): void {
  if (execution !== undefined) runtime.destroy(execution);
  execution = runtime.createExecutionStatus({
    label,
    detail,
    interruptible: true,
    cells: 8,
    speed,
  });
  assistantBody.addChild(new Indented(execution, 2));
  tui.requestRender();
}

function createTodos(titles: readonly string[]): void {
  if (todos !== undefined) runtime.destroy(todos);
  todoItems = titles.map((title) => ({ title, state: "pending" }));
  todos = runtime.createTodoList({ items: todoItems, speed });
  assistantBody.addChild(new Indented(todos, 2));
  tui.requestRender();
}

function updateTodo(index: number, state: TodoItem["state"]): void {
  const current = todoItems[index];
  if (current === undefined) return;
  todoItems[index] = { ...current, state };
  todos?.setItems(todoItems);
}

function createGoals(titles: readonly string[]): void {
  goals?.dispose();
  goalCount = titles.length;
  completedGoals = 0;
  goals = new GoalPreviewList(host, theme, speed);
  goals.setItems(titles.map((title) => ({ title, state: "pending" })));
  assistantBody.addChild(new Indented(goals, 2));
  tui.requestRender();
}

function createResponse(): void {
  response?.dispose();
  response = new ResponseSection(host, theme, speed);
  assistantBody.addChild(new Indented(response, 2));
  tui.requestRender();
}

function applyAction(action: PreviewAction): void {
  switch (action.type) {
    case "status.append":
      appendStatus(action.kind, action.detail);
      setModelStatus("active", activeLabel(action.kind));
      break;
    case "status.complete":
      currentStatus?.setDetail(action.detail);
      currentStatus?.setPhase("complete");
      setModelStatus("complete", "Step done");
      break;
    case "execution.start":
      createExecution(action.label, action.detail);
      setModelStatus("active", "Building");
      break;
    case "execution.update":
      execution?.setDetail(action.detail);
      setModelStatus("active", "Building");
      break;
    case "execution.complete":
      execution?.setPhase("complete");
      setModelStatus("complete", "Build done");
      break;
    case "todos.init":
      createTodos(action.items);
      setModelStatus("active", `Todos 0/${action.items.length}`);
      break;
    case "todo.activate":
      updateTodo(action.index, "active");
      setModelStatus("active", `Todo ${action.index + 1}/${todoItems.length}`);
      break;
    case "todo.complete": {
      updateTodo(action.index, "complete");
      const completed = todoItems.filter((item) => item.state === "complete").length;
      setModelStatus(
        completed === todoItems.length ? "complete" : "active",
        `${completed}/${todoItems.length} todos`,
      );
      break;
    }
    case "goals.init":
      createGoals(action.items);
      setModelStatus("active", `Goals 0/${action.items.length}`);
      break;
    case "goal.activate":
      goals?.updateItem(action.index, { state: "active", now: action.now });
      setModelStatus("active", `Goal ${action.index + 1}/${goalCount}`);
      break;
    case "goal.now":
      goals?.updateItem(action.index, { now: action.now });
      setModelStatus("active", `Goal ${action.index + 1}/${goalCount}`);
      break;
    case "goal.complete":
      goals?.updateItem(action.index, { state: "complete", outcome: action.outcome });
      completedGoals += 1;
      setModelStatus(
        completedGoals === goalCount ? "complete" : "active",
        `${completedGoals}/${goalCount} goals`,
      );
      break;
    case "context.update":
      setContextUsage(action.used);
      break;
    case "response.start":
      createResponse();
      setModelStatus("active", "Generating");
      break;
    case "response.delta":
      response?.append(action.text);
      break;
    case "response.complete":
      response?.complete();
      setModelStatus("complete", "Done");
      break;
  }
}

function resetScene(): void {
  for (const status of statusRows) runtime.destroy(status);
  statusRows = [];
  currentStatus = undefined;
  if (execution !== undefined) runtime.destroy(execution);
  execution = undefined;
  if (todos !== undefined) runtime.destroy(todos);
  todos = undefined;
  todoItems = [];
  goals?.dispose();
  goals = undefined;
  goalCount = 0;
  completedGoals = 0;
  response?.dispose();
  response = undefined;
  assistantBody.clear();
  resetModelStatusline();
  tui.requestRender();
}

function pauseMotion(): void {
  for (const status of statusRows) status.stop();
  execution?.stop();
  todos?.stop();
  goals?.stop();
  response?.stop();
  statusline.stop();
}

function resumeMotion(): void {
  for (const status of statusRows) status.start();
  execution?.start();
  todos?.start();
  goals?.start();
  response?.start();
  statusline.start();
}

player = new ReplayPlayer(
  SCENARIOS[scenarioId].events,
  applyAction,
  resetScene,
  updateChrome,
);

function selectScenario(selected: ScenarioId): void {
  if (selected === scenarioId) {
    player.restart();
    return;
  }
  scenarioId = selected;
  player.setEvents(SCENARIOS[scenarioId].events);
  updateChrome();
  player.restart();
}

function selectTheme(index: number): void {
  const selected = ORB_THEME_NAMES[index];
  if (selected === undefined) return;
  theme = selected;
  runtime.setTheme(theme);
  goals?.setTheme(theme);
  response?.setTheme(theme);
  updateChrome();
}

function selectSpeed(selected: OrbSpeed): void {
  speed = selected;
  for (const status of statusRows) status.setSpeed(speed);
  execution?.setSpeed(speed);
  todos?.setSpeed(speed);
  goals?.setSpeed(speed);
  response?.setSpeed(speed);
  statusline.setSpeed(speed);
  updateChrome();
}

function togglePause(): void {
  if (player.state === "playing") {
    player.pause();
    pauseMotion();
  } else {
    player.resume();
    resumeMotion();
  }
  updateChrome();
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  player.dispose();
  resetScene();
  runtime.dispose();
  tui.stop({ preserveScreen: true });
}

tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
    stop();
    return { consume: true };
  }
  if (tui.hasOverlay()) return;

  const key = data.toLowerCase();
  if (key === "c") selectScenario("conversation");
  else if (key === "e") selectScenario("execution");
  else if (key === "t") selectScenario("todos");
  else if (key === "g") selectScenario("goals");
  else if (/^[1-5]$/u.test(data)) selectTheme(Number(data) - 1);
  else if (key === "s") selectSpeed("slow");
  else if (key === "m") selectSpeed("normal");
  else if (key === "f") selectSpeed("fast");
  else if (key === "r") player.restart();
  else if (key === "n") {
    player.step();
    pauseMotion();
  } else if (data === " ") togglePause();
  else return;
  return { consume: true };
});

process.once("SIGINT", stop);
updateChrome();
player.restart();
tui.start();
