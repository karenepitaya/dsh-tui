import type { Component } from "@earendil-works/pi-tui";
import {
  AGENT_REQUEST_PHASES,
  type AgentRequestPhase,
  type AgentRequestStatus,
  type AgentStatus,
  type AgentStatusKind,
  type AgentStatusPhase,
  type ChoiceControl,
  EFFORT_METER_COMPACT_WIDTH,
  EFFORT_METER_FULL_WIDTH,
  type EffortMeter,
  type ExecutionPhase,
  type ExecutionStatus,
  type GradientBar,
  MODEL_EFFORTS,
  type ModelEffort,
  type Orb,
  type OrbsRuntime,
  type OrbSpeed,
  type SliderControl,
  type StreamingText,
  type TodoItem,
  type TodoList,
  type ToggleControl,
} from "../src/index.js";
import {
  type ComponentDefinition,
  runComponentLab,
  type SpecimenBundle,
} from "./component-lab-shell.js";

type ComponentOption =
  | "orb"
  | "effort"
  | "gradient"
  | "request-status"
  | "agent-status"
  | "execution"
  | "streaming"
  | "todos";

const SPEED_CHOICES = Object.freeze([
  { value: "slow", label: "Slow" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
] as const);

function speedControl(
  runtime: OrbsRuntime,
  value: OrbSpeed,
  onChange: (value: OrbSpeed) => void,
): ChoiceControl<OrbSpeed> {
  return runtime.createChoiceControl({
    label: "Speed",
    value,
    choices: SPEED_CHOICES,
    onChange,
  });
}

function activeControl(
  runtime: OrbsRuntime,
  value: boolean,
  onChange: (value: boolean) => void,
): ToggleControl {
  return runtime.createToggleControl({
    label: "Motion",
    value,
    onLabel: "Running",
    offLabel: "Paused",
    onChange,
  });
}

type EffortLayout = "full" | "compact";

class EffortSpecimen implements Component {
  readonly #meter: EffortMeter;
  #layout: EffortLayout;

  constructor(meter: EffortMeter, layout: EffortLayout) {
    this.#meter = meter;
    this.#layout = layout;
  }

  invalidate(): void {
    this.#meter.invalidate();
  }

  setLayout(layout: EffortLayout): void {
    this.#layout = layout;
  }

  render(width: number): string[] {
    const targetWidth = this.#layout === "full"
      ? EFFORT_METER_FULL_WIDTH
      : EFFORT_METER_COMPACT_WIDTH;
    return this.#meter.render(Math.min(Math.max(0, width), targetWidth));
  }
}

function createEffortSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = { effort: "high" as ModelEffort, layout: "full" as EffortLayout };
  const meter = runtime.createEffortMeter({ effort: defaults.effort });
  const specimen = new EffortSpecimen(meter, defaults.layout);
  const effort = runtime.createChoiceControl({
    label: "Effort",
    value: defaults.effort,
    choices: MODEL_EFFORTS.map((value) => ({ value, label: value })),
    onChange: (value) => meter.setEffort(value),
  });
  const layout = runtime.createChoiceControl({
    label: "Layout",
    value: defaults.layout,
    choices: [
      { value: "full", label: `Full · ${EFFORT_METER_FULL_WIDTH} cells` },
      { value: "compact", label: `Compact · ${EFFORT_METER_COMPACT_WIDTH} cells` },
    ],
    onChange: (value) => specimen.setLayout(value),
  });
  return {
    component: specimen,
    controls: [effort, layout],
    reset: () => {
      effort.setValue(defaults.effort);
      layout.setValue(defaults.layout);
      meter.setEffort(defaults.effort);
      specimen.setLayout(defaults.layout);
    },
  };
}

function createOrbSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = { label: "Thinking through the request", speed: "normal" as OrbSpeed };
  const orb: Orb = runtime.createOrb({ ...defaults, autoplay: true });
  const label = runtime.createChoiceControl({
    label: "Label",
    value: "thinking",
    choices: [
      { value: "thinking", label: "Thinking" },
      { value: "loading", label: "Loading" },
      { value: "tool", label: "Tool call" },
    ],
    onChange: (value) => orb.setLabel({
      thinking: "Thinking through the request",
      loading: "Loading project context",
      tool: "Calling read_file",
    }[value]),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => orb.setSpeed(value));
  const motion = activeControl(runtime, true, (value) => value ? orb.start() : orb.stop());
  return {
    component: orb,
    controls: [label, speed, motion],
    reset: () => {
      label.setValue("thinking");
      speed.setValue(defaults.speed);
      motion.setValue(true);
      orb.setLabel(defaults.label);
      orb.start();
    },
  };
}

function createGradientSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = { cells: 14, speed: "normal" as OrbSpeed };
  const bar: GradientBar = runtime.createGradientBar({ ...defaults, autoplay: true });
  const cells: SliderControl = runtime.createSliderControl({
    label: "Cells",
    min: 4,
    max: 32,
    step: 2,
    value: defaults.cells,
    formatValue: (value) => `${value} cells`,
    onChange: (value) => bar.setCells(value),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => bar.setSpeed(value));
  const motion = activeControl(runtime, true, (value) => value ? bar.start() : bar.stop());
  return {
    component: bar,
    controls: [cells, speed, motion],
    reset: () => {
      cells.setValue(defaults.cells);
      speed.setValue(defaults.speed);
      motion.setValue(true);
      bar.start();
    },
  };
}

function createAgentStatusSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = {
    kind: "thinking" as AgentStatusKind,
    phase: "active" as AgentStatusPhase,
    detail: "Planning the next safe change",
    speed: "normal" as OrbSpeed,
  };
  const status: AgentStatus = runtime.createAgentStatus(defaults);
  const kind = runtime.createChoiceControl({
    label: "Kind",
    value: defaults.kind,
    choices: [
      { value: "loading", label: "Loading" },
      { value: "thinking", label: "Thinking" },
      { value: "tool", label: "Tool call" },
    ],
    onChange: (value) => status.setKind(value),
  });
  const phase = runtime.createChoiceControl({
    label: "Phase",
    value: defaults.phase,
    choices: [
      { value: "active", label: "Active" },
      { value: "complete", label: "Complete" },
      { value: "error", label: "Error" },
    ],
    onChange: (value) => status.setPhase(value),
  });
  const detail = runtime.createChoiceControl({
    label: "Detail",
    value: "message",
    choices: [
      { value: "message", label: "Message" },
      { value: "path", label: "Path" },
      { value: "none", label: "None" },
    ],
    onChange: (value) => status.setDetail({
      message: defaults.detail,
      path: "src/model-statusline.ts",
      none: "",
    }[value]),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => status.setSpeed(value));
  return {
    component: status,
    controls: [kind, phase, detail, speed],
    reset: () => {
      kind.setValue(defaults.kind);
      detail.setValue("message");
      speed.setValue(defaults.speed);
      phase.setValue(defaults.phase);
      status.setDetail(defaults.detail);
    },
  };
}

function createAgentRequestStatusSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = {
    phase: "submitted" as AgentRequestPhase,
    speed: "normal" as OrbSpeed,
  };
  const descriptions: Readonly<Record<AgentRequestPhase, string>> = Object.freeze({
    submitted: "Prompt accepted",
    waiting: "Waiting for the model",
    reasoning: "Planning the next step",
    tool: "Reading project files",
    responding: "Writing the answer",
    succeeded: "Request completed",
    failed: "Request failed",
    cancelled: "Request cancelled",
  });
  const status: AgentRequestStatus = runtime.createAgentRequestStatus({
    phase: defaults.phase,
    description: descriptions[defaults.phase],
    speed: defaults.speed,
  });
  const phase = runtime.createChoiceControl({
    label: "Phase",
    value: defaults.phase,
    choices: AGENT_REQUEST_PHASES.map((value) => ({ value, label: value })),
    onChange: (value) => status.update({
      phase: value,
      description: descriptions[value],
    }),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => status.setSpeed(value));
  return {
    component: status,
    controls: [phase, speed],
    reset: () => {
      phase.setValue(defaults.phase);
      speed.setValue(defaults.speed);
      status.update({
        phase: defaults.phase,
        description: descriptions[defaults.phase],
      });
    },
  };
}

function createExecutionSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = {
    phase: "active" as ExecutionPhase,
    speed: "normal" as OrbSpeed,
    interruptible: true,
  };
  const execution: ExecutionStatus = runtime.createExecutionStatus({
    label: "Build",
    detail: "pnpm run verify",
    cells: 14,
    ...defaults,
  });
  const phase = runtime.createChoiceControl({
    label: "Phase",
    value: defaults.phase,
    choices: [
      { value: "active", label: "Active" },
      { value: "complete", label: "Done" },
      { value: "error", label: "Error" },
      { value: "cancelled", label: "Cancelled" },
    ],
    onChange: (value) => execution.setPhase(value),
  });
  const detail = runtime.createChoiceControl({
    label: "Detail",
    value: "verify",
    choices: [
      { value: "verify", label: "Verify" },
      { value: "tests", label: "Tests" },
      { value: "none", label: "None" },
    ],
    onChange: (value) => execution.setDetail({
      verify: "pnpm run verify",
      tests: "135 tests",
      none: "",
    }[value]),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => execution.setSpeed(value));
  const interruptible = runtime.createToggleControl({
    label: "Interrupt",
    value: defaults.interruptible,
    onLabel: "esc enabled",
    offLabel: "disabled",
    onChange: (value) => execution.setInterruptible(value),
  });
  return {
    component: execution,
    controls: [phase, detail, speed, interruptible],
    reset: () => {
      detail.setValue("verify");
      speed.setValue(defaults.speed);
      interruptible.setValue(defaults.interruptible);
      phase.setValue(defaults.phase);
      execution.setDetail("pnpm run verify");
    },
  };
}

function createStreamingSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  const defaults = { speed: "normal" as OrbSpeed, tailLength: 8, active: true };
  const copy = {
    answer: "I inspected the runtime and found a small, composable API surface.",
    tool: "Reading the selected files and collecting the relevant symbols.",
    cjk: "正在整理工具结果，并生成可以直接交付的回答。",
  } as const;
  const streaming: StreamingText = runtime.createStreamingText({
    text: copy.answer,
    ...defaults,
  });
  const text = runtime.createChoiceControl({
    label: "Text",
    value: "answer",
    choices: [
      { value: "answer", label: "Answer" },
      { value: "tool", label: "Tool result" },
      { value: "cjk", label: "CJK" },
    ],
    onChange: (value) => streaming.setText(copy[value]),
  });
  const speed = speedControl(runtime, defaults.speed, (value) => streaming.setSpeed(value));
  const tail = runtime.createSliderControl({
    label: "Tail",
    min: 6,
    max: 10,
    step: 1,
    value: defaults.tailLength,
    formatValue: (value) => `${value} glyphs`,
    onChange: (value) => streaming.setTailLength(value),
  });
  const motion = activeControl(runtime, defaults.active, (value) => streaming.setActive(value));
  return {
    component: streaming,
    controls: [text, speed, tail, motion],
    reset: () => {
      text.setValue("answer");
      speed.setValue(defaults.speed);
      tail.setValue(defaults.tailLength);
      motion.setValue(defaults.active);
      streaming.setText(copy.answer);
      streaming.start();
    },
  };
}

