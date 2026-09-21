import { FormWorkspace, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import {
  catalogRowStatus,
  localCreatedAt,
  projectSessionDetails,
  projectSessionsCatalog,
  sessionLabel,
  type SessionsFeatureState,
  type SessionsFeatureStateSource,
  type SessionsNavigatorNode,
} from '../features/sessions/index.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'

export interface SessionsFrameOptions {
  readonly uiLanguage?: string
  /** Navigation insert mode: the search box owns focus and the cursor. */
  readonly searching?: boolean
  readonly deferLayout?: boolean
}

/** The Feature-owned state source rides its navigator-region node, the same seam the host's detail scroller uses. */
export function sessionsStateSource(
  snapshot: FeatureSurfaceRuntimeSnapshot,
): SessionsFeatureStateSource | undefined {
  const contribution = snapshot.host.slots.contributions.find(candidate => (
    candidate.featureId === 'sessions' && candidate.value.role === 'navigator'
  ))
  const node = contribution?.value.node as SessionsNavigatorNode | null | undefined
  return node?.kind === 'sessions.navigator' ? node.state : undefined
}

function operationMessage(state: SessionsFeatureState): { text: string; tone: 'warning' | 'error' } | undefined {
  const operation = state.operation
  if (operation.phase === 'running') {
    const action = operation.action === 'fork'
      ? 'Forking'
      : operation.action === 'resume-cold' ? 'Resuming' : 'Switching'
    return { text: `${action} ${operation.sessionId}… · Esc cancels the request`, tone: 'warning' }
  }
  if (operation.phase === 'failed') {
    return { text: `${operation.action} failed · ${operation.message}`, tone: 'error' }
  }
  return undefined
}

function emptyMessage(state: SessionsFeatureState): string {
  if (state.catalog.phase === 'failed') return `Catalog unavailable · ${state.catalog.message}`
  if (state.query.length > 0) return 'No sessions match this query'
  if (state.catalog.phase === 'loading') return 'Loading session catalog…'
  return 'No sessions yet'
}

function statusMessage(state: SessionsFeatureState): { text: string; tone: 'error' | 'warning' | 'muted' } | undefined {
  const operation = operationMessage(state)
  if (operation !== undefined) return operation
  if (state.navigation.busy) {
    return { text: 'Wait for the current session operation', tone: 'muted' }
  }
  if (state.catalog.phase === 'failed') {
    return { text: `Refresh failed · ${state.catalog.message}`, tone: 'error' }
  }
  const catalog = projectSessionsCatalog(state)
  const selected = catalog.rows[catalog.selectedIndex]
  if (selected?.titleUnavailable === true) {
    return { text: 'Title unavailable · R refresh', tone: 'warning' }
  }
  if (state.query.length > 0) {
    return { text: `${catalog.filteredCount}/${catalog.totalCount} matching`, tone: 'muted' }
  }
  if (state.catalog.phase === 'refreshing') {
    return { text: 'Refreshing session catalog…', tone: 'muted' }
  }
  return undefined
}

/** DSH-owned copy stops here; Orbs owns the list, search box, detail modal and confirmation layout. */
export function sessionsFormModel(
  state: SessionsFeatureState,
  viewport: TerminalViewport,
  options: SessionsFrameOptions = {},
): FormWorkspaceModel {
  const catalog = projectSessionsCatalog(state)
  const strings = formWorkspaceStrings(options.uiLanguage)
  const operation = state.operation
  const message = statusMessage(state)
  const details = state.details === undefined ? undefined : projectSessionDetails(state)
  const detailField = details === undefined || state.details === undefined
    ? undefined
    : details.fields[Math.max(0, Math.min(details.fields.length - 1, state.details.fieldIndex))]
  const confirmingRow = operation.phase === 'confirm-resume' || operation.phase === 'confirm-fork'
    ? catalog.rows.find(row => row.sessionId === operation.sessionId)
    : undefined
  const modal: FormWorkspaceModel['modal'] = operation.phase === 'confirm-resume' || operation.phase === 'confirm-fork'
    ? {
        kind: 'confirmation',
        title: operation.phase === 'confirm-resume'
          ? `Resume cold session ${operation.sessionId}?`
          : `Fork session ${operation.sessionId}?`,
        lines: confirmingRow === undefined
          ? [operation.sessionId]
          : [`${sessionLabel(confirmingRow)} · ${catalogRowStatus(confirmingRow)}`],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'confirm', label: operation.phase === 'confirm-resume' ? 'Resume' : 'Fork' },
        ],
        selectedIndex: 1,
        hint: 'Enter confirm · Esc / q cancel',
      }
    : details === undefined
      ? undefined
      : {
          kind: 'form' as const,
          title: details.title,
          groups: [{
            id: 'details',
            title: details.title,
            fields: details.fields.map(entry => ({
              id: entry.id,
              label: entry.label,
              control: { kind: 'text' as const, value: entry.value },
              readonly: true,
            })),
          }],
          ...(detailField === undefined ? {} : { selectedFieldId: detailField.id }),
          hint: '↑↓ move · Enter / Esc / q close · r refresh',
          ...(details.message === undefined ? {} : { message: details.message, messageTone: details.messageTone }),
        }
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Sessions',
    categories: [{ id: 'sessions', label: `Sessions ${catalog.totalCount}` }],
    activeCategoryId: 'sessions',
    focus: options.searching === true ? 'search' : 'content',
    search: { text: state.query, cursor: state.query.length },
    searchHidden: false,
    actions: [],
    groups: [],
    dirtyCount: 0,
    body: {
      kind: 'list',
      items: catalog.rows.map(row => ({
        id: row.sessionId,
        label: sessionLabel(row),
        value: localCreatedAt(row.createdAt),
        badge: catalogRowStatus(row),
        ...(row.liveStatus === 'running'
          ? { tone: 'success' as const }
          : row.relation === 'current'
            ? { tone: 'accent' as const }
            : {}),
        description: row.cwd ?? 'No working directory',
      })),
      selectedIndex: Math.max(0, catalog.selectedIndex),
      emptyMessage: emptyMessage(state),
    },
    ...(message === undefined ? {} : { message: message.text, messageTone: message.tone }),
    help: '↑↓ select · Enter details · a resume · f fork · / search · r refresh · q back',
    ...(strings === undefined ? {} : { strings }),
    ...(modal === undefined ? {} : { modal }),
  }
}

/** Mirrors the settings dual path: retained drivers consume the model, snapshots use plain lines. */
export function renderSessionsFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  options: SessionsFrameOptions = {},
): UiFrame | undefined {
  const source = sessionsStateSource(snapshot)
  if (source === undefined) return undefined
  const bounded = {
    columns: Math.max(1, Math.floor(viewport.columns)),
    rows: Math.max(1, Math.floor(viewport.rows)),
  }
  const model = sessionsFormModel(source.snapshot(), bounded, {
    ...options,
    searching: options.searching ?? snapshot.host.navigation.mode === 'insert',
  })
  if (options.deferLayout === true) {
    return { title: 'Sessions', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Sessions',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}
