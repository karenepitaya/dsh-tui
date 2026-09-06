import { Key, matchesKey } from '@earendil-works/pi-tui'

export type TerminalInputAction =
  | { readonly type: 'insert'; readonly text: string; readonly paste?: true }
  | { readonly type: 'newline' }
  | { readonly type: 'submit' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'save-default' }
  | { readonly type: 'paste-image' }
  | { readonly type: 'toggle-reasoning' }
  | { readonly type: 'toggle-transcript-details' }
  | { readonly type: 'toggle-goal-actions' }
  | { readonly type: 'toggle-activity' }
  | { readonly type: 'backspace' }
  | { readonly type: 'delete' }
  | { readonly type: 'move-left' }
  | { readonly type: 'move-right' }
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'page-up' }
  | { readonly type: 'page-down' }
  | { readonly type: 'complete'; readonly reverse?: true }
  | { readonly type: 'move-home' }
  | { readonly type: 'move-end' }
  | { readonly type: 'escape' }
  | { readonly type: 'ignored' }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/u

/** Decode one complete sequence emitted by the terminal input buffer. */
export function decodeTerminalInput(data: string): TerminalInputAction {
  if (data === '') return { type: 'ignored' }
  if (data.startsWith(PASTE_START)) {
    if (!data.endsWith(PASTE_END)) return { type: 'ignored' }
    return {
      type: 'insert',
      text: data.slice(PASTE_START.length, -PASTE_END.length),
      paste: true,
    }
  }

  if (matchesKey(data, Key.ctrl('c'))) return { type: 'interrupt' }
  if (matchesKey(data, Key.ctrl('s'))) return { type: 'save-default' }
  if (matchesKey(data, Key.ctrl('v'))) return { type: 'paste-image' }
  if (matchesKey(data, Key.ctrl('t'))) return { type: 'toggle-reasoning' }
  if (matchesKey(data, Key.ctrl('o'))) return { type: 'toggle-transcript-details' }
  if (matchesKey(data, Key.ctrl('g'))) return { type: 'toggle-goal-actions' }
  if (matchesKey(data, Key.ctrl('b'))) return { type: 'toggle-activity' }
  if (data !== '\n' && matchesKey(data, Key.ctrl('j'))) return { type: 'newline' }
  if (matchesKey(data, Key.shift(Key.enter))) return { type: 'newline' }
  if (matchesKey(data, Key.enter)) return { type: 'submit' }
  if (matchesKey(data, Key.backspace)) return { type: 'backspace' }
  if (matchesKey(data, Key.delete)) return { type: 'delete' }
  if (matchesKey(data, Key.left)) return { type: 'move-left' }
  if (matchesKey(data, Key.right)) return { type: 'move-right' }
  if (matchesKey(data, Key.up)) return { type: 'move-up' }
  if (matchesKey(data, Key.down)) return { type: 'move-down' }
  if (matchesKey(data, Key.pageUp)) return { type: 'page-up' }
  if (matchesKey(data, Key.pageDown)) return { type: 'page-down' }
  if (matchesKey(data, Key.shift(Key.tab))) return { type: 'complete', reverse: true }
  if (matchesKey(data, Key.tab)) return { type: 'complete' }
  if (matchesKey(data, Key.home)) return { type: 'move-home' }
  if (matchesKey(data, Key.end)) return { type: 'move-end' }
  if (matchesKey(data, Key.escape)) return { type: 'escape' }

  return PRINTABLE.test(data)
    ? { type: 'insert', text: data }
    : { type: 'ignored' }
}
