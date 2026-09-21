import type { ControlRole } from "./control-presentation.js";
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

/** A bounded scrolling list as the category body, replacing groups/fields. */
export interface FormWorkspaceListBody {
  readonly kind: "list";
  readonly items: readonly SelectionListItem[];
  readonly selectedIndex: number;
  /** Falls back to model.emptyMessage when the list is empty. */
  readonly emptyMessage?: string;
  /** Overrides the default disabled-row suffix for this list. */
  readonly disabledLabel?: string;
}

/** Display strings; every key defaults to the English built-in wording. */
export interface FormWorkspaceStrings {
  readonly pendingLabel?: string;
  readonly readonlyLabel?: string;
  readonly unsavedLabel?: (count: number) => string;
  readonly expandLabel?: string;
  readonly defaultHeaderAction?: string;
  readonly confirmationTooSmall?: string;
  readonly cancelLabel?: string;
  readonly cancelHint?: string;
  readonly searchPlaceholder?: string;
}

/** Chinese display strings; omitting `strings` entirely selects the English built-ins. */
export const FORM_WORKSPACE_STRINGS_ZH: FormWorkspaceStrings = {
  pendingLabel: "处理中",
  readonlyLabel: "只读",
  unsavedLabel: (count) => `${count} 项未保存`,
  expandLabel: "… 放大查看",
  defaultHeaderAction: "q / Esc 返回",
  confirmationTooSmall: "请放大终端以阅读完整确认内容",
  cancelLabel: "取消",
  cancelHint: "Esc / q 取消",
  searchPlaceholder: "搜索…",
};

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
  /** When set, the content area renders this list instead of `groups`. */
  readonly body?: FormWorkspaceListBody;
  /** Display strings; absent keys keep the English built-in wording. */
  readonly strings?: FormWorkspaceStrings;
  readonly selectedFieldId?: string;
  readonly dirtyCount: number;
  readonly pending?: boolean;
  readonly message?: string;
  readonly messageTone?: "error" | "warning" | "muted";
  readonly emptyMessage?: string;
  readonly help?: string;
  readonly modal?: FormWorkspaceModal;
}

/** Surface-level roles layered on top of the shared control roles. */
export type FormWorkspaceSurfaceRole = "canvas" | "sidebar" | "panel" | "border" | "title" | "control" | "warning";
export type FormWorkspaceRole = ControlRole | FormWorkspaceSurfaceRole;

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
