import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  internals as cmdlineInternals,
  provideCmdline,
} from '@deepseek-ai/dsh-cmdline'
import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  DshTuiController,
  PiTerminalDriver,
  apply as applyRoot,
  inject,
  name,
  type DshTuiControllerOptions,
  type DshTuiProductPort,
  type DshTuiRuntimeService,
  type TerminalDriver,
} from '../src/internal.ts'
import {
  Config,
  consumeProductTask,
  createDshTuiProductEnvironment,
  type DshTuiProductEnvironment,
} from '../src/plugin.ts'
import { DshTuiProductRunner } from '../src/app/runner.ts'
import * as CordisKernelRow from '../src/adapters/cordis.ts'
import { CordisDshTuiFeatureService } from '../src/dsh/feature-service.ts'
import {
  ROOT_COMPOSITION_OWNER_ID,
} from '../src/composition/ownership.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'
import {
  DshInteractionHub,
  type DshInteractionOwner,
} from '../src/dsh/interaction-hub.ts'
import { snapshotSessionEvents } from '../src/dsh/session-events.ts'

let productEnvironment = createDshTuiProductEnvironment()
const originalCmdlineStdout = cmdlineInternals.stdout
const originalCmdlineStderr = cmdlineInternals.stderr

function setProductEnvironment(
  overrides: Partial<DshTuiProductEnvironment>,
): void {
  productEnvironment = createDshTuiProductEnvironment({
    ...productEnvironment,
    ...overrides,
  })
}

function apply(ctx: Context, config: Config = {}): ReturnType<typeof applyRoot> {
  return applyRoot(ctx, config, productEnvironment)
}

function trackTerminalCreation(): ReturnType<typeof vi.fn> {
  const createTerminal = vi.fn(productEnvironment.createTerminal)
  setProductEnvironment({ createTerminal })
  return createTerminal
}

function trackControllerCreation(): ReturnType<typeof vi.fn> {
  const createController = vi.fn(productEnvironment.createController)
  setProductEnvironment({ createController })
  return createController
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  productEnvironment = createDshTuiProductEnvironment()
  cmdlineInternals.stdout = originalCmdlineStdout
  cmdlineInternals.stderr = originalCmdlineStderr
  vi.restoreAllMocks()
})

function providePluginRequirements(ctx: Context): void {
  ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as never)
  providePresetRuntime(ctx)
  provideEmptyToolRuntime(ctx)
  ctx.provide('agents', {} as never)
  ctx.provide('approval', {} as never)
  provideCommandRuntime(ctx)
  ctx.provide('sessions', {} as never)
  provideSessionQuery(ctx)
  ctx.provide('userQuestions', {} as never)
}

function provideSessionQuery(ctx: Context): void {
  if (ctx.get('sessionQuery') !== undefined) return
  ctx.provide('sessionQuery', {
    listSessions: async () => [],
  } as never)
}

function providePresetRuntime(ctx: Context): void {
  const mounted = new WeakMap<Context, string>()
  const preset = (id: string) => ({
    id,
    trust: 'system' as const,
    path: `D:\\presets\\${id}\\agent.cordis.yml`,
  })
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list: async () => [preset('standard'), preset('minimal')],
    resolve: async (id?: string) => preset(id ?? 'standard'),
    mount: async (agentCtx: Context, id?: string) => {
      const resolved = id ?? 'standard'
      mounted.set(agentCtx, resolved)
      return preset(resolved)
    },
    composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
  } as never)
}

function provideEmptyToolRuntime(ctx: Context): void {
  ctx.provide('tools', { schemas: () => [] } as never)
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => undefined,
    resolveCallConfig: async (selection: unknown) => selection,
  } as never)
}

function provideCommandRuntime(
  ctx: Context,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const commands = {
    list: () => [],
    execute: () => Promise.resolve(undefined),
    ...overrides,
  }
  ctx.provide('commands', commands as never)
  return commands
}

