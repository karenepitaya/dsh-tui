import {
  type Component,
  Key,
  matchesKey,
  ProcessTerminal,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import {
  FormWorkspace,
  FORM_WORKSPACE_STRINGS_ZH,
  type FormWorkspaceField,
  type FormWorkspaceModel,
  type FormWorkspaceRole,
  type FormWorkspaceTheme,
  type SelectionListItem,
} from "../src/index.js";

type CategoryId = "general" | "plugins" | "danger";

const ROLE_SGR: Partial<Record<FormWorkspaceRole, string>> = {
  title: "\x1b[1m",
  muted: "\x1b[2m",
  border: "\x1b[2m",
  accent: "\x1b[36m",
  selected: "\x1b[36m",
  focus: "\x1b[7m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  primary: "\x1b[34m",
  disabled: "\x1b[2m",
};
const THEME: FormWorkspaceTheme = {
  paint: (role, text) => ROLE_SGR[role] ? `${ROLE_SGR[role]}${text}\x1b[0m` : text,
};

const PLUGIN_ROWS: readonly SelectionListItem[] = Array.from({ length: 64 }, (_, index) => ({
  id: `plugin-${index}`,
  label: `Plugin ${String(index + 1).padStart(2, "0")}`,
  value: index % 7 === 0 ? "update available" : "enabled",
  description: `Third-party extension number ${index + 1}`,
  group: `Group ${String.fromCharCode(65 + Math.floor(index / 16))}`,
  disabled: index % 9 === 8,
}));

const GENERAL_FIELDS: readonly FormWorkspaceField[] = [
  { id: "theme", label: "Theme", description: "Terminal color scheme", control: {
    kind: "select", value: "auto", choices: [
      { value: "auto", label: "Auto" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" },
    ],
  } },
  { id: "density", label: "Density", description: "Spacing between sections", control: {
    kind: "segmented", value: "relaxed", choices: [
      { value: "compact", label: "Compact" }, { value: "relaxed", label: "Relaxed" },
    ],
  } },
  { id: "motion", label: "Reduce motion", description: "Calmer transitions", control: { kind: "toggle", value: "On", checked: true } },
  { id: "telemetry", label: "Telemetry", readonly: true, control: { kind: "toggle", value: "Off", checked: false } },
];

class FormLab implements Component {
  #categoryIndex = 0;
  #fieldId = "theme";
  #pluginIndex = 0;
  #motion = true;
  #dirty = 0;
  #chinese = false;
  #message: string | undefined;
  #modal: FormWorkspaceModel["modal"];
  #confirmationIndex = 0;

  invalidate(): void {}

  get modalOpen(): boolean { return this.#modal !== undefined; }

  #categories(): FormWorkspaceModel["categories"] {
    return [
      { id: "general", label: "General" },
      { id: "plugins", label: "Plugins" },
      { id: "danger", label: "Danger" },
    ];
  }

  #category(): CategoryId {
    return this.#categories()[this.#categoryIndex]!.id as CategoryId;
  }

  #model(): FormWorkspaceModel {
    const category = this.#category();
    const height = Math.max(8, (process.stdout.rows ?? 24) - 1);
    const base = {
      height,
      header: "Form Lab",
      categories: this.#categories(),
      activeCategoryId: category,
      focus: "content" as const,
      ...(this.#chinese ? { strings: FORM_WORKSPACE_STRINGS_ZH } : {}),
      actions: [{ id: "save", label: "Save" }, { id: "reset", label: "Reset" }],
      dirtyCount: this.#dirty,
      groups: [],
      help: "Tab category  ↑↓ select  Enter edit  x confirm  l 中文/English  q quit",
      ...(this.#message ? { message: this.#message, messageTone: "muted" as const } : {}),
      ...(this.#modal ? { modal: this.#modal } : {}),
    };
    if (category === "plugins") {
      return { ...base, groups: [], body: { kind: "list", items: PLUGIN_ROWS, selectedIndex: this.#pluginIndex, disabledLabel: "incompatible" } };
    }
    if (category === "danger") {
      return { ...base, groups: [{ id: "danger", title: "Danger zone", fields: [
        { id: "reset", label: "Reset workspace", description: "Restore every setting to its default", intent: "danger", control: { kind: "action", value: "Reset…" } },
      ] }], selectedFieldId: "reset" };
    }
    return { ...base, selectedFieldId: this.#fieldId, groups: [{ id: "appearance", title: "Appearance", fields: GENERAL_FIELDS.map((field) =>
      field.id === "motion" ? { ...field, control: { kind: "toggle", value: this.#motion ? "On" : "Off", checked: this.#motion } } : field) }] };
  }

  render(width: number): string[] {
    return new FormWorkspace(this.#model(), THEME).render(width);
  }

  handleInput(data: string): boolean {
    if (this.#modal?.kind === "confirmation") {
      if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") this.#modal = undefined;
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) this.#confirmationIndex = this.#confirmationIndex === 0 ? 1 : 0;
      else if (matchesKey(data, Key.enter)) {
        if (this.#confirmationIndex === 1) { this.#dirty = 0; this.#message = "Workspace reset to defaults"; }
        this.#modal = undefined;
      } else return false;
      return true;
    }
    const category = this.#category();
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const step = matchesKey(data, Key.left) ? -1 : 1;
      this.#categoryIndex = (this.#categoryIndex + step + 3) % 3;
      this.#message = undefined;
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.up) ? -1 : 1;
      if (category === "plugins") this.#pluginIndex = Math.max(0, Math.min(PLUGIN_ROWS.length - 1, this.#pluginIndex + step));
      else if (category === "general") {
        const index = GENERAL_FIELDS.findIndex((field) => field.id === this.#fieldId);
        this.#fieldId = GENERAL_FIELDS[Math.max(0, Math.min(GENERAL_FIELDS.length - 1, index + step))]!.id;
      }
    } else if (matchesKey(data, Key.enter)) {
      if (category === "general" && this.#fieldId === "motion") { this.#motion = !this.#motion; this.#dirty++; }
      else if (category === "danger") this.#openConfirmation();
      else return false;
    } else if (data.toLowerCase() === "l") this.#chinese = !this.#chinese;
    else if (data.toLowerCase() === "x") this.#openConfirmation();
    else return false;
    return true;
  }

  #openConfirmation(): void {
    this.#confirmationIndex = 0;
    this.#modal = {
      kind: "confirmation",
      title: "Reset workspace",
      lines: [
        "This restores every setting in the workspace to its factory default.",
        "Installed plugins stay on disk but are disabled until re-enabled.",
      ],
      actions: [{ id: "cancel", label: "Cancel" }, { id: "confirm", label: "Reset everything" }],
      selectedIndex: 0,
      hint: "←→ choose   Enter confirm   Esc / q to cancel",
    };
  }
}

const tui = new TuiAltScreen(new ProcessTerminal());
const lab = new FormLab();
let stopped = false;

function stop(): void {
  if (stopped) return;
  stopped = true;
  tui.stop({ preserveScreen: true });
}

tui.addChild(lab);
tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c")) || (data.toLowerCase() === "q" && !lab.modalOpen)) {
    stop();
    return { consume: true };
  }
  if (lab.handleInput(data)) return { consume: true };
  return;
});

process.once("SIGINT", stop);
tui.start();
