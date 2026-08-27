export type ProcessTerminationEvent = 'SIGHUP' | 'SIGBREAK' | 'exit'

export interface ProcessTerminationEventSource {
  on(event: ProcessTerminationEvent, listener: () => void): unknown
  removeListener(event: ProcessTerminationEvent, listener: () => void): unknown
}

export interface ProcessTerminationTarget {
  /** First signal begins graceful shutdown; a repeated signal requests the forced path. */
  requestSignalExit(): void
  /** Process exit callbacks are synchronous, so only terminal recovery is attempted here. */
  restoreTerminalNow(): void
}

/**
 * Bridge host-level terminal termination into the product lifecycle.
 * Node emits SIGHUP when a Windows console window closes and SIGBREAK for Ctrl+Break.
 */
export function installProcessTerminationHandlers(
  source: ProcessTerminationEventSource,
  target: ProcessTerminationTarget,
): () => void {
  const signal = (): void => { target.requestSignalExit() }
  const exit = (): void => { target.restoreTerminalNow() }
  source.on('SIGHUP', signal)
  source.on('SIGBREAK', signal)
  source.on('exit', exit)
  let installed = true
  return () => {
    if (!installed) return
    installed = false
    source.removeListener('SIGHUP', signal)
    source.removeListener('SIGBREAK', signal)
    source.removeListener('exit', exit)
  }
}