describe('Cordis plugin surface', () => {
  it('publishes a schema that defaults and validates startup and theme config', () => {
    expect(new Config({})).toEqual({
      autoStart: false,
      theme: { preset: 'auto', palette: {}, colors: {} },
    })
    expect(new Config({
      autoStart: true,
      theme: {
        preset: 'cordis',
        palette: { accent: '#123456' },
        colors: { accent: 'cyanBright', error: 'redBright' },
      },
    })).toEqual({
      autoStart: true,
      theme: {
        preset: 'cordis',
        palette: { accent: '#123456' },
        colors: { accent: 'cyanBright', error: 'redBright' },
      },
    })
    expect(() => new Config({ autoStart: 'yes' } as never)).toThrow()
    expect(() => new Config({ theme: { preset: 'rainbow' } } as never)).toThrow()
    expect(() => new Config({
      theme: { colors: { error: '\u001b[31m' } },
    } as never)).toThrow()
    expect(() => new Config({
      theme: { colors: { arbitrary: 'red' } },
    } as never)).toThrow()
    expect(() => new Config({
      theme: { palette: { accent: '#fff' } },
    } as never)).toThrow()
    expect(() => new Config({
      theme: { palette: { arbitrary: '#123456' } },
    } as never)).toThrow()
  })

  it('uses named exports and scopes the runtime service to the plugin fiber', async () => {
    const createTerminal = trackTerminalCreation()
    expect(name).toBe('dsh-tui')
    expect(inject).toEqual([
      'agentDefaultModel',
      'agentPresets',
      'agents',
      'approval',
      'commands',
      'llm',
      'sessions',
      'tools',
      'userQuestions',
    ])

    const ctx = new Context()
    ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as never)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    ctx.provide('agents', {} as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { list: () => [] } as never)
    provideSessionQuery(ctx)
    ctx.provide('userQuestions', {} as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    const service = ctx.get('dshTui') as DshTuiRuntimeService | undefined
    const featureService = ctx.get('dshTuiFeatures')
    const preferences = ctx.get('dshTuiPreferences')
    expect(service).toBeDefined()
    expect(featureService === undefined).toBe(false)
    expect(preferences).toBeDefined()
    await expect(featureService?.ready).resolves.toMatchObject([
      { featureId: 'legacy.chat', state: 'active' },
    ])
    for (const featureId of [
      'sessions', 'diff', 'models', 'modes', 'skills', 'tools', 'mcp', 'settings',
    ]) {
      expect(featureService?.status(featureId)).toEqual({
        featureId,
        state: 'inactive',
      })
    }
    expect(service?.open).toEqual(expect.any(Function))
    expect(service?.activation.activateSession).toEqual(expect.any(Function))
    expect(service?.inspection.inspectSession).toEqual(expect.any(Function))
    expect(service?.catalog.listSessions).toEqual(expect.any(Function))
    expect(service?.presets.listPresets).toEqual(expect.any(Function))
    expect(service?.providers.list).toEqual(expect.any(Function))
    expect(service?.providers.connect).toEqual(expect.any(Function))
    await expect(service?.catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [],
    })
    await expect(service?.presets.listPresets()).resolves.toMatchObject({
      defaultId: 'standard',
      presets: [
        { id: 'standard', isDefault: true },
        { id: 'minimal', isDefault: false },
      ],
    })
    expect(createTerminal).not.toHaveBeenCalled()
    await expect(service?.open({ mode: 'create' })).rejects.toThrow('model selection')
    if (false) {
      // @ts-expect-error -- public open is create-only; cold resume requires activation.
      await ctx.dshTui.open({ mode: 'resume', sessionId: 'compile-only' })
    }

    await plugin.dispose()
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(ctx.get('dshTuiFeatures')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('validates autoStart before allocating product resources', async () => {
    const createTerminal = trackTerminalCreation()
    const invalid = new Context()
    expect(() => apply(invalid, { autoStart: 'yes' } as never)).toThrow(
      'autoStart',
    )
    expect(invalid.get('dshTui')).toBeUndefined()

    const invalidTheme = new Context()
    expect(() => apply(invalidTheme, {
      autoStart: true,
      theme: { colors: { error: '\u001b[31m' } },
    } as never)).toThrow('theme')
    expect(invalidTheme.get('dshTui')).toBeUndefined()

    expect(createTerminal).not.toHaveBeenCalled()

    await Promise.all([
      invalid.fiber.dispose(),
      invalidTheme.fiber.dispose(),
    ])
  })

  it('claims root ownership then waits for both declared launcher services', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const exits: number[] = []
    cmdlineInternals.stdout = { write: () => {} }
    const createTerminal = trackTerminalCreation()
    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await new Promise<void>(resolve => { setImmediate(resolve) })

    const ownership = ctx.get('dshTuiCompositionOwnership')
    expect(ownership?.mode).toBe('root')
    expect(ownership?.owner.id).toBe(ROOT_COMPOSITION_OWNER_ID)
    expect(ownership).toEqual({
      mode: 'root',
      owner: { id: ROOT_COMPOSITION_OWNER_ID },
    })
    expect(ctx.get('dshTuiFeatures')).toBeUndefined()
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()

    ctx.provide('cmdlineArgs', { get: () => ['--help'] })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(exits).toEqual([])
    expect(ctx.get('dshTuiFeatures')).toBeUndefined()

    ctx.provide('appExit', code => { exits.push(code) })
    await plugin
    expect(exits).toEqual([0])
    expect(ctx.get('dshTuiFeatures')).toBeUndefined()
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()

    await plugin.dispose()
    expect(ctx.get('dshTuiCompositionOwnership')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads the optional product environment from Context in direct compatibility mounts', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const reportError = vi.fn()
    ctx.provide('dshTuiProductEnvironment', { reportError })

    applyRoot(ctx)

    expect(ctx.get('dshTuiFeatures')).toBeDefined()
    expect(ctx.get('dshTui')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('revokes a pending launcher owner before late dependencies can allocate', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const exits: number[] = []
    const createTerminal = trackTerminalCreation()
    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await new Promise<void>(resolve => { setImmediate(resolve) })

    expect(ctx.get('dshTuiCompositionOwnership')).toBeDefined()
    await plugin.dispose()
    expect(ctx.get('dshTuiCompositionOwnership')).toBeUndefined()

    ctx.provide('cmdlineArgs', { get: () => [] })
    ctx.provide('appExit', code => { exits.push(code) })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(ctx.get('dshTuiFeatures')).toBeUndefined()
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(exits).toEqual([])

    await ctx.fiber.dispose()
  })

  it('can dispose and remount its service in the same Cordis root', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)

    const firstMount = ctx.plugin({ name, inject, Config, apply })
    await firstMount
    const firstService = ctx.get('dshTui')
    expect(firstService).toBeDefined()

    await firstMount.dispose()
    expect(ctx.get('dshTui')).toBeUndefined()

    const secondMount = ctx.plugin({ name, inject, Config, apply })
    await secondMount
    expect(ctx.get('dshTui')).toBeDefined()
    expect(ctx.get('dshTui')).not.toBe(firstService)

    await secondMount.dispose()
    expect(ctx.get('dshTui')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects mixed root and split-row composition before allocating a second owner', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const kernel = ctx.plugin(CordisKernelRow)
    await kernel
    const existing = ctx.get('dshTuiFeatures')

    expect(existing !== undefined).toBe(true)
    expect(() => apply(ctx)).toThrow(
      'composition ownership conflict: existing=split:dsh-tui.split, requested=root:dsh-tui.root',
    )
    expect(ctx.get('dshTuiFeatures') !== undefined).toBe(true)
    expect(ctx.get('dshTui')).toBeUndefined()

    await kernel.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects split composition after root ownership before allocating another kernel', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const root = ctx.plugin({ name, inject, apply })
    await root
    const existing = ctx.get('dshTuiFeatures')

    expect(existing).toBeDefined()
    expect(() => CordisKernelRow.apply(ctx)).toThrow(
      'composition ownership conflict: existing=root:dsh-tui.root, requested=split:dsh-tui.split',
    )
    expect(ctx.get('dshTuiFeatures')).toBeDefined()

    await root.dispose()
    await ctx.fiber.dispose()
  })

  it('does not allocate a runtime owner after official help exits', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const exits: number[] = []
    const output: string[] = []
    cmdlineInternals.stdout = { write: chunk => { output.push(chunk) } }
    provideCmdline(ctx, {
      args: ['--help'],
      exit: code => { exits.push(code) },
    })
    const createTerminal = trackTerminalCreation()

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin

    expect(exits).toEqual([0])
    expect(output.join('')).toContain('--session-id <session-id>')
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('does not start after plugin disposal while feature readiness is pending', async () => {
    const ready = deferred<readonly []>()
    const featureStart = vi.spyOn(CordisDshTuiFeatureService.prototype, 'start')
      .mockReturnValue(ready.promise)
    const ctx = new Context()
    providePluginRequirements(ctx)
    provideCmdline(ctx, { args: [], exit: () => {} })
    const runnerStart = vi.spyOn(DshTuiProductRunner.prototype, 'start')
    const createTerminal = trackTerminalCreation()
    const reportError = vi.fn()
    setProductEnvironment({ reportError })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    expect(featureStart).toHaveBeenCalledOnce()

    await plugin.dispose()
    ready.resolve([])
    await ready.promise
    await new Promise<void>(resolve => { setImmediate(resolve) })

    expect(runnerStart).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('ignores feature readiness failure after plugin disposal', async () => {
    const ready = deferred<readonly []>()
    vi.spyOn(CordisDshTuiFeatureService.prototype, 'start')
      .mockReturnValue(ready.promise)
    const runnerStart = vi.spyOn(DshTuiProductRunner.prototype, 'start')
    const runnerFailure = vi.spyOn(DshTuiProductRunner.prototype, 'requestFatalFailure')
    const reportError = vi.fn()
    setProductEnvironment({ reportError })
    const ctx = new Context()
    providePluginRequirements(ctx)
    provideCmdline(ctx, { args: [], exit: () => {} })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await plugin.dispose()
    ready.reject(new Error('late feature readiness failure'))
    await expect(ready.promise).rejects.toThrow('late feature readiness failure')
    await new Promise<void>(resolve => { setImmediate(resolve) })

    expect(runnerStart).not.toHaveBeenCalled()
    expect(runnerFailure).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('terminates autoStart when a required feature cannot become ready', async () => {
    const featureFailure = new Error('\u001b[31mrequired\nfeature failed')
    const featureStart = vi.spyOn(CordisDshTuiFeatureService.prototype, 'start')
      .mockRejectedValue(featureFailure)
    const runnerStart = vi.spyOn(DshTuiProductRunner.prototype, 'start')
    const runnerFailure = vi.spyOn(DshTuiProductRunner.prototype, 'requestFatalFailure')
    const createTerminal = trackTerminalCreation()
    const reports: string[] = []
    setProductEnvironment({ reportError: message => { reports.push(message) } })
    const exits: number[] = []
    const ctx = new Context()
    providePluginRequirements(ctx)
    provideCmdline(ctx, { args: [], exit: code => { exits.push(code) } })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(featureStart).toHaveBeenCalledOnce()
    expect(runnerFailure).toHaveBeenCalledExactlyOnceWith(featureFailure)
    expect(runnerStart).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(reports).toEqual(['dsh-tui: required feature failed\n'])
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('turns a post-start required feature failure into a fatal product request', async () => {
    const runnerStart = vi.spyOn(DshTuiProductRunner.prototype, 'start')
      .mockResolvedValue()
    const runnerFailure = vi.spyOn(DshTuiProductRunner.prototype, 'requestFatalFailure')
    const exits: number[] = []
    const reports: string[] = []
    setProductEnvironment({ reportError: message => { reports.push(message) } })
    const ctx = new Context()
    providePluginRequirements(ctx)
    provideCmdline(ctx, { args: [], exit: code => { exits.push(code) } })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(runnerStart).toHaveBeenCalledOnce())
    const registration = ctx.dshTuiFeatures.registerFeature({
      manifest: {
        id: 'dynamic.required',
        apiVersion: 1,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => { throw new Error('dynamic create failed') },
    })

    await expect(registration.activation).rejects.toThrow('dynamic.required')
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(runnerFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'FeatureActivationError',
      featureId: 'dynamic.required',
    }))
    expect(reports).toEqual([
      'dsh-tui: Feature "dynamic.required" failed to activate\n',
    ])
    await registration.release()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('routes active feature retirement through the product FeatureHost', async () => {
    const runnerStart = vi.spyOn(DshTuiProductRunner.prototype, 'start')
      .mockResolvedValue()
    const handleUnload = vi.spyOn(
      (await import('../src/app/feature-host.ts')).DshTuiFeatureHost.prototype,
      'handleActiveFeatureUnloaded',
    )
    const ctx = new Context()
    providePluginRequirements(ctx)
    provideCmdline(ctx, { args: [], exit: () => {} })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(runnerStart).toHaveBeenCalledOnce())
    const registration = ctx.dshTuiFeatures.registerFeature({
      manifest: {
        id: 'dynamic.optional',
        apiVersion: 1,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: {}, dispose() {} }),
    })

    await expect(registration.activation).resolves.toMatchObject({
      featureId: 'dynamic.optional',
      state: 'active',
    })
    await registration.release()
    await vi.waitFor(() => expect(handleUnload).toHaveBeenCalledWith(expect.objectContaining({
      featureId: 'dynamic.optional',
      fallbackRoute: 'chat',
      restoreFocus: true,
    })))

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('assembles exactly one session, terminal, and controller when autoStart is true', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('auto-session'))
    const exits: number[] = []
    const disposeHandle = vi.fn(async () => {})
    const detach = vi.spyOn(DshInteractionHub.prototype, 'detach')
    const createAgent = vi.fn(async (options: CreateAgentOptions): Promise<AgentHandle> => {
      const agent = {
        id: session.id,
        options: {},
        session,
        inbox: {},
        status: 'idle',
        ctx,
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        inject: () => {},
      } as unknown as Agent
      ctx.provide('agent', agent as never)
      const commit = await options.setup?.(ctx, agent)
      commit?.commit()
      return { agent, dispose: disposeHandle }
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('agents', { create: createAgent } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {} as never)
    provideCmdline(ctx, {
      args: [
        '--session-id',
        session.id,
        '--agent-preset',
        'standard',
        '--provider',
        'startup-provider',
        '--model',
        'startup/model',
        '--reasoning-effort',
        'startup-effort',
      ],
      exit: code => { exits.push(code) },
    })

    const restore = vi.fn()
    const terminal: TerminalDriver = {
      state: 'idle',
      viewport: { columns: 80, rows: 24 },
      start: vi.fn(),
      handoff: vi.fn(),
      render: vi.fn(),
      stopAcceptingInput: vi.fn(),
      restore,
    }
    const createTerminal = vi.fn(() => terminal)
    let noOpExitObserved = false
    const requestExit = vi.fn(() => Promise.resolve({
      ok: true as const,
      reason: 'user' as const,
      shutdown: { mode: 'graceful' as const, issues: [] },
    }))
    const wait = vi.fn(() => Promise.resolve({
      ok: false as const,
      reason: 'forced' as const,
      shutdown: { mode: 'forced' as const, issues: [] },
    }))
    const forceExit = vi.fn()
    let controllerState: 'idle' | 'running' | 'stopped' = 'idle'
    const createController = vi.fn((options: DshTuiControllerOptions) => ({
      get state() { return controllerState },
      start: async () => {
        controllerState = 'running'
        await options.application.requestExit()
        noOpExitObserved = exits.length === 0
        await options.application.forceExit()
        if (options.sessionRelease === undefined) {
          throw new Error('product composition omitted its initial Session release')
        }
        await options.sessionRelease()
        terminal.restore()
        controllerState = 'stopped'
      },
      requestExit,
      wait,
    }))
    setProductEnvironment({ createTerminal, createController, forceExit })

    const plugin = ctx.plugin({ name, inject, apply }, {
      autoStart: true,
      theme: {
        preset: 'mono',
        colors: { accent: 'magentaBright' },
      },
    })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([130]))

    expect(createAgent).toHaveBeenCalledOnce()
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      agentOptions: {
        provider: 'startup-provider',
        model: 'startup/model',
      },
    })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createTerminal).toHaveBeenCalledWith({
      theme: expect.objectContaining({
        preset: 'mono',
        colorEnabled: false,
        styleEnabled: expect.any(Boolean),
        colors: expect.objectContaining({ accent: 'magentaBright' }),
      }),
    })
    expect(createController).toHaveBeenCalledOnce()
    expect(createController.mock.calls[0]?.[0].session.sessionId).toBe(session.id)
    expect(createController.mock.calls[0]?.[0].catalog).toBe(ctx.dshTui.catalog)
    expect(createController.mock.calls[0]?.[0].activation).toBe(ctx.dshTui.activation)
    expect(createController.mock.calls[0]?.[0].inspection).toBe(ctx.dshTui.inspection)
    expect(createController.mock.calls[0]?.[0].settings).toBe(ctx.dshTui.settings)
    expect(createController.mock.calls[0]?.[0].pluginInventory).toBe(
      ctx.dshTui.pluginInventory,
    )
    const toolCards = createController.mock.calls[0]?.[0].toolCards
    expect(toolCards?.renderSafe({
      phase: 'call',
      toolName: 'shell',
      status: 'running',
      width: 80,
      presentation: {
        phase: 'call',
        card: 'terminal',
        title: 'pnpm test',
      },
    })[0]).toContain('Terminal · pnpm test')
    expect(noOpExitObserved).toBe(true)
    expect(forceExit).toHaveBeenCalledExactlyOnceWith(130)
    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()

    await plugin.dispose()
    expect(toolCards?.renderSafe({
      phase: 'call',
      toolName: 'shell',
      status: 'running',
      width: 80,
      presentation: {
        phase: 'call',
        card: 'terminal',
        title: 'pnpm test',
      },
    })[0]).toBe('Tool shell · running')
    expect(requestExit).not.toHaveBeenCalled()
    expect(wait).toHaveBeenCalled()
    expect(detach).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('routes startup resume through the shared cold activation owner', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const sessionId = SessionId('startup-resume')
    const session = Session.create(sessionId, undefined, {
      version: 3,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      cwd: 'D:\\historic-workspace',
      agentPreset: 'standard',
    })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'historic-provider',
          model: 'historic-model',
          maxTokens: 2048,
        },
      },
    })
    const liveAgents = new Map<string, Agent>()
    const liveSessions = new Map<string, Session>()
    const exits: number[] = []
    const createAgent = vi.fn()
    const detach = vi.spyOn(DshInteractionHub.prototype, 'detach')
    const disposeHandle = vi.fn(async () => {
      liveAgents.delete(sessionId)
      liveSessions.delete(sessionId)
    })
    const resumeAgent = vi.fn(async (
      options: ResumeAgentOptions,
    ): Promise<AgentHandle> => {
      const agent = {
        id: sessionId,
        options: { ...options.agentOptions },
        session,
        inbox: {},
        status: 'idle',
        ctx,
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        inject: () => {},
      } as unknown as Agent
      const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      const commit = await options.setup?.(agentCtx, agent)
      commit?.commit()
      liveAgents.set(sessionId, agent)
      liveSessions.set(sessionId, session)
      return { agent, dispose: disposeHandle }
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({
        provider: 'current-default-provider',
        model: 'current-default-model',
      }),
    } as never)
    ctx.provide('sessionPersistence', {
      open: async () => ({
        id: sessionId,
        header: session.header,
        inheritedEventCount: 0,
        access: 'read',
        read: async () => ({
          eventState: 'shared',
          events: snapshotSessionEvents(session),
        }),
        close: async () => {},
      }),
    } as never)
    ctx.provide('agents', {
      create: createAgent,
      get: (id: string) => liveAgents.get(id),
      roots: () => [...liveAgents.values()],
      resume: resumeAgent,
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', {
      get: (id: string) => liveSessions.get(id),
      flush: () => Promise.resolve(true),
    } as never)
    ctx.provide('userQuestions', {} as never)
    provideCmdline(ctx, {
      args: [
        '--resume',
        sessionId,
        '--provider',
        'override-provider',
        '--model',
        'override/model',
        '--reasoning-effort',
        'override-effort',
      ],
      exit: code => { exits.push(code) },
    })

    const restore = vi.fn()
    const terminal: TerminalDriver = {
      state: 'idle',
      viewport: { columns: 80, rows: 24 },
      start: vi.fn(),
      handoff: vi.fn(),
      render: vi.fn(),
      stopAcceptingInput: vi.fn(),
      restore,
    }
    const createTerminal = vi.fn(() => terminal)
    const requestExit = vi.fn()
    const wait = vi.fn(async () => ({
      ok: true as const,
      reason: 'user' as const,
      shutdown: { mode: 'graceful' as const, issues: [] },
    }))
    let controllerState: 'idle' | 'running' | 'stopped' = 'idle'
    const createController = vi.fn((options: DshTuiControllerOptions) => ({
      get state() { return controllerState },
      start: async () => {
        controllerState = 'running'
        if (options.sessionRelease === undefined) {
          throw new Error('product composition omitted its resumed Session release')
        }
        await options.sessionRelease()
        terminal.restore()
        controllerState = 'stopped'
      },
      requestExit,
      wait,
    }))
    setProductEnvironment({ createTerminal, createController })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([0]))

    expect(createAgent).not.toHaveBeenCalled()
    expect(resumeAgent).toHaveBeenCalledOnce()
    expect(resumeAgent.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: sessionId,
      agentOptions: {
        provider: 'override-provider',
        model: 'override/model',
        maxTokens: 2048,
      },
    })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createController).toHaveBeenCalledOnce()
    expect(createController.mock.calls[0]?.[0].session.sessionId).toBe(sessionId)
    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()

    await plugin.dispose()
    expect(disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('fails a missing startup resume before terminal allocation with one sanitized exit', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const exits: number[] = []
    const resumeAgent = vi.fn()
    const open = vi.fn(async () => {
      throw new Error('\u001b[31mmissing durable\nsnapshot')
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    } as never)
    ctx.provide('sessionPersistence', { open } as never)
    ctx.provide('agents', {
      get: () => undefined,
      roots: () => [],
      resume: resumeAgent,
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', {
      get: () => undefined,
      flush: () => Promise.resolve(true),
    } as never)
    ctx.provide('userQuestions', {} as never)
    provideCmdline(ctx, {
      args: ['--resume', 'missing-startup-session'],
      exit: code => { exits.push(code) },
    })
    const reportError = vi.fn()
    const createTerminal = trackTerminalCreation()
    const createController = trackControllerCreation()
    setProductEnvironment({ reportError })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(open).toHaveBeenCalledOnce()
    expect(resumeAgent).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(createController).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      'dsh-tui: missing durable snapshot\n',
    )
    expect(reportError.mock.calls[0]?.[0]).not.toMatch(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u,
    )

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('defaults preset-less create startup to Standard without opening a selector', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const session = Session.create(SessionId('default-standard-session'))
    const disposeHandle = vi.fn(async () => {})
    const createAgent = vi.fn(async (options: CreateAgentOptions): Promise<AgentHandle> => {
      const agent = {
        id: session.id,
        options: {},
        session,
        inbox: {},
        status: 'idle',
        ctx,
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        inject: () => {},
      } as unknown as Agent
      ctx.provide('agent', agent as never)
      const commit = await options.setup?.(ctx, agent)
      commit?.commit()
      return { agent, dispose: disposeHandle }
    })
    Object.assign(ctx.get('agents')!, { create: createAgent })
    Object.assign(ctx.get('sessions')!, { flush: () => Promise.resolve(true) })
    Object.assign(ctx.get('agentDefaultModel')!, {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    })
    const exits: number[] = []
    provideCmdline(ctx, {
      args: [],
      exit: code => { exits.push(code) },
    })
    const restore = vi.fn()
    const terminal: TerminalDriver = {
      state: 'idle',
      viewport: { columns: 80, rows: 24 },
      start: vi.fn(),
      handoff: vi.fn(),
      render: vi.fn(),
      stopAcceptingInput: vi.fn(),
      restore,
    }
    const createTerminal = vi.fn(() => terminal)
    let controllerState: 'idle' | 'running' | 'stopped' = 'idle'
    const createController = vi.fn((options: DshTuiControllerOptions) => ({
      get state() { return controllerState },
      start: async () => { controllerState = 'running' },
      requestExit: vi.fn(),
      wait: async () => {
        await options.sessionRelease?.()
        terminal.restore()
        controllerState = 'stopped'
        return {
          ok: true as const,
          reason: 'user' as const,
          shutdown: { mode: 'graceful' as const, issues: [] },
        }
      },
    }))
    setProductEnvironment({ createTerminal, createController })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([0]))

    expect(createAgent).toHaveBeenCalledOnce()
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      meta: { agentPreset: 'standard' },
    })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createController).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('routes automatic startup failures through the sanitized product reporter', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
    const exits: number[] = []
    provideCmdline(ctx, {
      args: ['--agent-preset', 'standard'],
      exit: code => { exits.push(code) },
    })
    const reportError = vi.fn()
    const createTerminal = trackTerminalCreation()
    setProductEnvironment({ reportError })

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(createTerminal).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError.mock.calls[0]?.[0]).toContain('model selection')
    expect(reportError.mock.calls[0]?.[0]).not.toMatch(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u,
    )
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('uses bounded default process seams and contains an unexpected task rejection', async () => {
    const environment = createDshTuiProductEnvironment()
    const terminal = environment.createTerminal({
      theme: createDshTuiTheme({ preset: 'mono' }),
    })
    expect(terminal).toBeInstanceOf(PiTerminalDriver)
    terminal.restore()

    const controllerTerminal: TerminalDriver = {
      state: 'idle',
      viewport: { columns: 80, rows: 24 },
      start: () => {},
      handoff: () => {},
      render: () => {},
      stopAcceptingInput: () => {},
      restore: () => {},
    }
    const controller = environment.createController({
      session: { sessionId: 'seam-session' } as unknown as DshTuiProductPort,
      catalog: { listSessions: async () => ({ durability: 'unavailable', sessions: [] }) },
      terminal: controllerTerminal,
      application: { requestExit: () => {}, forceExit: () => {} },
    })
    expect(controller).toBeInstanceOf(DshTuiController)

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    environment.reportError('probe')
    expect(stderr).toHaveBeenCalledWith('probe')

    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    expect(() => environment.forceExit(130)).toThrow('exit 130')
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)

    const report = vi.fn()
    consumeProductTask(
      Promise.reject(new Error('\u001b[31munexpected\nfailure')),
      report,
    )
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(
      'dsh-tui: unexpected product task rejection: unexpected failure\n',
    ))

    const brokenReporter = vi.fn(() => { throw new Error('stderr unavailable') })
    consumeProductTask(Promise.reject(new Error('contained')), brokenReporter)
    await new Promise<void>(resolve => { queueMicrotask(() => { resolve() }) })
  })

  it('owns interactions during unpublished setup and returns one composed port', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('plugin-session'))
    const followup = vi.fn()
    const cancel = vi.fn()
    const whenIdle = vi.fn(() => Promise.resolve())
    const flush = vi.fn(() => Promise.resolve(true))
    const disposeHandle = vi.fn(() => Promise.resolve())
    // Harness 0.1.5 deleted per-session provider registration: the hub owns the
    // exact Agent through attach/detach around the unpublished setup transaction.
    const attachOrder: string[] = []
    const originalAttach = DshInteractionHub.prototype.attach
    const attach = vi.spyOn(DshInteractionHub.prototype, 'attach')
      .mockImplementation(function (this: DshInteractionHub, owner: DshInteractionOwner) {
        attachOrder.push('attach')
        return originalAttach.call(this, owner)
      })
    let agent!: Agent
    const listCommands = vi.fn(() => [{
      name: 'inspect',
      description: 'Inspect state',
    }])
    const executeCommand = vi.fn(() => Promise.resolve({
      commandId: 'plugin-command',
      result: { kind: 'success' as const, text: 'inspected' },
    }))

    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx, { list: listCommands, execute: executeCommand })
    ctx.provide('sessions', { flush } as never)
    ctx.provide('userQuestions', {} as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        agent = {
          id: session.id,
          options: {},
          session,
          inbox: {},
          status: 'idle',
          ctx,
          followup,
          steer: vi.fn(),
          cancel,
          whenIdle,
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: () => {},
          inject: () => {},
        } as unknown as Agent
        ctx.provide('agent', agent as never)
        const commit = await options.setup?.(ctx, agent)
        attachOrder.push('commit')
        commit?.commit()
        return { agent, dispose: disposeHandle }
      },
    } as never)

    const plugin = ctx.plugin({ name, inject, apply })
    await plugin
    const service = ctx.get('dshTui') as DshTuiRuntimeService
    const port = await service.open({
      mode: 'create',
      sessionId: session.id,
      cwd: 'D:\\Projects\\DSH-Project',
    })
    expect(attach).toHaveBeenCalledExactlyOnceWith({
      sessionId: session.id,
      agent,
      session,
    })
    expect(attachOrder).toEqual(['attach', 'commit'])
    const observedDecision = session.append('approval/decided', {
      id: ApprovalRequestId('plugin-observed'),
      outcome: 'rejected',
    })
    ctx.emit('session/event', session, observedDecision)

    const unowned: () => Promise<AskUserQuestionAnswer> = () => Promise.reject(
      new Error('question waterfall was not claimed'),
    )
    const answer = ctx.waterfall('user-questions/request', {
      agent,
      questions: [{
        id: 'confirm',
        question: 'Proceed?',
        options: [{ label: 'Yes' }],
      }],
    }, unowned)
    const interactions = port.interactions()[Symbol.asyncIterator]()
    const initial = await interactions.next()
    expect(initial).toMatchObject({
      done: false,
      value: {
        pending: [expect.objectContaining({ kind: 'question' })],
      },
    })
    if (initial.done) throw new Error('expected pending question')
    const pending = initial.value.pending[0]
    if (pending?.kind !== 'question') throw new Error('expected pending question')
    expect(port.respond({
      id: pending.id,
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: { answers: [{ id: 'confirm', selected: ['Yes'] }] },
      },
    })).toEqual({ accepted: true })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'confirm', selected: ['Yes'] }],
    })

    const runtime = port.events()[Symbol.asyncIterator]()
    await expect(runtime.next()).resolves.toMatchObject({
      value: { type: 'agent/created' },
    })
    await expect(port.submit({ text: 'continue' }, 'followup')).resolves.toMatchObject({
      inputId: expect.any(String),
    })
    expect(port.listCommands()).toEqual([{
      name: 'inspect',
      description: 'Inspect state',
    }])
    const commandSignal = new AbortController().signal
    await expect(port.executeCommand('/inspect', commandSignal)).resolves.toEqual({
      commandId: 'plugin-command',
      result: { kind: 'success', text: 'inspected' },
    })
    expect(listCommands).toHaveBeenCalledExactlyOnceWith(agent)
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(
      agent,
      '/inspect',
      [],
      commandSignal,
    )
    port.cancel({ kind: 'user' })
    await port.whenIdle()
    await port.flush()
    expect(followup).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith(session)

    port.disposeInteractions()
    await expect(interactions.next()).resolves.toMatchObject({
      value: { pending: [] },
    })
    await expect(interactions.next()).resolves.toMatchObject({ done: true })
    await port.dispose()
    await runtime.return?.()
    // After detach the hub no longer claims this Agent's question waterfall.
    const fallback = vi.fn((): Promise<AskUserQuestionAnswer> => Promise.resolve({ answers: [] }))
    await expect(ctx.waterfall('user-questions/request', {
      agent,
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }, fallback)).resolves.toEqual({ answers: [] })
    expect(fallback).toHaveBeenCalledOnce()
    expect(disposeHandle).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed when a factory omits the unpublished Agent', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {} as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        // A nonconforming 0.1.5 factory never hands the unpublished Agent to setup.
        await options.setup?.(ctx, undefined as never)
        throw new Error('unreachable')
      },
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    await expect(ctx.dshTui.open({
      mode: 'create',
      sessionId: 'missing-agent',
    })).rejects.toThrow('did not expose its unpublished Agent')

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes a nonconforming handle when the factory skips setup', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('skipped-setup'))
    const dispose = vi.fn(() => Promise.resolve())
    const agent = {
      id: session.id,
      options: {},
      session,
      status: 'idle',
      ctx,
      followup: () => {},
      steer: () => {},
      cancel: () => {},
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {} as never)
    ctx.provide('agents', {
      create: () => Promise.resolve({ agent, dispose }),
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    await expect(ctx.dshTui.open({
      mode: 'create',
      sessionId: session.id,
    })).rejects.toThrow('Agent factory returned before bootstrap commit')
    expect(dispose).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('detaches the prepared interaction owner when the internal setup seam rejects', async () => {
    const ctx = new Context()
    provideSessionQuery(ctx)
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('setup-rejects'))
    const attach = vi.spyOn(DshInteractionHub.prototype, 'attach')
    const detach = vi.spyOn(DshInteractionHub.prototype, 'detach')
    let agent!: Agent
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {} as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
        } as unknown as Agent
        ctx.provide('agent', agent as never)
        await options.setup?.(ctx, agent)
        throw new Error('unreachable')
      },
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    // `setup` remains a runtime-only adapter seam and is intentionally absent
    // from the public OpenDshTuiSessionOptions declaration.
    await expect(ctx.dshTui.open({
      mode: 'create',
      sessionId: session.id,
      setup: () => {
        throw new Error('upstream setup failed')
      },
    } as never)).rejects.toThrow('upstream setup failed')
    expect(attach).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
    // Rollback detached the owner: the hub no longer claims this Agent's asks.
    const fallback = vi.fn((): Promise<AskUserQuestionAnswer> => Promise.resolve({ answers: [] }))
    await expect(ctx.waterfall('user-questions/request', {
      agent,
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }, fallback)).resolves.toEqual({ answers: [] })
    expect(fallback).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
