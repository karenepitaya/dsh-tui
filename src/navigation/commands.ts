import {
  routeFeatureId,
  type NavigationMode,
  type NavigationState,
} from './state.ts'

export type Direction = 'left' | 'right' | 'up' | 'down'

export type TerminalKey =
  | {
      readonly type: 'text'
      readonly text: string
      readonly ctrl?: true
      readonly alt?: true
      readonly shift?: true
    }
  | { readonly type: 'paste'; readonly text: string }
  | {
      readonly type: 'named'
      readonly key:
        | 'enter'
        | 'escape'
        | 'backspace'
        | 'delete'
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        | 'home'
        | 'end'
        | 'tab'
        | 'page-up'
        | 'page-down'
      readonly ctrl?: true
      readonly alt?: true
      readonly shift?: true
    }

export type UiCommand =
  | { readonly type: 'app.interrupt' }
  | { readonly type: 'transcript.toggle-details' }
  | { readonly type: 'mode.set'; readonly mode: NavigationMode }
  | { readonly type: 'feature.command'; readonly commandId: string }
  | { readonly type: 'edit.insert'; readonly text: string }
  | { readonly type: 'edit.newline' }
  | { readonly type: 'edit.delete-backward' }
  | { readonly type: 'edit.delete-forward' }
  | { readonly type: 'edit.complete'; readonly reverse?: true }
  | { readonly type: 'edit.move'; readonly direction: Direction }
  | { readonly type: 'edit.move-boundary'; readonly boundary: 'start' | 'end' }
  | { readonly type: 'action.submit' }
  | { readonly type: 'navigation.move'; readonly direction: Direction }
  | { readonly type: 'navigation.page'; readonly direction: 'up' | 'down' }
  | { readonly type: 'navigation.activate' }
  | { readonly type: 'navigation.back' }
  | { readonly type: 'navigation.focus'; readonly direction: 'previous' | 'next' }

export interface KeymapContext {
  readonly navigation: NavigationState
}

export type UiCommandTarget =
  | { readonly kind: 'shell' }
  | { readonly kind: 'composer' }
  | { readonly kind: 'feature'; readonly featureId: string }
  | {
      readonly kind: 'overlay'
      readonly overlayId: string
      readonly featureId: string
    }

export interface RoutedUiCommand {
  readonly target: UiCommandTarget
  readonly command: UiCommand
}

function command<T extends UiCommand>(value: T): T {
  return Object.freeze(value)
}

function mapTextKey(key: Extract<TerminalKey, { type: 'text' }>, mode: NavigationMode): UiCommand | undefined {
  if (key.ctrl === true) {
    const lower = key.text.toLowerCase()
    if (lower === 'c') return command({ type: 'app.interrupt' })
    if (lower === 'o') return command({ type: 'transcript.toggle-details' })
    return undefined
  }
  if (key.alt === true) return undefined
  if (mode === 'insert') return command({ type: 'edit.insert', text: key.text })
  switch (key.text) {
    case 'h': return command({ type: 'navigation.move', direction: 'left' })
    case 'j': return command({ type: 'navigation.move', direction: 'down' })
    case 'k': return command({ type: 'navigation.move', direction: 'up' })
    case 'l': return command({ type: 'navigation.move', direction: 'right' })
    case 'i': return command({ type: 'mode.set', mode: 'insert' })
    default: return undefined
  }
}

function mapNamedInsertKey(
  key: Extract<TerminalKey, { type: 'named' }>,
): UiCommand | undefined {
  switch (key.key) {
    case 'enter':
      return key.shift === true
        ? command({ type: 'edit.newline' })
        : command({ type: 'action.submit' })
    case 'escape': return command({ type: 'mode.set', mode: 'normal' })
    case 'backspace': return command({ type: 'edit.delete-backward' })
    case 'delete': return command({ type: 'edit.delete-forward' })
    case 'left': return command({ type: 'edit.move', direction: 'left' })
    case 'right': return command({ type: 'edit.move', direction: 'right' })
    case 'up': return command({ type: 'edit.move', direction: 'up' })
    case 'down': return command({ type: 'edit.move', direction: 'down' })
    case 'home': return command({ type: 'edit.move-boundary', boundary: 'start' })
    case 'end': return command({ type: 'edit.move-boundary', boundary: 'end' })
    case 'tab':
      return key.shift === true
        ? command({ type: 'edit.complete', reverse: true })
        : command({ type: 'edit.complete' })
    case 'page-up': return command({ type: 'navigation.page', direction: 'up' })
    case 'page-down': return command({ type: 'navigation.page', direction: 'down' })
  }
}

