import type { SelectionListItem } from "./selection-list.js";

/** All strings are display values; adapters own formatting and secret redaction. */
export interface FormWorkspaceChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface FormWorkspaceControl {
  readonly kind: "select" | "segmented" | "toggle" | "text" | "action";
  readonly value: string;
  readonly choices?: readonly FormWorkspaceChoice[];
  readonly checked?: boolean;
}

export interface FormWorkspaceField {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly control: FormWorkspaceControl;
  readonly readonly?: boolean;
  readonly pending?: boolean;
  readonly error?: string;
  readonly changed?: boolean;
  readonly badge?: string;
  readonly tone?: "success" | "accent";
  /** Button emphasis used by form action controls. */
  readonly intent?: "primary" | "danger";
}

export interface FormWorkspaceGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly FormWorkspaceField[];
}

export interface FormWorkspaceCategory {
  readonly id: string;
  readonly label: string;
}

export interface FormWorkspaceEditor {
  readonly kind: "editor";
  readonly title: string;
  readonly description?: string;
  readonly text: string;
  /** UTF-16 offset in the already-redacted display text. */
  readonly cursor: number;
  readonly error?: string;
  readonly hint: string;
}

export interface FormWorkspacePicker {
  readonly kind: "picker";
  readonly title: string;
  readonly description?: string;
  readonly options: readonly FormWorkspaceChoice[];
  readonly selectedIndex: number;
  readonly hint: string;
}

export interface FormWorkspaceConfirmation {
  readonly kind: "confirmation";
  readonly title: string;
  readonly lines: readonly string[];
  /** Put the cancel action first; the reducer owns activation and effects. */
  readonly actions: readonly { readonly id: string; readonly label: string }[];
  readonly selectedIndex: number;
  readonly hint: string;
}

/** A selectable directory or action list; the host owns navigation and activation. */
export interface FormWorkspaceDialog {
  readonly kind: "dialog";
  readonly title: string;
  readonly description?: string;
  readonly rows: readonly SelectionListItem[];
  readonly selectedIndex: number;
  readonly hint: string;
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
  readonly search?: { readonly text: string; readonly cursor: number; readonly placeholder?: string };
  readonly searchFocused?: boolean;
}

/** A compact management form; feedback stays next to the field that produced it. */
export interface FormWorkspaceForm {
  readonly kind: "form";
  readonly title: string;
  readonly groups: readonly FormWorkspaceGroup[];
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

export type FormWorkspaceModal =
  | FormWorkspaceEditor
  | FormWorkspacePicker
  | FormWorkspaceConfirmation
  | FormWorkspaceDialog
  | FormWorkspaceForm;

export interface FormWorkspaceModel {
  readonly height: number;
  readonly header?: string;
  readonly headerAction?: { readonly label: string };
  readonly categories: readonly FormWorkspaceCategory[];
  readonly activeCategoryId: string;
  readonly focus: "navigation" | "content" | "actions" | "search";
  readonly search?: { readonly text: string; readonly cursor: number };
  readonly searchHidden?: boolean;
  /** An empty list hides the action bar. */
  readonly actions: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean }[];
  readonly actionIndex?: number;
  readonly writable?: boolean;
  readonly disabledReason?: string;
  readonly groups: readonly FormWorkspaceGroup[];
  readonly selectedFieldId?: string;
  readonly dirtyCount: number;
  readonly pending?: boolean;
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
  readonly emptyMessage?: string;
  readonly help?: string;
  readonly modal?: FormWorkspaceModal;
}

export type FormWorkspaceRole =
  | "canvas" | "sidebar" | "panel" | "border" | "title" | "text" | "muted"
  | "accent" | "success" | "focus" | "control" | "selected" | "warning" | "error"
  | "disabled" | "button" | "primary";

/** Paint may add SGR colors/backgrounds, but must preserve text and cell width. */
export interface FormWorkspaceTheme {
  readonly paint: (role: FormWorkspaceRole, text: string) => string;
}

export interface FormWorkspaceCursor {
  readonly row: number;
  readonly column: number;
}

export const NEUTRAL_FORM_WORKSPACE_THEME: FormWorkspaceTheme = {
  paint: (_role, text) => text,
};
