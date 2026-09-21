import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  DshTuiFeatureHost,
  FeatureHostContractError,
  type FeatureCommandHandler,
} from '../src/app/feature-host.ts'
import {
  provideDshTuiFeatures,
  type DshTuiFeatureOwner,
} from '../src/dsh/feature-service.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributions,
  type FeatureFactory,
} from '../src/kernel/feature.ts'
import { legacyChatFeature } from '../src/features/legacy-chat.ts'
import type {
  ActiveFeatureContributionSnapshot,
  DshTuiFeatureService,
} from '../src/kernel/feature-service.ts'
import { routeUiCommand } from '../src/navigation/commands.ts'
import {
  transitionNavigation,
  type NavigationState,
} from '../src/navigation/state.ts'

interface HostFixture {
  readonly root: Context
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  readonly owner: DshTuiFeatureOwner
  readonly host: DshTuiFeatureHost
}

async function createHost(navigationKeys?: () => 'arrows' | 'vim' | 'both'): Promise<HostFixture> {
  const root = new Context()
  let owner!: DshTuiFeatureOwner
  let host!: DshTuiFeatureHost
  const plugin = root.plugin({
    name: 'feature-host-fixture',
    apply(ctx) {
      owner = provideDshTuiFeatures(ctx, {
        slots: [{ id: 'workspace.content', cardinality: 'list', protection: 'public' }],
        onActiveFeatureUnloaded: event => host.handleActiveFeatureUnloaded(event),
      }, [legacyChatFeature])
      host = new DshTuiFeatureHost(owner.service, {
        slotDefinitions: owner.slotDefinitions,
        ...(navigationKeys === undefined ? {} : { navigationKeys }),
      })
      ctx.effect(() => () => {
        host.dispose()
        return owner.dispose()
      })
    },
  })
  await plugin
  await host.start()
  return { root, plugin, owner, host }
}

function workspaceFeature(
  id: string,
  commands: Readonly<Record<string, FeatureCommandHandler>> = {},
): FeatureFactory {
  return {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'on-route',
      required: false,
      requires: [],
    },
    declarations: {
      routes: [`${id}.route`],
      commands: Object.keys(commands),
      surfaces: [{ slot: 'workspace.content', cardinality: 'multiple' }],
    },
    create: () => ({
      contributions: {
        routes: [{
          id: `${id}.route`,
          value: { kind: 'workspace', featureId: id, pane: 'navigator' },
        }],
        commands: Object.entries(commands).map(([commandId, handler]) => ({
          id: commandId,
          value: handler,
        })),
        surfaces: [{
          id: `${id}.content`,
          slot: 'workspace.content',
          value: {
            id: `${id}.content`,
            role: 'content',
            node: { kind: 'test-workspace' },
            constraints: { minColumns: 80 },
          },
        }],
      },
      dispose() {},
    }),
  }
}

function activeFeature(
  featureId: string,
  contributions: FeatureContributions,
  options: {
    readonly authority?: 'core' | 'extension'
    readonly required?: boolean
  } = {},
): ActiveFeatureContributionSnapshot {
  return {
    featureId,
    provenance: {
      authority: options.authority ?? 'extension',
      required: options.required ?? false,
    },
    contributions,
  }
}

function fakeFeatureService(
  active: readonly ActiveFeatureContributionSnapshot[],
): DshTuiFeatureService {
  return {
    ready: Promise.resolve([]),
    start: async () => [],
    registerFeature: vi.fn(),
    registerCapability: vi.fn(),
    activateRoute: async () => [],
    activateCommand: async () => [],
    activateFeature: vi.fn(),
    status: () => undefined,
    contributionsFor: () => undefined,
    listActiveContributions: () => active,
  } as unknown as DshTuiFeatureService
}

const CORE_CHAT = activeFeature('legacy.chat', {
  routes: [{ id: 'chat', value: { kind: 'chat' } }],
}, { authority: 'core', required: true })

async function closeFixture(fixture: HostFixture): Promise<void> {
  await fixture.plugin.dispose()
  await fixture.root.fiber.dispose()
}

