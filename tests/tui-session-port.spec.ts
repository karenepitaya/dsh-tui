import { describe, expect, it, vi } from 'vitest'
import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandPort,
  DshParsedCommand,
} from '../src/command/port.ts'
import type { DshInteractionPort } from '../src/interaction/port.ts'
import {
  createUnavailableSessionModelPort,
  type DshTuiModelSelection,
  type SessionModelPort,
  type SessionModelSnapshot,
} from '../src/model/port.ts'
import {
  createUnavailableSessionContextPort,
  type SessionContextPort,
  type SessionContextSnapshot,
} from '../src/context/port.ts'
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
  readonly models?: SessionModelPort
  readonly context?: SessionContextPort
  readonly runtimeDispose?: () => Promise<void>
} = {}): {
  readonly port: DshTuiSessionPort
  readonly runtime: DshRuntimePort
  readonly interaction: DshInteractionPort
  readonly commands: DshCommandPort
  readonly models: SessionModelPort
  readonly context: SessionContextPort
} {
  const runtime = {
    sessionId: 'composed-session',
    dispose: options.runtimeDispose ?? vi.fn(async () => {}),
  } as unknown as DshRuntimePort
  const interaction = {
    disposeInteractions: options.interactionDispose ?? vi.fn(),
  } as unknown as DshInteractionPort
  const commands = options.command ?? commandPort()
  const models = options.models ?? createUnavailableSessionModelPort()
  const context = options.context ?? createUnavailableSessionContextPort()
  return {
    port: new DshTuiSessionPort(runtime, interaction, commands, models, context),
    runtime,
    interaction,
    commands,
    models,
    context,
  }
}