function mapNamedNormalKey(
  key: Extract<TerminalKey, { type: 'named' }>,
): UiCommand | undefined {
  switch (key.key) {
    case 'left': return command({ type: 'navigation.move', direction: 'left' })
    case 'right': return command({ type: 'navigation.move', direction: 'right' })
    case 'up': return command({ type: 'navigation.move', direction: 'up' })
    case 'down': return command({ type: 'navigation.move', direction: 'down' })
    case 'page-up': return command({ type: 'navigation.page', direction: 'up' })
    case 'page-down': return command({ type: 'navigation.page', direction: 'down' })
    case 'enter': return command({ type: 'navigation.activate' })
    case 'escape': return command({ type: 'navigation.back' })
    case 'backspace':
    case 'delete':
    case 'home':
    case 'end':
    case 'tab':
      return undefined
  }
}

export function mapTerminalKey(
  key: TerminalKey,
  context: KeymapContext,
): UiCommand | undefined {
  const navigation = context.navigation
  if (navigation.overlays.length === 0 && navigation.route.kind !== 'chat') {
    if (key.type === 'named' && key.ctrl !== true && key.alt !== true) {
      if (key.key === 'escape') {
        return command({ type: 'navigation.back' })
      }
      if (key.key === 'tab') {
        return command({ type: 'navigation.focus', direction: key.shift ? 'previous' : 'next' })
      }
      if (key.key === 'enter' && key.shift !== true
        && navigation.route.kind === 'workspace' && navigation.mode === 'insert') {
        return command({ type: 'mode.set', mode: 'normal' })
      }
    }
    if (key.type === 'text' && key.ctrl !== true && key.alt !== true
      && navigation.mode === 'normal' && navigation.route.kind === 'workspace') {
      if (key.text === '/') return command({ type: 'mode.set', mode: 'insert' })
      if (key.text === 'h' || key.text === 'l') {
        return command({ type: 'navigation.focus', direction: key.text === 'h' ? 'previous' : 'next' })
      }
    }
  }
  switch (key.type) {
    case 'text':
      return mapTextKey(key, context.navigation.mode)
    case 'paste':
      return context.navigation.mode === 'insert'
        ? command({ type: 'edit.insert', text: key.text })
        : undefined
    case 'named':
      if (key.ctrl === true || key.alt === true) return undefined
      return context.navigation.mode === 'insert'
        ? mapNamedInsertKey(key)
        : mapNamedNormalKey(key)
  }
}

function isShellCommand(value: UiCommand): boolean {
  return value.type === 'app.interrupt'
    || value.type === 'transcript.toggle-details'
    || value.type === 'mode.set'
    || value.type === 'navigation.focus'
}

function isEditingCommand(value: UiCommand): boolean {
  return value.type.startsWith('edit.') || value.type === 'action.submit'
}

function freezeTarget(target: UiCommandTarget): UiCommandTarget {
  return Object.freeze(target)
}

export function routeUiCommand(
  navigation: NavigationState,
  value: UiCommand,
): RoutedUiCommand {
  let target: UiCommandTarget
  if (isShellCommand(value)) {
    target = freezeTarget({ kind: 'shell' })
  } else {
    const overlay = navigation.overlays.at(-1)
    if (overlay !== undefined) {
      target = freezeTarget({
        kind: 'overlay',
        overlayId: overlay.id,
        featureId: overlay.featureId,
      })
    } else if (isEditingCommand(value) && navigation.focus.kind === 'composer') {
      target = freezeTarget({ kind: 'composer' })
    } else {
      target = freezeTarget({
        kind: 'feature',
        featureId: routeFeatureId(navigation.route),
      })
    }
  }
  return Object.freeze({ target, command: value })
}
