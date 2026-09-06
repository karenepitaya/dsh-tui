import type { DshTuiNavigationKeys } from '../preferences/contracts.ts'
import type { TerminalKey } from './commands.ts'
import type { NavigationMode } from './state.ts'

/** Navigation policy never consumes normal typing in Insert mode. */
export function acceptsNavigationKey(
  key: TerminalKey,
  mode: NavigationMode,
  preference: DshTuiNavigationKeys,
): boolean {
  if (mode === 'insert' || preference === 'both' || key.type === 'paste' || key.ctrl || key.alt || key.shift) return true
  if (preference === 'arrows') return key.type !== 'text' || !['h', 'j', 'k', 'l'].includes(key.text)
  return key.type !== 'named' || !['left', 'right', 'up', 'down'].includes(key.key)
}
