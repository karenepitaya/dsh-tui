/** All strings are display values; adapters own formatting and secret redaction. */
export interface SettingsWorkspaceChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SettingsWorkspaceControl {
  readonly kind: "select" | "segmented" | "toggle" | "text" | "action";
  readonly value: string;
  readonly choices?: readonly SettingsWorkspaceChoice[];
  readonly checked?: boolean;
}

export interface SettingsWorkspaceField {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly control: SettingsWorkspaceControl;
  readonly readonly?: boolean;
  readonly pending?: boolean;
  readonly error?: string;
  readonly changed?: boolean;
  readonly badge?: string;
  readonly tone?: "success" | "accent";
  /** Button emphasis used by form action controls. */
  readonly intent?: "primary" | "danger";
}

export interface SettingsWorkspaceGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly SettingsWorkspaceField[];
}

export interface SettingsWorkspaceCategory {
  readonly id: string;
  readonly label: string;
}

export interface SettingsWorkspaceEditor {
  readonly kind: "editor";
  readonly title: string;
  readonly description?: string;
  readonly text: string;
  /** UTF-16 offset in the already-redacted display text. */
  readonly cursor: number;
  readonly error?: string;
  readonly hint?: string;
}

export interface SettingsWorkspacePicker {
  readonly kind: "picker";
  readonly title: string;
  readonly description?: string;
  readonly options: readonly SettingsWorkspaceChoice[];
  readonly selectedIndex: number;
  readonly hint?: string;
}

export interface SettingsWorkspaceConfirmation {
  readonly kind: "confirmation";
  readonly title: string;
  readonly lines: readonly string[];
  /** Put the cancel action first; the reducer owns activation and effects. */
  readonly actions: readonly { readonly id: string; readonly label: string }[];
  readonly selectedIndex: number;
  readonly hint?: string;
}

/** A selectable directory or action list; the host owns navigation and activation. */
export interface SettingsWorkspaceDialog {
  readonly kind: "dialog";
  readonly title: string;
  readonly description?: string;
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly value?: string;
    readonly description?: string;
    readonly disabled?: boolean;
    /** Consecutive rows share a non-selectable heading; does not affect selectedIndex. */
    readonly group?: string;
    readonly badge?: string;
    readonly tone?: "success" | "accent";
  }[];
  readonly selectedIndex: number;
  readonly hint: string;
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
  readonly search?: { readonly text: string; readonly cursor: number; readonly placeholder?: string };
  readonly searchFocused?: boolean;
}

/** A compact management form; feedback stays next to the field that produced it. */
export interface SettingsWorkspaceForm {
  readonly kind: "form";
  readonly title: string;
  readonly groups: readonly SettingsWorkspaceGroup[];
  readonly selectedFieldId?: string;
  readonly hint: string;
  readonly pending?: boolean;
  readonly feedback?: {
    readonly afterFieldId: string;
    readonly tone: "success" | "error" | "warning" | "accent";
    readonly title: string;
    readonly detail?: string;
  };
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
}

export type SettingsWorkspaceModal =
  | SettingsWorkspaceEditor
  | SettingsWorkspacePicker
  | SettingsWorkspaceConfirmation
  | SettingsWorkspaceDialog
  | SettingsWorkspaceForm;

export interface SettingsWorkspaceModel {
  readonly height: number;
  readonly header?: string;
  readonly headerAction?: { readonly label: string };
  readonly title: string;
  readonly subtitle?: string;
  readonly scope?: string;
  readonly categories: readonly SettingsWorkspaceCategory[];
  readonly activeCategoryId: string;
  readonly focus: "navigation" | "content" | "actions" | "search";
  readonly search?: { readonly text: string; readonly cursor: number };
  readonly searchHidden?: boolean;
  /** Omit to show save/cancel/reset; an empty list hides the action bar. */
  readonly actions?: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean }[];
  readonly actionIndex?: number;
  readonly writable?: boolean;
  readonly disabledReason?: string;
  readonly groups: readonly SettingsWorkspaceGroup[];
  readonly selectedFieldId?: string;
  readonly dirtyCount: number;
  readonly pending?: boolean;
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
  readonly emptyMessage?: string;
  readonly help?: string;
  readonly modal?: SettingsWorkspaceModal;
}

export type SettingsWorkspaceRole =
  | "canvas" | "sidebar" | "panel" | "border" | "title" | "text" | "muted"
  | "accent" | "success" | "focus" | "control" | "selected" | "warning" | "error"
  | "disabled" | "button" | "primary";

/** Paint may add SGR colors/backgrounds, but must preserve text and cell width. */
export interface SettingsWorkspaceTheme {
  readonly paint: (role: SettingsWorkspaceRole, text: string) => string;
}

export interface SettingsWorkspaceCursor {
  readonly row: number;
  readonly column: number;
}

export const NEUTRAL_SETTINGS_WORKSPACE_THEME: SettingsWorkspaceTheme = {
  paint: (_role, text) => text,
};