function createTodoSpecimen(runtime: OrbsRuntime): SpecimenBundle {
  type TodoOutcome = "running" | "done" | "error";
  const titles = [
    "Inspect component APIs",
    "Compose reusable controls",
    "Verify terminal layout",
    "Document demo commands",
  ] as const;
  const defaults = { progress: 1, outcome: "running" as TodoOutcome, speed: "normal" as OrbSpeed };
  let progress = defaults.progress;
  let outcome = defaults.outcome;

  function items(): readonly TodoItem[] {
    if (outcome === "done") return titles.map((title) => ({ title, state: "complete" }));
    const focus = Math.min(progress, titles.length - 1);
    return titles.map((title, index) => ({
      title,
      state: index < focus
        ? "complete"
        : index === focus
          ? (outcome === "error" ? "error" : "active")
          : "pending",
    }));
  }

  const todos: TodoList = runtime.createTodoList({
    title: "Component Lab",
    items: items(),
    speed: defaults.speed,
  });
  const progressControl = runtime.createSliderControl({
    label: "Progress",
    min: 0,
    max: titles.length - 1,
    step: 1,
    value: defaults.progress,
    formatValue: (value) => `${value + 1} / ${titles.length}`,
    onChange: (value) => {
      progress = value;
      todos.setItems(items());
    },
  });
  const outcomeControl = runtime.createChoiceControl({
    label: "Outcome",
    value: defaults.outcome,
    choices: [
      { value: "running", label: "Running" },
      { value: "done", label: "Done" },
      { value: "error", label: "Error" },
    ],
    onChange: (value) => {
      outcome = value;
      todos.setItems(items());
    },
  });
  const speed = speedControl(runtime, defaults.speed, (value) => todos.setSpeed(value));
  return {
    component: todos,
    controls: [progressControl, outcomeControl, speed],
    reset: () => {
      progress = defaults.progress;
      outcome = defaults.outcome;
      progressControl.setValue(defaults.progress);
      outcomeControl.setValue(defaults.outcome);
      speed.setValue(defaults.speed);
      todos.setItems(items());
      todos.start();
    },
  };
}

const COMPONENT_DEFINITIONS: Readonly<Record<ComponentOption, ComponentDefinition>> = Object.freeze({
  orb: Object.freeze({
    id: "orb",
    title: "Orb",
    description: "Breathing activity marker with a concise inline label.",
    create: createOrbSpecimen,
  }),
  effort: Object.freeze({
    id: "effort",
    title: "Effort Meter",
    description: "Static four-level reasoning effort with a framed horizontal scale.",
    create: createEffortSpecimen,
  }),
  gradient: Object.freeze({
    id: "gradient",
    title: "Gradient Bar",
    description: "Indeterminate color block for long-running tool execution.",
    create: createGradientSpecimen,
  }),
  "agent-status": Object.freeze({
    id: "agent-status",
    title: "Agent Status",
    description: "Assistant-owned loading, thinking and tool-call status line.",
    create: createAgentStatusSpecimen,
  }),
  "request-status": Object.freeze({
    id: "request-status",
    title: "Agent Request Status",
    description: "One compact status from local prompt submission through settlement.",
    create: createAgentRequestStatusSpecimen,
  }),
  execution: Object.freeze({
    id: "execution",
    title: "Execution Status",
    description: "Two-line command activity with completion and failure states.",
    create: createExecutionSpecimen,
  }),
  streaming: Object.freeze({
    id: "streaming",
    title: "Streaming Text",
    description: "Subtle moving highlight on the newest generated text.",
    create: createStreamingSpecimen,
  }),
  todos: Object.freeze({
    id: "todos",
    title: "Todo List",
    description: "Compact agent plan with one active item and explicit outcomes.",
    create: createTodoSpecimen,
  }),
});

const COMPONENT_OPTIONS = Object.freeze(Object.keys(COMPONENT_DEFINITIONS) as ComponentOption[]);

function isComponentOption(value: string): value is ComponentOption {
  return Object.hasOwn(COMPONENT_DEFINITIONS, value);
}

const requestedOption = (process.argv[2] ?? "orb").trim().toLowerCase();
if (!isComponentOption(requestedOption)) {
  process.stderr.write(
    `Unknown component lab: ${requestedOption}\nAvailable: ${COMPONENT_OPTIONS.join(", ")}\n`,
  );
  process.exitCode = 1;
} else {
  runComponentLab(COMPONENT_DEFINITIONS[requestedOption], COMPONENT_OPTIONS);
}