describe('DshTuiFeatureHost', () => {
  it('preserves navigation requested while startup is awaiting service readiness', async () => {
    const ready = Promise.withResolvers<readonly []>()
    const service = { ...fakeFeatureService([CORE_CHAT, activeFeature('early', {
      routes: [{ id: 'early', value: { kind: 'workspace', featureId: 'early', pane: 'content' } }],
    })]), ready: ready.promise }
    const host = new DshTuiFeatureHost(service)
    const starting = host.start()
    await Promise.resolve()
    await host.openRoute('early')
    ready.resolve([])
    await starting
    expect(host.navigation.route).toMatchObject({ featureId: 'early' })
    host.dispose()
  })

  it('reports a current activation error and ignores command activation from a previous visit', async () => {
    const pending = Promise.withResolvers<void>()
    const service = fakeFeatureService([CORE_CHAT, activeFeature('activate', {
      routes: [{ id: 'activate', value: { kind: 'workspace', featureId: 'activate', pane: 'content' } }],
      commands: [{ id: 'navigation.activate', value: { handle: vi.fn() } }],
    })])
    const route = vi.spyOn(service, 'activateRoute')
    const command = vi.spyOn(service, 'activateCommand').mockImplementation(async () => {
      await pending.promise
      return []
    })
    const host = new DshTuiFeatureHost(service)
    await host.start()
    route.mockRejectedValueOnce(new Error('route activation failed'))
    await expect(host.openRoute('activate')).rejects.toThrow('route activation failed')
    await host.openRoute('activate')
    const activating = host.dispatchTerminalAction({ type: 'submit' })
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce())
    await host.dispatchTerminalAction({ type: 'escape' }).completion
    pending.resolve()
    await activating.completion
    expect(host.navigation.route.kind).toBe('chat')
    host.dispose()
  })

  it('settles a started handler after Host disposal without publishing again', async () => {
    const fixture = await createHost()
    const pending = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    fixture.owner.service.registerFeature(workspaceFeature('dispose.workspace', {
      'navigation.activate': { handle: async () => { started.resolve(); await pending.promise } },
    }))
    await fixture.host.openRoute('dispose.workspace.route')
    const changed = vi.fn()
    fixture.host.onChanged(changed)
    const writing = fixture.host.dispatchTerminalAction({ type: 'submit' })
    await started.promise
    fixture.host.dispose()
    const count = changed.mock.calls.length
    pending.resolve()
    await writing.completion
    expect(changed).toHaveBeenCalledTimes(count)
    await closeFixture(fixture)
  })

  it('uses only declared search and pane capabilities for partial Workspace contributions', async () => {
    const host = new DshTuiFeatureHost(fakeFeatureService([CORE_CHAT, activeFeature('partial', {
      routes: [{ id: 'partial', value: { kind: 'workspace', featureId: 'partial', pane: 'content' } }],
      commands: [{ id: 'edit.insert', value: { handle() {} } }],
    })]))
    await host.start()
    const focus = { target: { kind: 'shell' }, command: { type: 'navigation.focus', direction: 'next' } } as const
    await expect(host.dispatchUiCommand('navigation.focus', focus)).resolves.toBe(false)
    await host.openRoute('partial')
    await host.dispatchTerminalAction({ type: 'insert', text: 'i' }).completion
    expect(host.navigation.mode).toBe('insert')
    await expect(host.dispatchUiCommand('navigation.focus', focus)).resolves.toBe(false)
    host.dispose()
  })
  it('keeps the rejection of a started command after leaving its surface', async () => {
    const fixture = await createHost()
    const pending = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    fixture.owner.service.registerFeature(workspaceFeature('failed.workspace', {
      'navigation.activate': { handle: async () => { started.resolve(); await pending.promise } },
    }))
    await fixture.host.openRoute('failed.workspace.route')
    const writing = fixture.host.dispatchTerminalAction({ type: 'submit' })
    const rejected = expect(writing.completion).rejects.toThrow('actual write failure')
    await started.promise
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    pending.reject(new Error('actual write failure'))
    await rejected
    expect(fixture.host.navigation.route.kind).toBe('chat')
    await closeFixture(fixture)
  })

  it.each(['escape', 'dispose'] as const)('does not restore a late failed activation after %s', async (action) => {
    const pending = Promise.withResolvers<void>()
    const service = fakeFeatureService([CORE_CHAT])
    vi.spyOn(service, 'activateRoute').mockImplementation(async id => {
      if (id !== 'chat') await pending.promise
      return []
    })
    const host = new DshTuiFeatureHost(service)
    await host.start()
    const opening = host.openRoute('slow')
    if (action === 'escape') await host.dispatchTerminalAction({ type: 'escape' }).completion
    else host.dispose()
    pending.reject(new Error('late activation failure'))
    await expect(opening).resolves.toBeUndefined()
    expect(host.navigation.route.kind).toBe('chat')
    host.dispose()
  })
  it('returns during pending work, discards old queued input, and accepts input after reopening', async () => {
    const fixture = await createHost()
    const pending = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const move = vi.fn<FeatureCommandHandler['handle']>()
    fixture.owner.service.registerFeature(workspaceFeature('pending.workspace', {
      'navigation.activate': { handle: async () => {
        started.resolve()
        await pending.promise
      } },
      'navigation.move': { handle: move },
    }))
    await fixture.host.openRoute('pending.workspace.route')
    const write = fixture.host.dispatchTerminalAction({ type: 'submit' })
    await started.promise
    const stale = fixture.host.dispatchTerminalAction({ type: 'move-down' })
    const back = fixture.host.dispatchTerminalAction({ type: 'escape' })
    // Observe navigation before releasing I/O; the old implementation queues Esc.
    const routeAfterEscape = fixture.host.navigation.route.kind
    pending.resolve()
    await Promise.all([write.completion, stale.completion, back.completion])
    expect(routeAfterEscape).toBe('chat')
    expect(move).not.toHaveBeenCalled()
    await fixture.host.openRoute('pending.workspace.route')
    await fixture.host.dispatchTerminalAction({ type: 'move-down' }).completion
    expect(move).toHaveBeenCalledOnce()
    await closeFixture(fixture)
  })

  it('ignores a previous visit callback after Escape and reopening the same Feature', async () => {
    const fixture = await createHost()
    let lateOpen!: (routeId: string) => Promise<void>
    fixture.owner.service.registerFeature(workspaceFeature('late.workspace', {
      'navigation.activate': { handle: (_command, context) => {
        lateOpen = context.openRoute
      } },
    }))
    await fixture.host.openRoute('late.workspace.route')
    await fixture.host.dispatchTerminalAction({ type: 'submit' }).completion
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    await fixture.host.openRoute('late.workspace.route')
    await lateOpen('chat')
    expect(fixture.host.navigation.route).toMatchObject({ featureId: 'late.workspace' })
    await closeFixture(fixture)
  })

  it('does not publish a late route activation after Escape', async () => {
    const pending = Promise.withResolvers<void>()
    const service = fakeFeatureService([CORE_CHAT, activeFeature('slow', {
      routes: [{ id: 'slow', value: { kind: 'workspace', featureId: 'slow', pane: 'content' } }],
    })])
    vi.spyOn(service, 'activateRoute').mockImplementation(async id => {
      if (id === 'slow') await pending.promise
      return []
    })
    const host = new DshTuiFeatureHost(service)
    await host.start()
    const opening = host.openRoute('slow')
    await Promise.resolve()
    const back = host.dispatchTerminalAction({ type: 'escape' })
    pending.resolve()
    await Promise.all([opening, back.completion])
    expect(back.handled).toBe(true)
    expect(host.navigation.route).toEqual({ kind: 'chat' })
    host.dispose()
  })

  it('finishes Workspace search without activating and exits Insert with one Escape', async () => {
    const fixture = await createHost()
    const edit = vi.fn<FeatureCommandHandler['handle']>()
    const activate = vi.fn<FeatureCommandHandler['handle']>()
    fixture.owner.service.registerFeature(workspaceFeature('search.workspace', {
      'edit.insert': { handle: edit },
      'navigation.activate': { handle: activate },
      'action.submit': { handle: activate },
    }))
    await fixture.host.openRoute('search.workspace.route')
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: '/' }).completion
    expect(fixture.host.navigation.mode).toBe('insert')
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'hjkl' }).completion
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({
      command: { type: 'edit.insert', text: 'hjkl' },
    }), expect.anything())
    await fixture.host.dispatchTerminalAction({ type: 'submit' }).completion
    expect(fixture.host.navigation.mode).toBe('normal')
    expect(activate).not.toHaveBeenCalled()
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'i' }).completion
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    expect(fixture.host.navigation.route).toEqual({ kind: 'chat' })
    await closeFixture(fixture)
  })
  it('rejects ambiguous product slot catalog configuration', () => {
    expect(() => new DshTuiFeatureHost(fakeFeatureService([]), {
      slots: [],
      slotDefinitions: [],
    })).toThrow('either slots or slotDefinitions')
  })

  it('projects the core Chat route and keeps registry-owned provenance', async () => {
    const fixture = await createHost()
    const { host, owner } = fixture
    const snapshot = host.snapshot()

    expect(snapshot.navigation).toMatchObject({
      value: 'chat',
      mode: 'insert',
      focus: { kind: 'composer' },
    })
    expect(snapshot.routes).toEqual([{
      id: 'chat',
      featureId: 'legacy.chat',
      route: { kind: 'chat' },
    }])
    expect(snapshot.regions).toEqual([expect.objectContaining({
      id: 'legacy.chat.root',
      role: 'timeline',
    })])
    expect(owner.service.listActiveContributions()).toEqual([
      expect.objectContaining({
        featureId: 'legacy.chat',
        provenance: { authority: 'core', required: true },
      }),
    ])

    await expect(host.start()).resolves.toBeUndefined()
    await closeFixture(fixture)
    host.dispose()
  })

  it('fails closed when a required raw projection bypasses the supervisor contract', async () => {
    const host = new DshTuiFeatureHost(fakeFeatureService([
      CORE_CHAT,
      activeFeature('required.invalid-command', {
        commands: [{ id: 'required.invalid-command.open', value: {} }],
      }, { required: true }),
    ]))

    await expect(host.start()).rejects.toEqual(expect.objectContaining({
      name: 'FeatureHostContractError',
      code: 'invalid-command',
      featureId: 'required.invalid-command',
    }))

    host.dispose()
  })

  it('opens a typed workspace, dispatches semantic hjkl input, and isolates provenance', async () => {
    let navigationKeys: 'arrows' | 'vim' | 'both' = 'both'
    const fixture = await createHost(() => navigationKeys)
    const handler = vi.fn<FeatureCommandHandler['handle']>()
    const changed = vi.fn()
    const stop = fixture.host.onChanged(changed)
    const registration = fixture.owner.service.registerFeature(workspaceFeature(
      'fake.workspace',
      { 'navigation.move': { handle: handler } },
    ))

    expect(fixture.host.snapshot().availableRoutes).toContainEqual({
      id: 'fake.workspace.route',
      featureId: 'fake.workspace',
    })

    await fixture.host.openRoute('fake.workspace.route')
    const snapshot = fixture.host.snapshot()
    expect(snapshot.navigation).toMatchObject({
      value: 'workspace',
      mode: 'normal',
      focus: { kind: 'feature', featureId: 'fake.workspace' },
    })
    expect(snapshot.routes.at(-1)).toMatchObject({
      featureId: 'fake.workspace',
      route: { kind: 'workspace', pane: 'navigator' },
    })
    expect(snapshot.regions.at(-1)).toMatchObject({
      id: 'fake.workspace.content',
      role: 'content',
    })
    expect(fixture.owner.service.listActiveContributions().at(-1)?.provenance).toEqual({
      authority: 'extension',
      required: false,
    })

    const dispatch = fixture.host.dispatchTerminalAction({ type: 'insert', text: 'j' })
    expect(dispatch.handled).toBe(true)
    await dispatch.completion
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'feature', featureId: 'fake.workspace' },
        command: { type: 'navigation.move', direction: 'down' },
      }),
      expect.objectContaining({ navigation: expect.objectContaining({ value: 'workspace' }) }),
    )
    expect(changed).toHaveBeenCalled()
    const calls = handler.mock.calls.length
    navigationKeys = 'arrows'
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'j' }).completion
    expect(handler).toHaveBeenCalledTimes(calls)
    await fixture.host.dispatchTerminalAction({ type: 'move-down' }).completion
    expect(handler).toHaveBeenCalledTimes(calls + 1)
    stop()
    await registration.release()
    await closeFixture(fixture)
  })

  it('supports awaited handler navigation without enqueueing itself behind itself', async () => {
    const fixture = await createHost()
    const activate: FeatureCommandHandler = {
      async handle(_command, context) {
        await context.openRoute('chat')
      },
    }
    fixture.owner.service.registerFeature(workspaceFeature(
      'reentrant.workspace',
      { 'navigation.activate': activate },
    ))
    await fixture.host.openRoute('reentrant.workspace.route')
    const command = routeUiCommand(fixture.host.navigation, {
      type: 'navigation.activate',
    })

    await expect(fixture.host.dispatchUiCommand('navigation.activate', command))
      .resolves.toBe(true)
    expect(fixture.host.navigation).toMatchObject({
      value: 'chat',
      focus: { kind: 'composer' },
    })
    await closeFixture(fixture)
  })

  it('maps the complete transitional terminal action seam without stealing shell actions', async () => {
    const fixture = await createHost()
    const handler = vi.fn<FeatureCommandHandler['handle']>()
    const commandIds = [
      'action.submit',
      'edit.complete',
      'edit.delete-backward',
      'edit.delete-forward',
      'edit.insert',
      'edit.move',
      'edit.move-boundary',
      'edit.newline',
      'navigation.activate',
      'navigation.move',
    ]
    fixture.owner.service.registerFeature(workspaceFeature(
      'keys.workspace',
      Object.fromEntries(commandIds.map(id => [id, { handle: handler }])),
    ))
    await fixture.host.openRoute('keys.workspace.route')

    for (const action of [
      { type: 'interrupt' },
      { type: 'save-default' },
      { type: 'toggle-reasoning' },
      { type: 'toggle-transcript-details' },
      { type: 'toggle-goal-actions' },
      { type: 'toggle-activity' },
    ] as const) {
      expect(fixture.host.dispatchTerminalAction(action).handled).toBe(false)
    }
    expect(fixture.host.dispatchTerminalAction({ type: 'ignored' }).handled).toBe(true)
    expect(fixture.host.dispatchTerminalAction({ type: 'insert', text: 'x' }).handled).toBe(true)

    for (const action of [
      { type: 'newline' },
      { type: 'submit' },
      { type: 'backspace' },
      { type: 'delete' },
      { type: 'move-left' },
      { type: 'move-right' },
      { type: 'move-up' },
      { type: 'move-down' },
      { type: 'complete' },
      { type: 'move-home' },
      { type: 'move-end' },
      { type: 'page-up' },
      { type: 'page-down' },
    ] as const) {
      const dispatch = fixture.host.dispatchTerminalAction(action)
      expect(dispatch.handled).toBe(true)
      await dispatch.completion
    }

    const insertMode = fixture.host.dispatchTerminalAction({ type: 'insert', text: 'i' })
    await insertMode.completion
    expect(fixture.host.navigation.mode).toBe('insert')
    expect(fixture.host.navigation.focus).toEqual({ kind: 'feature', featureId: 'keys.workspace' })
    for (const action of [
      { type: 'insert', text: 'typed' },
      { type: 'newline' },
      { type: 'submit' },
      { type: 'backspace' },
      { type: 'delete' },
      { type: 'move-left' },
      { type: 'move-right' },
      { type: 'move-up' },
      { type: 'move-down' },
      { type: 'complete' },
      { type: 'move-home' },
      { type: 'move-end' },
    ] as const) {
      const dispatch = fixture.host.dispatchTerminalAction(action)
      expect(dispatch.handled).toBe(true)
      await dispatch.completion
    }

    const setNormal = {
      target: { kind: 'shell' },
      command: { type: 'mode.set', mode: 'normal' },
    } as const
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'i' }).completion
    await expect(fixture.host.dispatchUiCommand('mode.set', setNormal)).resolves.toBe(true)
    await expect(fixture.host.dispatchUiCommand('mode.set', setNormal)).resolves.toBe(false)
    await expect(fixture.host.dispatchUiCommand('edit.insert', {
      target: { kind: 'composer' },
      command: { type: 'edit.insert', text: 'not owned here' },
    })).resolves.toBe(false)
    await expect(fixture.host.dispatchUiCommand('navigation.move', {
      target: {
        kind: 'overlay',
        overlayId: 'probe-overlay',
        featureId: 'keys.workspace',
      },
      command: { type: 'navigation.move', direction: 'down' },
    })).resolves.toBe(true)

    const hostProbe = fixture.host as unknown as { navigationState: NavigationState }
    hostProbe.navigationState = transitionNavigation(fixture.host.navigation, {
      type: 'push-overlay',
      overlay: {
        id: 'probe-overlay',
        kind: 'custom',
        featureId: 'keys.workspace',
      },
    }).state
    await expect(fixture.host.dispatchUiCommand('navigation.back', {
      target: { kind: 'shell' },
      command: { type: 'navigation.back' },
    })).resolves.toBe(true)
    expect(fixture.host.navigation.overlays).toEqual([])

    const back = fixture.host.dispatchTerminalAction({ type: 'escape' })
    await back.completion
    expect(fixture.host.navigation.route).toEqual({ kind: 'chat' })
    await expect(fixture.host.dispatchUiCommand('navigation.back', {
      target: { kind: 'shell' },
      command: { type: 'navigation.back' },
    })).resolves.toBe(true)
    expect(handler).toHaveBeenCalled()
    await closeFixture(fixture)
  })

  it('falls back to Chat and restores composer focus when an active owner unloads', async () => {
    const fixture = await createHost()
    const registration = fixture.owner.service.registerFeature(
      workspaceFeature('unloaded.workspace'),
    )
    await fixture.host.openRoute('unloaded.workspace.route')

    await registration.release()

    expect(fixture.host.navigation).toMatchObject({
      value: 'chat',
      mode: 'insert',
      focus: { kind: 'composer' },
    })
    expect(fixture.host.snapshot().routes.map(route => route.id)).toEqual(['chat'])
    await closeFixture(fixture)
  })

  it('lets an active command await its own unload without deadlocking the host queue', async () => {
    const fixture = await createHost()
    let registration!: ReturnType<DshTuiFeatureOwner['service']['registerFeature']>
    const selfUnload: FeatureCommandHandler = {
      async handle() {
        await registration.release()
      },
    }
    registration = fixture.owner.service.registerFeature(workspaceFeature(
      'self-unload.workspace',
      { 'navigation.activate': selfUnload },
    ))
    await fixture.host.openRoute('self-unload.workspace.route')

    await expect(fixture.host.dispatchUiCommand(
      'navigation.activate',
      routeUiCommand(fixture.host.navigation, { type: 'navigation.activate' }),
    )).resolves.toBe(true)
    expect(fixture.host.navigation).toMatchObject({
      value: 'chat',
      mode: 'insert',
      focus: { kind: 'composer' },
    })

    await closeFixture(fixture)
  })

  it('quarantines malformed optional contributions and rejects malformed required ones', async () => {
    const fixture = await createHost()
    const optionalDispose = vi.fn()
    const optional = fixture.owner.service.registerFeature({
      manifest: {
        id: 'optional.bad-surface',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'on-command',
        required: false,
        requires: [],
      },
      declarations: {
        commands: ['optional.open'],
        surfaces: [{ slot: 'workspace.content', cardinality: 'multiple' }],
      },
      create: () => ({
        contributions: {
          commands: [{ id: 'optional.open', value: { handle() {} } }],
          surfaces: [{
            id: 'optional.root',
            slot: 'workspace.content',
            value: { id: 'optional.root', role: 'invalid', node: {} },
          }],
        },
        dispose: optionalDispose,
      }),
    })
    const optionalCommand = {
      target: { kind: 'feature', featureId: 'optional.bad-surface' },
      command: { type: 'navigation.activate' },
    } as const
    await expect(fixture.host.dispatchUiCommand('optional.open', optionalCommand))
      .resolves.toBe(false)
    expect(fixture.owner.service.status('optional.bad-surface')).toMatchObject({
      state: 'unavailable',
    })
    expect(optionalDispose).toHaveBeenCalledOnce()
    expect(fixture.host.snapshot().issues).toEqual([])

    const resourceDispose = vi.fn()
    const malformedResource = fixture.owner.service.registerFeature({
      manifest: {
        id: 'optional.bad-resource',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'on-command',
        required: false,
        requires: [],
      },
      declarations: {
        commands: ['optional.resource.open'],
        resources: ['optional.resource'],
      },
      create: () => ({
        contributions: {
          commands: [{ id: 'optional.resource.open', value: { handle() {} } }],
          resources: [{
            id: 'optional.resource',
            value: {
              key: 'optional.resource',
              lifetime: 'session',
              activation: 'on-open',
              cachePolicy: 'none',
              load() {},
            },
          }],
        },
        dispose: resourceDispose,
      }),
    })
    await expect(fixture.host.dispatchUiCommand('optional.resource.open', {
      target: { kind: 'feature', featureId: 'optional.bad-resource' },
      command: { type: 'navigation.activate' },
    })).resolves.toBe(false)
    expect(fixture.owner.service.status('optional.bad-resource')).toMatchObject({
      state: 'unavailable',
    })
    expect(resourceDispose).toHaveBeenCalledOnce()

    const requiredDispose = vi.fn()
    const required = fixture.owner.service.registerFeature({
      manifest: {
        id: 'required.bad-command',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'on-command',
        required: true,
        requires: [],
      },
      declarations: { commands: ['required.open'] },
      create: () => ({
        contributions: {
          commands: [{ id: 'required.open', value: { nope: true } }],
        },
        dispose: requiredDispose,
      }),
    })
    const requiredCommand = {
      target: { kind: 'feature', featureId: 'required.bad-command' },
      command: { type: 'navigation.activate' },
    } as const
    await expect(fixture.host.dispatchUiCommand('required.open', requiredCommand))
      .rejects.toEqual(expect.objectContaining({
        name: 'FeatureActivationError',
        featureId: 'required.bad-command',
      }))
    expect(requiredDispose).toHaveBeenCalledOnce()

    await Promise.all([optional.release(), malformedResource.release(), required.release()])
    await closeFixture(fixture)
  })

  it('validates route, command, and surface values before publishing them', async () => {
    const malformedRouteValues: readonly unknown[] = [
      null,
      'route',
      { kind: 'unknown' },
      { kind: 'workspace', pane: 'navigator' },
      { kind: 'workspace', featureId: 'workspace.invalid-pane', pane: 'other' },
    ]
    const invalidRoutes = malformedRouteValues.map((value, index) => activeFeature(
      `bad.route.${index}`,
      { routes: [{ id: `bad.route.${index}.route`, value }] },
    ))
    const throwingRoute = new Proxy({}, {
      get() {
        throw 'non-error contribution failure'
      },
    })
    const resourceDefinition = {
      key: 'valid.resource',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: vi.fn(() => 'value'),
    } as const
    const active = [
      CORE_CHAT,
      ...invalidRoutes,
      activeFeature('bad.route.throwing', {
        routes: [{ id: 'bad.route.throwing.route', value: throwingRoute }],
      }),
      activeFeature('bad.route.chat-owner', {
        routes: [{ id: 'bad.route.chat-owner.route', value: { kind: 'chat' } }],
      }),
      activeFeature('bad.route.claim', {
        routes: [{
          id: 'bad.route.claim.route',
          value: { kind: 'workspace', featureId: 'someone.else', pane: 'content' },
        }],
      }),
      ...(['navigator', 'content', 'inspector'] as const).map(pane => activeFeature(
        `valid.workspace.${pane}`,
        { routes: [{
          id: `valid.workspace.${pane}.route`,
          value: { kind: 'workspace', featureId: `valid.workspace.${pane}`, pane },
        }] },
      )),
      activeFeature('bad.command.null', {
        commands: [{ id: 'bad.command.null.open', value: null }],
      }),
      activeFeature('bad.command.primitive', {
        commands: [{ id: 'bad.command.primitive.open', value: 'command' }],
      }),
      activeFeature('bad.command.handler', {
        commands: [{ id: 'bad.command.handler.open', value: {} }],
      }),
      activeFeature('bad.surface.null', {
        surfaces: [{ id: 'bad.surface.null', slot: 'workspace.content', value: null }],
      }),
      activeFeature('bad.surface.primitive', {
        surfaces: [{ id: 'bad.surface.primitive', slot: 'workspace.content', value: 'surface' }],
      }),
      activeFeature('bad.surface.missing-id', {
        surfaces: [{
          id: 'bad.surface.missing-id',
          slot: 'workspace.content',
          value: { role: 'content', node: {} },
        }],
      }),
      activeFeature('bad.surface.wrong-id', {
        surfaces: [{
          id: 'bad.surface.wrong-id',
          slot: 'workspace.content',
          value: { id: 'other-id', role: 'content', node: {} },
        }],
      }),
      activeFeature('bad.surface.role-type', {
        surfaces: [{
          id: 'bad.surface.role-type',
          slot: 'workspace.content',
          value: { id: 'bad.surface.role-type', role: 42, node: {} },
        }],
      }),
      activeFeature('bad.surface.role-value', {
        surfaces: [{
          id: 'bad.surface.role-value',
          slot: 'workspace.content',
          value: { id: 'bad.surface.role-value', role: 'unknown', node: {} },
        }],
      }),
      activeFeature('bad.surface.node', {
        surfaces: [{
          id: 'bad.surface.node',
          slot: 'workspace.content',
          value: { id: 'bad.surface.node', role: 'content' },
        }],
      }),
      activeFeature('valid.surface', {
        surfaces: [{
          id: 'valid.surface',
          slot: 'workspace.content',
          value: {
            id: 'valid.surface',
            role: 'content',
            node: undefined,
            constraints: { minColumns: 40 },
          },
        }],
      }),
      activeFeature('valid.resource', {
        resources: [{ id: 'valid.resource', value: resourceDefinition }],
      }),
    ]
    const host = new DshTuiFeatureHost(fakeFeatureService(active), {
      slots: [{ id: 'workspace.content', cardinality: 'list', protection: 'public' }],
    })

    await host.start()

    expect(host.snapshot().issues).toHaveLength(
      invalidRoutes.length + 3 + 3 + 7,
    )
    expect(host.snapshot().issues.find(issue => issue.featureId === 'bad.route.throwing')?.error)
      .toEqual(new Error('non-error contribution failure'))
    expect(host.snapshot().routes.filter(route => route.featureId.startsWith('valid.')))
      .toHaveLength(3)
    expect(host.snapshot().regions).toEqual([
      expect.objectContaining({ id: 'valid.surface', constraints: { minColumns: 40 } }),
    ])
    expect(host.snapshot().resources).toEqual([{
      id: 'valid.resource',
      featureId: 'valid.resource',
      definition: resourceDefinition,
    }])
    expect(resourceDefinition.load).not.toHaveBeenCalled()
    host.dispose()
  })

  it('reports missing and ambiguous route projections deterministically', async () => {
    const host = new DshTuiFeatureHost(fakeFeatureService([CORE_CHAT]))
    await host.start()
    await expect(host.openRoute('missing')).rejects.toEqual(
      expect.objectContaining<Partial<FeatureHostContractError>>({ code: 'missing-route' }),
    )
    host.dispose()

    const ambiguous = new DshTuiFeatureHost(fakeFeatureService([
      CORE_CHAT,
      activeFeature('second.chat', {
        routes: [{ id: 'chat', value: { kind: 'chat' } }],
      }, { authority: 'core' }),
    ]))
    await expect(ambiguous.start()).rejects.toEqual(
      expect.objectContaining<Partial<FeatureHostContractError>>({ code: 'ambiguous-route' }),
    )
    ambiguous.dispose()
  })

  it('does not steal Chat input and contains use after disposal', async () => {
    const fixture = await createHost()
    expect(fixture.host.dispatchTerminalAction({ type: 'insert', text: 'hello' }))
      .toBe(fixture.host.dispatchTerminalAction({ type: 'insert', text: 'again' }))
    expect(fixture.host.dispatchTerminalAction({ type: 'ignored' }).handled).toBe(false)
    const probe = fixture.host as unknown as { navigationState: NavigationState }
    probe.navigationState = {
      ...fixture.host.navigation, route: { kind: 'workspace', featureId: 'probe', pane: 'content' },
      value: 'workspace', focus: { kind: 'composer' },
    }
    expect(fixture.host.dispatchTerminalAction({ type: 'insert', text: 'typed' }).handled).toBe(false)
    probe.navigationState = transitionNavigation(fixture.host.navigation, {
      type: 'navigate', route: { kind: 'chat' },
    }).state
    probe.navigationState = transitionNavigation(fixture.host.navigation, {
      type: 'push-overlay', overlay: { id: 'probe', kind: 'custom', featureId: 'probe' },
    }).state
    expect(fixture.host.dispatchTerminalAction({ type: 'ignored' }).handled).toBe(true)
    const stopThrowingListener = fixture.host.onChanged(() => {
      throw new Error('listener failed')
    })
    await expect(fixture.host.handleActiveFeatureUnloaded({
      type: 'active-feature-unloaded',
      featureId: 'not-active',
      fallbackRoute: 'chat',
      restoreFocus: true,
    })).rejects.toThrow('listener failed')
    stopThrowingListener()
    fixture.host.dispose()
    expect(fixture.host.dispatchTerminalAction({ type: 'submit' }).handled).toBe(false)
    expect(() => fixture.host.onChanged(() => {})).toThrow('feature host is disposed')
    await expect(fixture.host.openRoute('chat')).rejects.toThrow('feature host is disposed')
    await fixture.plugin.dispose()
    await fixture.root.fiber.dispose()
  })
})
