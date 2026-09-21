import { describe, expect, it, vi } from 'vitest'
import { DshTuiFeatureHost } from '../src/app/feature-host.ts'
import { FeatureSurfaceRuntime } from '../src/app/feature-surface-runtime.ts'
import type { FeatureInstance } from '../src/kernel/feature.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import { ScopeManager, type ResourceScope } from '../src/lifecycle/scope-manager.ts'
import { modelsFeature, type ModelsFeatureInstance } from '../src/features/models/factory.ts'
import { modesFeature, type ModesFeatureInstance } from '../src/features/modes/factory.ts'
import { SESSION_AGENT_STATUS_CAPABILITY, SESSION_MODELS_CAPABILITY, SESSION_MODES_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import type { SessionModelPort, SessionModelSnapshot } from '../src/model/port.ts'
import type { SessionModePort, SessionModeSnapshot } from '../src/mode/port.ts'
import { decodeTerminalInput } from '../src/terminal/input.ts'
import { capabilitiesFeature, type CapabilitiesFeatureInstance } from '../src/features/capabilities/factory.ts'
import { SESSION_SKILLS_CAPABILITY, SESSION_TOOLS_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import { renderFeatureSurfaceFrame } from '../src/ui/feature-surface-frame.ts'
import { sessionsFeature, type SessionsFeatureInstance } from '../src/features/sessions/factory.ts'
import { SESSIONS_WORKSPACE_CAPABILITY } from '../src/features/sessions/port.ts'
import { projectSessionsCatalog } from '../src/features/sessions/machine.ts'
import { SESSION_NAVIGATION_CAPABILITY } from '../src/session/navigation-port.ts'

async function mount(instance: FeatureInstance, featureId: string, session: ResourceScope, routeId = featureId) {
  const service = {
    ready: Promise.resolve([]),
    activateRoute: async () => [],
    activateCommand: async () => [],
    listActiveContributions: () => [{
      featureId: 'legacy.chat', provenance: { authority: 'core', required: true },
      contributions: { routes: [{ id: 'chat', value: { kind: 'chat' } }] },
    }, {
      featureId, provenance: { authority: 'extension', required: false },
      contributions: instance.contributions,
    }],
  } as unknown as DshTuiFeatureService
  const host = new DshTuiFeatureHost(service)
  await host.start()
  const surfaces = new FeatureSurfaceRuntime(host)
  const lease = surfaces.bindSession(session, { columns: 140, rows: 35 })
  await lease.ready
  await host.openRoute(routeId)
  await lease.settled()
  return { host, lease, close: async () => {
    host.dispose()
    await surfaces.dispose()
    await instance.dispose()
  } }
}

describe('Feature Host Workspace input and operation ownership', () => {
  it('searches real Sessions without activation and scrolls complete details across breakpoints before one Escape', async () => {
    const manager = new ScopeManager()
    const read = vi.fn(async () => ({ durability: 'available' as const, sessions: Array.from({ length: 12 }, (_, index) => ({
      sessionId: index === 11 ? 'rf-target' : `session-${index}`, createdAt: index, isSubagent: false, attached: true,
      durablePresence: 'observed' as const, cwd: `${'D:\\项目\\long-path '.repeat(100)}PATH_END`,
    })) }))
    const inspect = vi.fn(async () => { throw new Error('inspection must remain lazy') })
    const navigate = vi.fn(async () => {})
    const instance = await sessionsFeature.create({ scope: manager.app, dependencies: [
      { token: SESSIONS_WORKSPACE_CAPABILITY, value: { catalog: { listSessions: read }, inspection: { inspectSession: inspect }, activation: { activateSession: vi.fn() }, fork: { forkSession: vi.fn() } } },
      { token: SESSION_NAVIGATION_CAPABILITY, value: { snapshot: () => ({ sessionId: 'session-0', busy: false }), navigate } },
    ] }) as SessionsFeatureInstance
    const fixture = await mount(instance, 'sessions', manager.createSession('sessions-host'))
    let viewport = { columns: 80, rows: 12 }
    const render = () => renderFeatureSurfaceFrame(fixture.lease.snapshot(), viewport).lines.join('\n')
    try {
      await vi.waitFor(() => expect(projectSessionsCatalog(instance.model.snapshot()).totalCount).toBe(12))
      await fixture.lease.resize(viewport)
      expect(fixture.host.navigation).toMatchObject({ mode: 'normal', route: { pane: 'navigator' } })
      await fixture.host.dispatchTerminalAction({ type: 'insert', text: '/' }).completion
      await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'rf' }).completion
      expect(projectSessionsCatalog(instance.model.snapshot())).toMatchObject({ filteredCount: 1, selectedSessionId: 'rf-target' })
      await fixture.host.dispatchTerminalAction({ type: 'submit' }).completion
      expect(fixture.host.navigation).toMatchObject({ mode: 'normal', route: { pane: 'navigator' } })
      expect(navigate).not.toHaveBeenCalled()
      await fixture.host.dispatchTerminalAction({ type: 'complete' }).completion
      await fixture.lease.settled()
      expect(fixture.host.navigation.route).toMatchObject({ pane: 'content' })
      const before = render()
      await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'j' }).completion
      for (let index = 0; index < 10; index += 1) await fixture.host.dispatchTerminalAction({ type: 'page-down' }).completion
      await fixture.lease.settled()
      expect(render()).not.toBe(before)
      expect(render()).toContain('PATH_END')
      expect(projectSessionsCatalog(instance.model.snapshot()).selectedSessionId).toBe('rf-target')
      for (const columns of [100, 140, 200, 80]) {
        viewport = { columns, rows: 12 }
        await fixture.lease.resize(viewport)
        expect(render()).toContain('Esc back')
      }
      await fixture.host.dispatchTerminalAction({ type: 'complete', reverse: true }).completion
      expect(fixture.host.navigation.route).toMatchObject({ pane: 'navigator' })
      await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'i' }).completion
      await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
      expect(fixture.host.navigation.route.kind).toBe('chat')
      expect(read).toHaveBeenCalledOnce()
      expect(inspect).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
      await manager.dispose()
    }
  })
  it('scrolls actual Tools details via j/k and PageDown without moving selection or reloading on 100 resizes', async () => {
    const manager = new ScopeManager()
    const read = vi.fn(() => ({ available: true, stale: false, generation: 1,
      tools: Array.from({ length: 200 }, (_, index) => ({ name: `tool_${String(index).padStart(3, '0')}`,
        description: Array.from({ length: 60 }, (_, line) => `Description line ${line}`).join('\n'),
        group: 'core' as const, parameterNames: [], requiredParameterNames: [],
      })),
    }))
    const instance = await capabilitiesFeature.create({ scope: manager.app, dependencies: [
      { token: SESSION_SKILLS_CAPABILITY, value: {
        skillsSnapshot: () => ({ available: true, complete: true, loading: false, stale: false, generation: 1, skills: [] }),
        refreshSkills: async () => {}, onSkillsChanged: () => () => {}, disposeSkills() {},
      } },
      { token: SESSION_TOOLS_CAPABILITY, value: { toolsSnapshot: read, onToolsChanged: () => () => {}, disposeTools() {} } },
    ] }) as CapabilitiesFeatureInstance
    const fixture = await mount(instance, 'capabilities', manager.createSession('tools-scroll'))
    await vi.waitFor(() => expect(instance.model.snapshot().tools.phase).toBe('ready'))
    instance.model.dispatch({ type: 'tab.set', tab: 'tools' })
    const render = () => renderFeatureSurfaceFrame(fixture.lease.snapshot(), { columns: 140, rows: 35 }).lines.join('\n')
    for (let index = 0; index < 199; index += 1) await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'j' }).completion
    await fixture.lease.settled()
    expect(render()).toContain('› tool_199')
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'k' }).completion
    const selected = instance.model.snapshot().tools.browser.selectedIndex
    await fixture.host.dispatchTerminalAction({ type: 'complete' }).completion
    await fixture.lease.settled()
    render()
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'j' }).completion
    await fixture.lease.settled()
    expect(instance.model.snapshot().tools.browser.selectedIndex).toBe(selected)
    const afterScroll = render()
    expect(afterScroll).toContain('Description line 0')
    expect(afterScroll).toContain('Description line 32')
    await fixture.host.dispatchTerminalKey({ type: 'named', key: 'page-down' }).completion
    await fixture.lease.settled()
    expect(render()).toContain('Description line 40')
    const readCount = read.mock.calls.length
    for (let index = 0; index < 100; index += 1) await fixture.lease.resize({ columns: 100 + index % 80, rows: 35 })
    expect(read).toHaveBeenCalledTimes(readCount)
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'k' }).completion
    expect(instance.model.snapshot().tools.browser.selectedIndex).toBe(selected)
    await fixture.close()
    await manager.dispose()
  })
  it.each(['success', 'failure'] as const)('keeps Mode selection settlement after leaving its Surface: %s', async (outcome) => {
    const manager = new ScopeManager()
    const session = manager.createSession('modes')
    const pending = Promise.withResolvers<void>()
    let snapshot: SessionModeSnapshot = {
      available: true, current: 'one', loading: false, selecting: false, locked: false,
      presets: ['one', 'two'].map(id => ({ id, trust: 'system', sourcePath: `${id}.yaml`, isDefault: id === 'one' })),
    }
    const port: SessionModePort = {
      modeSnapshot: () => snapshot, refreshModes: async () => {}, onModesChanged: () => () => {}, disposeModes() {},
      selectMode: vi.fn(async id => {
        await pending.promise
        if (outcome === 'failure') throw new Error('mode selection failed')
        snapshot = { ...snapshot, current: id }
      }),
    }
    const instance = await modesFeature.create({ scope: session, dependencies: [
      { token: SESSION_MODES_CAPABILITY, value: port },
    ] }) as ModesFeatureInstance
    const fixture = await mount(instance, 'modes', session)
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('ready'))
    await fixture.host.dispatchTerminalAction({ type: 'move-down' }).completion
    const writing = fixture.host.dispatchTerminalAction({ type: 'submit' })
    await vi.waitFor(() => expect(port.selectMode).toHaveBeenCalledOnce())
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    expect(fixture.host.navigation.route.kind).toBe('chat')
    expect(vi.mocked(port.selectMode).mock.calls[0]![1]?.signal?.aborted).toBe(false)
    expect(instance.model.snapshot().selecting).toBe(true)
    pending.resolve()
    await writing.completion
    expect(instance.model.snapshot().selecting).toBe(false)
    if (outcome === 'success') expect(snapshot.current).toBe('two')
    else expect(instance.model.snapshot().error).toBe('mode selection failed')
    expect(fixture.host.navigation.route.kind).toBe('chat')
    await fixture.close()
    await manager.dispose()
  })
  it.each(['success', 'failure'] as const)('keeps an in-flight model default write truthful after Escape: %s', async (outcome) => {
    const manager = new ScopeManager()
    const session = manager.createSession('models')
    const pending = Promise.withResolvers<void>()
    let snapshot: SessionModelSnapshot = {
      current: { provider: 'test', model: 'one' },
      routable: true, writable: true, loading: false, selecting: false, failures: [],
      groups: [{ id: 'test', name: 'Test', models: ['one', 'two'].map(id => ({
        provider: 'test', providerName: 'Test', id, name: id, efforts: [],
      })) }],
    }
    const port: SessionModelPort = {
      modelSnapshot: () => snapshot,
      refreshModels: async () => {},
      selectModel: vi.fn(async (selection, options) => {
        await pending.promise
        if (outcome === 'failure') throw new Error('default write failed')
        snapshot = { ...snapshot, current: selection, ...(options?.saveDefault ? { defaultSelection: selection } : {}) }
      }),
      onModelsChanged: () => () => {},
      disposeModels() {},
    }
    const instance = await modelsFeature.create({ scope: session, dependencies: [
      { token: SESSION_MODELS_CAPABILITY, value: port },
      { token: SESSION_AGENT_STATUS_CAPABILITY, value: { snapshot: () => ({ status: 'idle' as const }), onChanged: () => () => {} } },
    ] }) as ModelsFeatureInstance
    const fixture = await mount(instance, 'models', session)
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('ready'))
    await fixture.host.dispatchTerminalAction({ type: 'move-down' }).completion
    const writing = fixture.host.dispatchTerminalAction({ type: 'save-default' })
    await vi.waitFor(() => expect(port.selectModel).toHaveBeenCalledOnce())
    const oldMove = fixture.host.dispatchTerminalAction({ type: 'move-down' })
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    await fixture.lease.settled()
    expect(fixture.host.navigation.route.kind).toBe('chat')
    expect(instance.model.snapshot().selecting).toBe(true)
    const options = vi.mocked(port.selectModel).mock.calls[0]![1]!
    expect(options.signal?.aborted).toBe(false)
    expect(options.saveDefault).toBe(true)
    await fixture.host.openRoute('models')
    await fixture.host.dispatchTerminalAction({ type: 'move-up' }).completion
    expect(instance.model.snapshot().selectedIndex).toBe(0)
    pending.resolve()
    await Promise.all([writing.completion, oldMove.completion])
    expect(instance.model.snapshot().selecting).toBe(false)
    expect(fixture.host.navigation.route).toMatchObject({ featureId: 'models' })
    if (outcome === 'success') expect(snapshot.defaultSelection?.model).toBe('two')
    else expect(instance.model.snapshot().error).toBe('default write failed')
    expect(port.selectModel).toHaveBeenCalledOnce()
    await fixture.close()
    await manager.dispose()
  })

  it('cycles real Workspace regions with Tab/ShiftTab and reserves h/l before Feature bindings', async () => {
    const manager = new ScopeManager()
    const handle = vi.fn()
    const fixture = await mount({ contributions: {
      routes: [{ id: 'panes', value: { kind: 'workspace', featureId: 'panes', pane: 'navigator' } }],
      commands: [{ id: 'danger', value: { handle } }],
      keymaps: [{ id: 'panes.normal', value: {
        context: { routeKind: 'workspace', featureId: 'panes', mode: 'normal' },
        bindings: [{ key: 'h', commandId: 'danger' }, { key: 'l', commandId: 'danger' }, { key: 'escape', commandId: 'danger' }],
      } }],
      surfaces: ['navigator', 'content', 'inspector'].map(role => ({
        id: `panes.${role}`, slot: `workspace.${role}`, value: { id: `panes.${role}`, role, node: {} },
      })),
    }, dispose() {} }, 'panes', manager.createSession('panes'))
    await fixture.host.dispatchTerminalAction(decodeTerminalInput('\t')).completion
    expect(fixture.host.navigation.route).toMatchObject({ pane: 'content' })
    await fixture.host.dispatchTerminalAction(decodeTerminalInput('\x1b[Z')).completion
    expect(fixture.host.navigation.route).toMatchObject({ pane: 'navigator' })
    await fixture.host.dispatchTerminalAction({ type: 'insert', text: 'h' }).completion
    expect(fixture.host.navigation.route).toMatchObject({ pane: 'inspector' })
    await fixture.host.dispatchTerminalAction({ type: 'escape' }).completion
    expect(handle).not.toHaveBeenCalled()
    await fixture.close()
    await manager.dispose()
  })
})
