import { describe, expect, it, vi } from 'vitest'
import {
  installProcessTerminationHandlers,
  type ProcessTerminationEventSource,
} from '../src/lifecycle/process-termination.ts'

class FakeProcessEvents implements ProcessTerminationEventSource {
  private readonly listeners = new Map<string, Set<() => void>>()

  on(event: 'SIGHUP' | 'SIGBREAK' | 'exit', listener: () => void): this {
    const bucket = this.listeners.get(event) ?? new Set()
    bucket.add(listener)
    this.listeners.set(event, bucket)
    return this
  }

  removeListener(event: 'SIGHUP' | 'SIGBREAK' | 'exit', listener: () => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: 'SIGHUP' | 'SIGBREAK' | 'exit'): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }
}

describe('process termination bridge', () => {
  it('routes window-close and Ctrl+Break through safe shutdown and restores on process exit', () => {
    const source = new FakeProcessEvents()
    const target = {
      requestSignalExit: vi.fn(),
      restoreTerminalNow: vi.fn(),
    }
    const uninstall = installProcessTerminationHandlers(source, target)

    source.emit('SIGHUP')
    source.emit('SIGBREAK')
    source.emit('exit')
    expect(target.requestSignalExit).toHaveBeenCalledTimes(2)
    expect(target.restoreTerminalNow).toHaveBeenCalledOnce()

    uninstall()
    uninstall()
    source.emit('SIGHUP')
    source.emit('exit')
    expect(target.requestSignalExit).toHaveBeenCalledTimes(2)
    expect(target.restoreTerminalNow).toHaveBeenCalledOnce()
  })
})
