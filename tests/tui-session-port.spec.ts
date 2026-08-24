import { describe, expect, it, vi } from 'vitest'
import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandPort,
  DshParsedCommand,
} from '../src/command/port.ts'
import type { DshInteractionPort } from '../src/interaction/port.ts'
import type { DshRuntimePort } from '../src/runtime/port.ts'
import { DshTuiSessionPort } from '../src/runtime/tui-session-port.ts'

function commandPort(overrides: Partial<DshCommandPort> = {}): DshCommandPort {
  return {
    listCommands: vi.fn((): readonly DshCommandDescriptor[] => []),
    parseCommand: vi.fn((): DshParsedCommand | undefined => undefined),
    executeCommand: vi.fn((): Promise<DshCommandExecution | undefined> => (
      Promise.resolve(undefined)
    )),
    onCommandsChanged: vi.fn(() => () => {}),
    disposeCommands: vi.fn(),
    ...overrides,
  }
}

function sessionHarness(options: {
  readonly command?: DshCommandPort
  readonly interactionDispose?: () => void
  readonly runtimeDispose?: () => Promise<void>
} = {}): {
  readonly port: DshTuiSessionPort
  readonly runtime: DshRuntimePort
  readonly interaction: DshInteractionPort
  readonly commands: DshCommandPort
} {
  const runtime = {
    sessionId: 'composed-session',
    dispose: options.runtimeDispose ?? vi.fn(async () => {}),
  } as unknown as DshRuntimePort
  const interaction = {
    disposeInteractions: options.interactionDispose ?? vi.fn(),
  } as unknown as DshInteractionPort
  const commands = options.command ?? commandPort()
  return {
    port: new DshTuiSessionPort(runtime, interaction, commands),
    runtime,
    interaction,
    commands,
  }
}

describe('composed TUI session command port', () => {
  it('delegates command operations without altering their values', async () => {
    const descriptor = Object.freeze({ name: 'inspect', description: 'Inspect' })
    const parsed = Object.freeze({ name: 'inspect', rawInput: ' x' })
    const execution = Object.freeze({
      commandId: 'command-1',
      result: Object.freeze({ kind: 'success' as const, text: 'ok' }),
    })
    const stop = vi.fn()
    const signal = new AbortController().signal
    const commands = commandPort({
      listCommands: vi.fn(() => [descriptor]),
      parseCommand: vi.fn(() => parsed),
      executeCommand: vi.fn(() => Promise.resolve(execution)),
      onCommandsChanged: vi.fn(() => stop),
    })
    const { port } = sessionHarness({ command: commands })
    const listener = vi.fn()

    expect(port.listCommands()).toEqual([descriptor])
    expect(port.parseCommand('/inspect x')).toBe(parsed)
    await expect(port.executeCommand('/inspect x', signal)).resolves.toBe(execution)
    expect(port.onCommandsChanged(listener)).toBe(stop)
    port.disposeCommands()

    expect(commands.listCommands).toHaveBeenCalledOnce()
    expect(commands.parseCommand).toHaveBeenCalledExactlyOnceWith('/inspect x')
    expect(commands.executeCommand).toHaveBeenCalledExactlyOnceWith('/inspect x', signal)
    expect(commands.onCommandsChanged).toHaveBeenCalledExactlyOnceWith(listener)
    expect(commands.disposeCommands).toHaveBeenCalledOnce()
  })

  it('releases command, interaction, and runtime once on success', async () => {
    const commands = commandPort()
    const interactionDispose = vi.fn()
    const runtimeDispose = vi.fn(async () => {})
    const { port } = sessionHarness({
      command: commands,
      interactionDispose,
      runtimeDispose,
    })

    const first = port.dispose()
    const second = port.dispose()
    expect(second).toBe(first)
    await first

    expect(commands.disposeCommands).toHaveBeenCalledOnce()
    expect(interactionDispose).toHaveBeenCalledOnce()
    expect(runtimeDispose).toHaveBeenCalledOnce()
  })

  it('attempts every owner cleanup and preserves all disposal failures', async () => {
    const commandFailure = new Error('command cleanup failed')
    const interactionFailure = new Error('interaction cleanup failed')
    const runtimeFailure = new Error('runtime cleanup failed')
    const commands = commandPort({
      disposeCommands: vi.fn(() => { throw commandFailure }),
    })
    const interactionDispose = vi.fn(() => { throw interactionFailure })
    const runtimeDispose = vi.fn(() => Promise.reject(runtimeFailure))
    const { port } = sessionHarness({
      command: commands,
      interactionDispose,
      runtimeDispose,
    })

    const disposal = port.dispose()
    await expect(disposal).rejects.toMatchObject({
      errors: [commandFailure, interactionFailure, runtimeFailure],
    })
    expect(port.dispose()).toBe(disposal)
    expect(commands.disposeCommands).toHaveBeenCalledOnce()
    expect(interactionDispose).toHaveBeenCalledOnce()
    expect(runtimeDispose).toHaveBeenCalledOnce()
  })
})
