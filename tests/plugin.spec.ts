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
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import {
  DshTuiController,
  PiTerminalDriver,
  apply,
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
  productInternals,
} from '../src/plugin.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'

const originalProductInternals = { ...productInternals }
const originalCmdlineStdout = cmdlineInternals.stdout
const originalCmdlineStderr = cmdlineInternals.stderr

afterEach(() => {
  Object.assign(productInternals, originalProductInternals)
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
  ctx.provide('userQuestions', {
    registerProvider: () => () => {},
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
      theme: { preset: 'auto', colors: {} },
    })
    expect(new Config({
      autoStart: true,
      theme: {
        preset: 'cordis',
        colors: { accent: 'cyanBright', error: 'redBright' },
      },
    })).toEqual({
      autoStart: true,
      theme: {
        preset: 'cordis',
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
  })

  it('uses named exports and scopes the runtime service to the plugin fiber', async () => {
    const createTerminal = vi.spyOn(productInternals, 'createTerminal')
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    const service = ctx.get('dshTui') as DshTuiRuntimeService | undefined
    expect(service).toBeDefined()
    expect(service?.open).toEqual(expect.any(Function))
    expect(service?.activation.activateSession).toEqual(expect.any(Function))
    expect(service?.inspection.inspectSession).toEqual(expect.any(Function))
    expect(service?.catalog.listSessions).toEqual(expect.any(Function))
    expect(service?.presets.listPresets).toEqual(expect.any(Function))
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
    await ctx.fiber.dispose()
  })

  it('validates autoStart before allocating product resources', async () => {
    const createTerminal = vi.spyOn(productInternals, 'createTerminal')
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

    const noHost = new Context()
    expect(() => apply(noHost, { autoStart: true })).toThrow(
      'launcher must provide ctx.cmdlineArgs and ctx.appExit',
    )
    expect(noHost.get('dshTui')).toBeUndefined()

    const missingExit = new Context()
    missingExit.provide('cmdlineArgs', { get: () => [] })
    expect(() => apply(missingExit, { autoStart: true })).toThrow(
      'launcher must provide ctx.cmdlineArgs and ctx.appExit',
    )
    expect(missingExit.get('dshTui')).toBeUndefined()

    const missingArgs = new Context()
    missingArgs.provide('appExit', () => {})
    expect(() => apply(missingArgs, { autoStart: true })).toThrow(
      'launcher must provide ctx.cmdlineArgs and ctx.appExit',
    )
    expect(missingArgs.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()

    await Promise.all([
      invalid.fiber.dispose(),
      invalidTheme.fiber.dispose(),
      noHost.fiber.dispose(),
      missingExit.fiber.dispose(),
      missingArgs.fiber.dispose(),
    ])
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
    const createTerminal = vi.spyOn(productInternals, 'createTerminal')

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin

    expect(exits).toEqual([0])
    expect(output.join('')).toContain('--session-id <session-id>')
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('assembles exactly one session, terminal, and controller when autoStart is true', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('auto-session'))
    const exits: number[] = []
    const disposeHandle = vi.fn(async () => {})
    const unregisterProvider = vi.fn()
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
      const commit = await options.setup?.(ctx)
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => { unregisterProvider() },
    } as never)
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
    productInternals.createTerminal = createTerminal
    productInternals.createController = createController
    productInternals.forceExit = forceExit

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
    expect(unregisterProvider).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('routes startup resume through the shared cold activation owner', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const sessionId = SessionId('startup-resume')
    const session = Session.create(sessionId, undefined, {
      version: 0,
      id: sessionId,
      createdAt: 1,
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
    const unregisterProvider = vi.fn()
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
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      const commit = await options.setup?.(agentCtx)
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
      inspect: async () => ({ meta: session.header, events: session.events }),
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => { unregisterProvider() },
    } as never)
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
    const selectStartupPreset = vi.fn(productInternals.selectStartupPreset)
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
    productInternals.createTerminal = createTerminal
    productInternals.createController = createController
    productInternals.selectStartupPreset = selectStartupPreset

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
    expect(selectStartupPreset).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createController).toHaveBeenCalledOnce()
    expect(createController.mock.calls[0]?.[0].session.sessionId).toBe(sessionId)
    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(unregisterProvider).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()

    await plugin.dispose()
    expect(disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('fails a missing startup resume before terminal allocation with one sanitized exit', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const exits: number[] = []
    const resumeAgent = vi.fn()
    const inspect = vi.fn(async () => {
      throw new Error('\u001b[31mmissing durable\nsnapshot')
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    } as never)
    ctx.provide('sessionPersistence', { inspect } as never)
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
    } as never)
    provideCmdline(ctx, {
      args: ['--resume', 'missing-startup-session'],
      exit: code => { exits.push(code) },
    })
    const reportError = vi.fn()
    const createTerminal = vi.spyOn(productInternals, 'createTerminal')
    const createController = vi.spyOn(productInternals, 'createController')
    productInternals.reportError = reportError

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(inspect).toHaveBeenCalledOnce()
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

  it('routes preset-less create startup through the pre-publication selector', async () => {
    const ctx = new Context()
    providePluginRequirements(ctx)
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
    const createController = vi.spyOn(productInternals, 'createController')
    const selectStartupPreset = vi.fn(async (
      options: Parameters<typeof productInternals.selectStartupPreset>[0],
    ) => {
      expect(options.catalog).toBe(ctx.dshTui.presets)
      expect(options.terminal).toBe(terminal)
      options.requestCancel()
      return { kind: 'cancelled' as const }
    })
    productInternals.createTerminal = createTerminal
    productInternals.selectStartupPreset = selectStartupPreset

    const plugin = ctx.plugin({ name, inject, apply }, { autoStart: true })
    await plugin
    await vi.waitFor(() => expect(exits).toEqual([0]))

    expect(createTerminal).toHaveBeenCalledOnce()
    expect(selectStartupPreset).toHaveBeenCalledOnce()
    expect(createController).not.toHaveBeenCalled()
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
    const createTerminal = vi.spyOn(productInternals, 'createTerminal')
    productInternals.reportError = reportError

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
    const terminal = productInternals.createTerminal({
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
    const controller = productInternals.createController({
      session: { sessionId: 'seam-session' } as unknown as DshTuiProductPort,
      catalog: { listSessions: async () => ({ durability: 'unavailable', sessions: [] }) },
      terminal: controllerTerminal,
      application: { requestExit: () => {}, forceExit: () => {} },
    })
    expect(controller).toBeInstanceOf(DshTuiController)

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    productInternals.reportError('probe')
    expect(stderr).toHaveBeenCalledWith('probe')

    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    expect(() => productInternals.forceExit(130)).toThrow('exit 130')
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)

    const report = vi.fn()
    productInternals.reportError = report
    consumeProductTask(Promise.reject(new Error('\u001b[31munexpected\nfailure')))
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(
      'dsh-tui: unexpected product task rejection: unexpected failure\n',
    ))

    productInternals.reportError = vi.fn(() => { throw new Error('stderr unavailable') })
    consumeProductTask(Promise.reject(new Error('contained')))
    await new Promise<void>(resolve => { queueMicrotask(() => { resolve() }) })
  })

  it('owns interactions during unpublished setup and returns one composed port', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('plugin-session'))
    const followup = vi.fn()
    const cancel = vi.fn()
    const whenIdle = vi.fn(() => Promise.resolve())
    const flush = vi.fn(() => Promise.resolve(true))
    const disposeHandle = vi.fn(() => Promise.resolve())
    let provider: UserQuestionProvider | undefined
    const unregisterProvider = vi.fn()
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
    ctx.provide('userQuestions', {
      registerProvider: (next: UserQuestionProvider) => {
        if (provider !== undefined) throw new Error('duplicate provider')
        provider = next
        return () => {
          provider = undefined
          unregisterProvider()
        }
      },
    } as never)
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
        const commit = await options.setup?.(ctx)
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
    const activeProvider = provider
    if (activeProvider === undefined) throw new Error('provider was not installed during setup')
    const observedDecision = session.append('approval/decided', {
      id: ApprovalRequestId('plugin-observed'),
      outcome: 'rejected',
    })
    ctx.emit('session/event', session, observedDecision)

    const answer = activeProvider.ask({
      agent,
      questions: [{
        id: 'confirm',
        question: 'Proceed?',
        options: [{ label: 'Yes' }],
      }],
    })
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
    expect(unregisterProvider).toHaveBeenCalledOnce()
    expect(disposeHandle).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed when a factory omits the unpublished Agent', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        await options.setup?.(ctx)
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
    } as never)
    ctx.provide('agents', {
      create: () => Promise.resolve({ agent, dispose }),
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    await expect(ctx.dshTui.open({
      mode: 'create',
      sessionId: session.id,
    })).rejects.toThrow('interaction setup did not run')
    expect(dispose).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('unregisters the prepared provider when upstream setup rejects', async () => {
    const ctx = new Context()
    providePresetRuntime(ctx)
    provideEmptyToolRuntime(ctx)
    const session = Session.create(SessionId('setup-rejects'))
    let provider: UserQuestionProvider | undefined
    const unregister = vi.fn()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('approval', {} as never)
    provideCommandRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('userQuestions', {
      registerProvider: (next: UserQuestionProvider) => {
        provider = next
        return () => {
          provider = undefined
          unregister()
        }
      },
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
        } as unknown as Agent
        ctx.provide('agent', agent as never)
        await options.setup?.(ctx)
        throw new Error('unreachable')
      },
    } as never)
    const plugin = ctx.plugin({ name, inject, apply })
    await plugin

    await expect(ctx.dshTui.open({
      mode: 'create',
      sessionId: session.id,
      setup: () => {
        throw new Error('upstream setup failed')
      },
    })).rejects.toThrow('upstream setup failed')
    expect(provider).toBeUndefined()
    expect(unregister).toHaveBeenCalledOnce()

    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