describe('composed TUI session command port', () => {
  it('delegates runtime and interaction operations without changing identity or values', async () => {
    const runtimeEvents = {
      async *[Symbol.asyncIterator]() {},
    }
    const interactionEvents = {
      async *[Symbol.asyncIterator]() {},
    }
    const submitResult = { inputId: 'input-1' }
    const receipt = { accepted: true as const }
    const runtime = {
      sessionId: 'delegated-session',
      events: vi.fn(() => runtimeEvents),
      submit: vi.fn(() => Promise.resolve(submitResult)),
      cancel: vi.fn(),
      whenIdle: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(() => Promise.resolve()),
    } as unknown as DshRuntimePort
    const interaction = {
      sessionId: 'delegated-session',
      interactions: vi.fn(() => interactionEvents),
      respond: vi.fn(() => receipt),
      disposeInteractions: vi.fn(),
    } as unknown as DshInteractionPort
    const port = new DshTuiSessionPort(runtime, interaction, commandPort())
    const signal = new AbortController().signal
    const runtimeOptions = { afterSeq: 7, signal }
    const interactionOptions = { signal }
    const response = {
      id: 'approval-1',
      kind: 'approval' as const,
      outcome: 'allowed-once' as const,
    }

    expect(port.sessionId).toBe('delegated-session')
    expect(port.events(runtimeOptions)).toBe(runtimeEvents)
    await expect(port.submit({ text: 'hello' }, 'steer')).resolves.toBe(submitResult)
    port.cancel({ kind: 'user' }, { keepInbox: true })
    await expect(port.whenIdle()).resolves.toBeUndefined()
    await expect(port.flush()).resolves.toBeUndefined()
    expect(port.interactions(interactionOptions)).toBe(interactionEvents)
    expect(port.respond(response)).toBe(receipt)
    port.disposeInteractions()

    expect(runtime.events).toHaveBeenCalledExactlyOnceWith(runtimeOptions)
    expect(runtime.submit).toHaveBeenCalledExactlyOnceWith({ text: 'hello' }, 'steer')
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(
      { kind: 'user' },
      { keepInbox: true },
    )
    expect(runtime.whenIdle).toHaveBeenCalledOnce()
    expect(runtime.flush).toHaveBeenCalledOnce()
    expect(interaction.interactions).toHaveBeenCalledExactlyOnceWith(interactionOptions)
    expect(interaction.respond).toHaveBeenCalledExactlyOnceWith(response)
    expect(interaction.disposeInteractions).toHaveBeenCalledOnce()
  })

  it('provides a complete inert model seam when no model owner is composed', async () => {
    const models = createUnavailableSessionModelPort()
    expect(models.modelSnapshot()).toEqual({
      routable: false,
      writable: false,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    })
    await expect(models.refreshModels()).resolves.toBeUndefined()
    await expect(models.selectModel({ provider: 'p', model: 'm' }))
      .rejects.toThrow('model selection is unavailable')
    const stop = models.onModelsChanged(() => {})
    expect(stop()).toBeUndefined()
    expect(models.disposeModels()).toBeUndefined()
  })

  it('delegates model snapshots, refreshes, selection, listeners, and disposal exactly', async () => {
    const snapshot: SessionModelSnapshot = {
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    }
    const refreshModels = vi.fn(async () => {})
    const selectModel = vi.fn(async () => {})
    const stop = vi.fn()
    const onModelsChanged = vi.fn(() => stop)
    const disposeModels = vi.fn()
    const models: SessionModelPort = {
      modelSnapshot: vi.fn(() => snapshot),
      refreshModels,
      selectModel,
      onModelsChanged,
      disposeModels,
    }
    const { port } = sessionHarness({ models })
    const signal = new AbortController().signal
    const selection: DshTuiModelSelection = {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'thorough',
    }
    const listener = vi.fn()

    expect(port.modelSnapshot()).toBe(snapshot)
    await port.refreshModels(signal)
    await port.selectModel(selection, { saveDefault: true, signal })
    expect(port.onModelsChanged(listener)).toBe(stop)
    port.disposeModels()

    expect(refreshModels).toHaveBeenCalledExactlyOnceWith(signal)
    expect(selectModel).toHaveBeenCalledExactlyOnceWith(
      selection,
      { saveDefault: true, signal },
    )
    expect(onModelsChanged).toHaveBeenCalledExactlyOnceWith(listener)
    expect(disposeModels).toHaveBeenCalledOnce()
  })

  it('provides an inert context seam when no official projection registry is composed', () => {
    const { port } = sessionHarness()
    expect(port.contextSnapshot()).toEqual({ available: false })
    const stop = port.onContextChanged(() => {})
    expect(stop()).toBeUndefined()
    expect(port.disposeContext()).toBeUndefined()
  })

  it('delegates official context snapshots, listeners, and disposal exactly', () => {
    const snapshot: SessionContextSnapshot = {
      available: true,
      asOfSeq: 9,
      pressure: { projectedTokens: 8_000, contextWindow: 128_000 },
    }
    const stop = vi.fn()
    const listener = vi.fn()
    const context: SessionContextPort = {
      contextSnapshot: vi.fn(() => snapshot),
      onContextChanged: vi.fn(() => stop),
      disposeContext: vi.fn(),
    }
    const { port } = sessionHarness({ context })

    expect(port.contextSnapshot()).toBe(snapshot)
    expect(port.onContextChanged(listener)).toBe(stop)
    port.disposeContext()

    expect(context.contextSnapshot).toHaveBeenCalledOnce()
    expect(context.onContextChanged).toHaveBeenCalledExactlyOnceWith(listener)
    expect(context.disposeContext).toHaveBeenCalledOnce()
  })

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
    const context = {
      ...createUnavailableSessionContextPort(),
      disposeContext: vi.fn(),
    }
    const runtimeDispose = vi.fn(async () => {})
    const { port } = sessionHarness({
      command: commands,
      interactionDispose,
      context,
      runtimeDispose,
    })

    const first = port.dispose()
    const second = port.dispose()
    expect(second).toBe(first)
    await first

    expect(commands.disposeCommands).toHaveBeenCalledOnce()
    expect(interactionDispose).toHaveBeenCalledOnce()
    expect(context.disposeContext).toHaveBeenCalledOnce()
    expect(runtimeDispose).toHaveBeenCalledOnce()
  })

  it('attempts every owner cleanup and preserves all disposal failures', async () => {
    const commandFailure = new Error('command cleanup failed')
    const interactionFailure = new Error('interaction cleanup failed')
    const runtimeFailure = new Error('runtime cleanup failed')
    const modelFailure = new Error('model cleanup failed')
    const contextFailure = new Error('context cleanup failed')
    const commands = commandPort({
      disposeCommands: vi.fn(() => { throw commandFailure }),
    })
    const interactionDispose = vi.fn(() => { throw interactionFailure })
    const runtimeDispose = vi.fn(() => Promise.reject(runtimeFailure))
    const models: SessionModelPort = {
      ...createUnavailableSessionModelPort(),
      disposeModels: vi.fn(() => { throw modelFailure }),
    }
    const context: SessionContextPort = {
      ...createUnavailableSessionContextPort(),
      disposeContext: vi.fn(() => { throw contextFailure }),
    }
    const { port } = sessionHarness({
      command: commands,
      interactionDispose,
      models,
      context,
      runtimeDispose,
    })

    const disposal = port.dispose()
    await expect(disposal).rejects.toMatchObject({
      errors: [
        commandFailure,
        interactionFailure,
        modelFailure,
        contextFailure,
        runtimeFailure,
      ],
    })
    expect(port.dispose()).toBe(disposal)
    expect(commands.disposeCommands).toHaveBeenCalledOnce()
    expect(interactionDispose).toHaveBeenCalledOnce()
    expect(runtimeDispose).toHaveBeenCalledOnce()
  })
})
