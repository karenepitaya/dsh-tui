import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-contribution-contract.ts'
import {
  SKILLS_ACTIVATE_COMMAND_ID,
  SKILLS_CONTENT_SURFACE_ID,
  SKILLS_DETAIL_ROUTE_ID,
  SKILLS_FEATURE_ID,
  SKILLS_KEYMAP_ID,
  SKILLS_MOVE_DOWN_COMMAND_ID,
  SKILLS_MOVE_UP_COMMAND_ID,
  SKILLS_NAVIGATOR_SURFACE_ID,
  SKILLS_REFRESH_COMMAND_ID,
  SKILLS_RESOURCE_ID,
  SKILLS_ROUTE_ID,
  createSkillsContentNode,
  createSkillsFeatureModel,
  createSkillsFeatureState,
  createSkillsNavigatorNode,
  describeSkillResource,
  detachSkillsSnapshot,
  projectSkillsCatalog,
  skillsFeature,
  transitionSkillsFeature,
  type SkillsFeatureInstance,
  type SkillsFeatureStateSource,
} from '../src/features/skills/index.ts'
import { ScopeManager, type ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type { RoutedUiCommand } from '../src/navigation/commands.ts'
import { ResourceCoordinator, type ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import { SESSION_SKILLS_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import type {
  SessionSkillEntry,
  SessionSkillsPort,
  SessionSkillsSnapshot,
} from '../src/skill/port.ts'

function skill(
  name: string,
  overrides: Partial<SessionSkillEntry> = {},
): SessionSkillEntry {
  return {
    name,
    description: `${name} description`,
    modelInvocable: true,
    source: 'workspace',
    provider: 'filesystem',
    ...overrides,
  }
}

function snapshot(
  skills: readonly SessionSkillEntry[],
  overrides: Partial<SessionSkillsSnapshot> = {},
): SessionSkillsSnapshot {
  return {
    available: true,
    loading: false,
    complete: true,
    stale: false,
    generation: 1,
    skills,
    ...overrides,
  }
}

interface FakeSkillsPort extends SessionSkillsPort {
  readonly refreshSkills: ReturnType<typeof vi.fn<SessionSkillsPort['refreshSkills']>>
  readonly onSkillsChanged: ReturnType<typeof vi.fn<SessionSkillsPort['onSkillsChanged']>>
  readonly disposeSkills: ReturnType<typeof vi.fn<SessionSkillsPort['disposeSkills']>>
  setSnapshot(next: SessionSkillsSnapshot): void
  emit(): void
}

function fakePort(
  initial = snapshot([]),
  refresh: SessionSkillsPort['refreshSkills'] = async () => {},
): FakeSkillsPort {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    skillsSnapshot: () => current,
    refreshSkills: vi.fn(refresh),
    onSkillsChanged: vi.fn((listener: () => void) => {
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    }),
    disposeSkills: vi.fn(),
    setSnapshot: next => { current = next },
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

interface Fixture {
  readonly manager: ScopeManager
  readonly session: ResourceScope
  readonly instance: SkillsFeatureInstance
  readonly resource: ResourceDefinition<SessionSkillsSnapshot>
}

async function instantiate(port: SessionSkillsPort): Promise<Fixture> {
  const manager = new ScopeManager()
  const session = manager.createSession('skills-test')
  const instance = await skillsFeature.create({
    scope: session,
    dependencies: [{ token: SESSION_SKILLS_CAPABILITY, value: port }],
  }) as SkillsFeatureInstance
  const resource = instance.contributions.resources?.find(
    contribution => contribution.id === SKILLS_RESOURCE_ID,
  )?.value
  if (resource === undefined) throw new Error('missing Skills resource')
  return { manager, session, instance, resource }
}

function routed(command: RoutedUiCommand['command']): RoutedUiCommand {
  return Object.freeze({
    target: Object.freeze({ kind: 'feature' as const, featureId: SKILLS_FEATURE_ID }),
    command,
  })
}

function command(instance: SkillsFeatureInstance, id: string): FeatureCommandHandler {
  const handler = instance.contributions.commands?.find(candidate => candidate.id === id)?.value
  if (handler === undefined) throw new Error(`missing command ${id}`)
  return handler
}

const commandContext = (openRoute = vi.fn(async () => {})) => ({
  navigation: {} as never,
  openRoute,
})

describe('Skills Feature', () => {
  it('declares a lazy session-scoped workspace without touching the catalog before route activation', async () => {
    const port = fakePort(snapshot([skill('review')]))

    expect(skillsFeature.manifest).toMatchObject({
      id: SKILLS_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_SKILLS_CAPABILITY],
    })
    expect(skillsFeature.declarations).toEqual(expect.objectContaining({
      routes: [SKILLS_ROUTE_ID, SKILLS_DETAIL_ROUTE_ID],
      keymaps: [SKILLS_KEYMAP_ID],
      resources: [SKILLS_RESOURCE_ID],
    }))
    expect(port.refreshSkills).not.toHaveBeenCalled()

    const fixture = await instantiate(port)
    expect(port.refreshSkills).not.toHaveBeenCalled()
    expect(port.onSkillsChanged).not.toHaveBeenCalled()
    const surface = fixture.session.child('surface', 'skills')
    const loaded = await new ResourceCoordinator().activate(surface, fixture.resource)

    expect(loaded).toMatchObject({ phase: 'ready', value: { skills: [{ name: 'review' }] } })
    expect(port.refreshSkills).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    await surface.dispose('close')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('contributes two semantic surfaces, Vim keymaps and shell-owned Escape behavior', async () => {
    const fixture = await instantiate(fakePort())
    expect(fixture.instance.contributions.routes).toEqual([
      {
        id: SKILLS_ROUTE_ID,
        value: { kind: 'workspace', featureId: SKILLS_FEATURE_ID, pane: 'navigator' },
      },
      {
        id: SKILLS_DETAIL_ROUTE_ID,
        value: { kind: 'workspace', featureId: SKILLS_FEATURE_ID, pane: 'content' },
      },
    ])
    expect(fixture.instance.contributions.surfaces).toEqual([
      expect.objectContaining({
        id: SKILLS_NAVIGATOR_SURFACE_ID,
        slot: 'workspace.navigator',
        value: expect.objectContaining({
          role: 'navigator',
          node: expect.objectContaining({ kind: 'skills.navigator' }),
        }),
      }),
      expect.objectContaining({
        id: SKILLS_CONTENT_SURFACE_ID,
        slot: 'workspace.content',
        value: expect.objectContaining({
          role: 'content',
          node: expect.objectContaining({ kind: 'skills.content' }),
        }),
      }),
    ])
    expect(fixture.instance.contributions.keymaps).toEqual([{
      id: SKILLS_KEYMAP_ID,
      value: {
        context: { routeKind: 'workspace', featureId: SKILLS_FEATURE_ID, mode: 'normal' },
        bindings: [
          { key: 'k', commandId: SKILLS_MOVE_UP_COMMAND_ID },
          { key: 'j', commandId: SKILLS_MOVE_DOWN_COMMAND_ID },
          { key: 'enter', commandId: SKILLS_ACTIVATE_COMMAND_ID },
          { key: 'r', commandId: SKILLS_REFRESH_COMMAND_ID },
        ],
      },
    }])
    expect(fixture.instance.contributions.commands?.some(
      contribution => contribution.id === 'navigation.back',
    )).toBe(false)
    const navigatorNode = (fixture.instance.contributions.surfaces?.[0]?.value as {
      readonly node: ReturnType<typeof createSkillsNavigatorNode>
    }).node
    const contentNode = (fixture.instance.contributions.surfaces?.[1]?.value as {
      readonly node: ReturnType<typeof createSkillsContentNode>
    }).node
    expect(navigatorNode.state.snapshot().phase).toBe('idle')
    const navigatorChanged = vi.fn()
    const contentChanged = vi.fn()
    const stopNavigator = navigatorNode.onChanged(navigatorChanged)
    const stopContent = contentNode.onChanged(contentChanged)
    fixture.instance.model.dispatch({ type: 'query.changed', query: 'observe' })
    expect(navigatorChanged).toHaveBeenCalledOnce()
    expect(contentChanged).toHaveBeenCalledOnce()
    stopContent()
    stopNavigator()

    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('filters, pages, selects and opens detail through semantic commands', async () => {
    const port = fakePort(snapshot([
      skill('alpha', { description: 'first' }),
      skill('beta', { description: 'second 中文' }),
      skill('gamma', { provider: 'remote' }),
    ]))
    const fixture = await instantiate(port)
    const owner = fixture.session.child('surface', 'commands')
    await new ResourceCoordinator().activate(owner, fixture.resource)
    const openRoute = vi.fn(async () => {})
    const context = commandContext(openRoute)
    const generic = command(fixture.instance, 'navigation.move')

    await generic.handle(routed({ type: 'navigation.move', direction: 'right' }), context)
    await generic.handle(routed({ type: 'navigation.move', direction: 'down' }), context)
    expect(fixture.instance.model.snapshot().selectedName).toBe('beta')
    await command(fixture.instance, 'navigation.page').handle(
      routed({ type: 'navigation.page', direction: 'down' }),
      context,
    )
    expect(fixture.instance.model.snapshot().selectedName).toBe('gamma')
    await command(fixture.instance, SKILLS_MOVE_UP_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SKILLS_MOVE_UP_COMMAND_ID }),
      context,
    )
    await command(fixture.instance, SKILLS_MOVE_DOWN_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SKILLS_MOVE_DOWN_COMMAND_ID }),
      context,
    )
    await command(fixture.instance, 'edit.insert').handle(
      routed({ type: 'edit.insert', text: '中文' }),
      context,
    )
    expect(fixture.instance.model.snapshot()).toMatchObject({
      query: '中文',
      selectedName: 'beta',
    })
    await command(fixture.instance, 'edit.delete-backward').handle(
      routed({ type: 'edit.delete-backward' }),
      context,
    )
    expect(fixture.instance.model.snapshot().query).toBe('中')
    await command(fixture.instance, 'action.submit').handle(
      routed({ type: 'action.submit' }),
      context,
    )
    expect(openRoute).toHaveBeenLastCalledWith(SKILLS_DETAIL_ROUTE_ID)
    await command(fixture.instance, SKILLS_ACTIVATE_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SKILLS_ACTIVATE_COMMAND_ID }),
      context,
    )
    await command(fixture.instance, 'navigation.activate').handle(
      routed({ type: 'navigation.activate' }),
      context,
    )
    expect(openRoute).toHaveBeenCalledTimes(3)

    await command(fixture.instance, SKILLS_MOVE_UP_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: 'foreign.command' }),
      context,
    )
    await command(fixture.instance, 'navigation.page').handle(
      routed({ type: 'navigation.activate' }),
      context,
    )
    await generic.handle(routed({ type: 'edit.move', direction: 'left' }), context)
    await owner.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('refreshes on demand, reacts to incomplete discovery, and tears down watchers exactly once', async () => {
    const port = fakePort(snapshot([skill('stable')]))
    const fixture = await instantiate(port)
    const coordinator = new ResourceCoordinator()
    const owner = fixture.session.child('surface', 'refresh')
    await coordinator.activate(owner, fixture.resource)
    expect(port.refreshSkills).toHaveBeenCalledTimes(1)

    await command(fixture.instance, SKILLS_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SKILLS_REFRESH_COMMAND_ID }),
      commandContext(),
    )
    await vi.waitFor(() => expect(port.refreshSkills).toHaveBeenCalledTimes(2))

    port.setSnapshot(snapshot([skill('partial')], {
      complete: false,
      stale: true,
      generation: 2,
    }))
    port.emit()
    await vi.waitFor(() => expect(port.refreshSkills).toHaveBeenCalledTimes(3))
    expect(fixture.instance.model.snapshot()).toMatchObject({
      snapshot: { stale: true, skills: [{ name: 'partial' }] },
    })

    await owner.dispose('surface closed')
    const calls = port.refreshSkills.mock.calls.length
    port.emit()
    expect(port.refreshSkills).toHaveBeenCalledTimes(calls)
    await fixture.instance.dispose()
    await fixture.instance.dispose()
    port.emit()
    expect(port.onSkillsChanged).toHaveBeenCalledOnce()
    expect(port.disposeSkills).not.toHaveBeenCalled()
    expect(() => fixture.instance.model.onChanged(() => {})).toThrow('disposed')
    await fixture.manager.dispose()
  })

  it('keeps last-good state on failure and ignores out-of-order loader results', async () => {
    const port = fakePort(snapshot([skill('stable')]))
    const fixture = await instantiate(port)
    const coordinator = new ResourceCoordinator()
    const owner = fixture.session.child('surface', 'last-good')
    const initial = await coordinator.activate(owner, fixture.resource)
    expect(initial.value?.skills[0]?.name).toBe('stable')

    port.refreshSkills.mockRejectedValueOnce(new Error('filesystem unavailable'))
    const failed = await coordinator.refresh(owner, fixture.resource)
    expect(failed).toMatchObject({
      phase: 'failed',
      value: { skills: [{ name: 'stable' }] },
      lastGood: { skills: [{ name: 'stable' }] },
      error: expect.objectContaining({ message: 'filesystem unavailable' }),
    })
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'filesystem unavailable',
      snapshot: { skills: [{ name: 'stable' }] },
    })

    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let call = 0
    port.refreshSkills.mockImplementation(async () => gates[call++]!.promise)
    const manualOne = fixture.session.child('surface', 'manual-one')
    const first = fixture.resource.load({
      scope: manualOne,
      signal: new AbortController().signal,
      requestId: 10,
      previous: initial.value,
    })
    const manualTwo = fixture.session.child('surface', 'manual-two')
    const second = fixture.resource.load({
      scope: manualTwo,
      signal: new AbortController().signal,
      requestId: 11,
      previous: initial.value,
    })
    port.setSnapshot(snapshot([skill('newest')], { generation: 3 }))
    gates[1]!.resolve()
    await second
    port.setSnapshot(snapshot([skill('late')], { generation: 2 }))
    gates[0]!.resolve()
    await first
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'ready',
      snapshot: { skills: [{ name: 'newest' }] },
    })

    await manualTwo.dispose('done')
    await manualOne.dispose('done')
    await owner.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('contains aborted loads and failing external snapshots without replacing last-good state', async () => {
    const gate = Promise.withResolvers<void>()
    const port = fakePort(snapshot([skill('stable')]), async signal => {
      await gate.promise
      signal?.throwIfAborted()
    })
    const fixture = await instantiate(port)
    const scope = fixture.session.child('surface', 'abort')
    const abort = new AbortController()
    const pending = fixture.resource.load({
      scope,
      signal: abort.signal,
      requestId: 1,
      previous: undefined,
    })
    abort.abort(new Error('surface closed'))
    gate.resolve()
    await expect(pending).rejects.toThrow('surface closed')
    expect(fixture.instance.model.snapshot().phase).toBe('loading')

    const stopWatch = fixture.resource.watch?.({
      scope,
      signal: scope.signal,
      invalidate: vi.fn(),
    })
    const broken = port as FakeSkillsPort & { skillsSnapshot: () => SessionSkillsSnapshot }
    broken.skillsSnapshot = () => { throw 'snapshot unavailable' }
    port.emit()
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'snapshot unavailable',
    })
    if (typeof stopWatch === 'function') await stopWatch()

    const stopped = new AbortController()
    const stopAbortedWatch = fixture.resource.watch?.({
      scope,
      signal: stopped.signal,
      invalidate: vi.fn(),
    })
    stopped.abort('closed')
    port.emit()
    if (typeof stopAbortedWatch === 'function') await stopAbortedWatch()

    await scope.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('projects bounded safe navigator and detail views for every resource kind', () => {
    const catalog = snapshot([
      skill('directory', {
        description: `查看中文\u001b[31m${'长'.repeat(40)}`,
        whenToUse: 'When reviewing files',
        resourceBase: { kind: 'directory', path: 'D:\\项目\\skills\\review' },
      }),
      skill('remote', { resourceBase: { kind: 'url', url: 'https://example.test/skill' } }),
      skill('opaque', {
        modelInvocable: false,
        resourceBase: { kind: 'opaque', description: 'bundled resource' },
      }),
      skill('plain'),
    ])
    const model = createSkillsFeatureModel()
    model.dispatch({ type: 'load.started', request: { scopeEpoch: 1, requestId: 1 } })
    model.dispatch({
      type: 'load.succeeded',
      request: { scopeEpoch: 1, requestId: 1 },
      snapshot: catalog,
    })
    const source: SkillsFeatureStateSource = {
      snapshot: () => model.snapshot(),
      onChanged: listener => model.onChanged(listener),
    }
    const navigator = createSkillsNavigatorNode(source)
    const content = createSkillsContentNode(source)
    const context = {
      bounds: { x: 0, y: 0, width: 36, height: 8 },
      focus: true,
      mode: 'normal',
      resources: [],
    }
    const changed = vi.fn()
    const stop = navigator.onChanged(changed)
    const navigation = navigator.project(context)
    const detail = content.project(context)
    expect(navigation.rows[0]?.text).toBe('4/4 available skills')
    expect(navigation.rows.some(row => row.text.includes('\u001b'))).toBe(false)
    expect(detail.rows.map(row => row.text)).toEqual(expect.arrayContaining([
      'directory',
      'WHEN TO USE',
    ]))
    expect(content.scroll?.(100)).toBe(true)
    expect(content.project(context).rows.map(row => row.text)).toContain('DIRECTORY  D:\\项目\\skills\\review')

    for (let index = 0; index < 4; index += 1) {
      model.dispatch({ type: 'selection.move', direction: 'down' })
      const rows = content.project(context).rows.map(row => row.text)
      expect(rows.join(' ')).not.toContain('\u001b')
    }
    expect(describeSkillResource(catalog.skills[0]!)).toBe('D:\\项目\\skills\\review')
    expect(describeSkillResource(catalog.skills[1]!)).toBe('https://example.test/skill')
    expect(describeSkillResource(catalog.skills[2]!)).toBe('bundled resource')
    expect(describeSkillResource(catalog.skills[3]!)).toBeUndefined()
    expect(changed).toHaveBeenCalled()
    stop()
    stop()
    model.dispose()
  })

  it('covers empty, loading, unavailable, filtered, stale and failed projections', () => {
    const model = createSkillsFeatureModel()
    const source: SkillsFeatureStateSource = {
      snapshot: () => model.snapshot(),
      onChanged: listener => model.onChanged(listener),
    }
    const navigator = createSkillsNavigatorNode(source)
    const content = createSkillsContentNode(source)
    const context = (phase: 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed') => ({
      bounds: { x: 0, y: 0, width: 80, height: 12 },
      focus: true,
      mode: 'normal',
      resources: [{ id: SKILLS_RESOURCE_ID, phase }],
    })
    expect(navigator.project(context('loading')).rows.at(-1)?.text).toContain('Discovering')
    expect(content.project(context('refreshing')).rows[0]?.text).toContain('Loading')
    const noResource = {
      bounds: { x: 0, y: 0, width: 80, height: 12 },
      focus: true,
      mode: 'normal',
      resources: [],
    }
    expect(navigator.project(noResource).rows.at(-1)?.text).toContain('No user-invocable')
    expect(content.project(noResource).rows[0]?.text).toContain('Select a skill')

    const request = { scopeEpoch: 1, requestId: 1 }
    model.dispatch({ type: 'load.started', request })
    model.dispatch({
      type: 'load.succeeded',
      request,
      snapshot: snapshot([], { available: false }),
    })
    expect(navigator.project(context('ready')).rows.at(-1)?.text).toContain('unavailable')
    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot([skill('alpha')], { stale: true, complete: false }),
    })
    model.dispatch({ type: 'query.changed', query: 'missing' })
    expect(navigator.project(context('ready')).rows.map(row => row.text).join(' ')).toContain('No skills match')
    model.dispatch({ type: 'snapshot.failed', message: 'broken catalog' })
    expect(navigator.project(context('failed')).rows.map(row => row.text).join(' ')).toContain('broken catalog')

    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot(Array.from({ length: 8 }, (_, index) => skill(`skill-${index}`))),
    })
    model.dispatch({ type: 'query.changed', query: '' })
    const tiny = {
      bounds: { x: 0, y: 0, width: 32, height: 2 },
      focus: true,
      mode: 'normal',
      resources: [],
    }
    expect(navigator.project(tiny).rows).toHaveLength(2)
    const windowed = {
      ...tiny,
      bounds: { ...tiny.bounds, height: 4 },
    }
    expect(navigator.project(windowed).rows).toHaveLength(4)
    model.dispose()
  })

  it('keeps machine transitions exhaustive, stable and detached', () => {
    const raw = snapshot([
      skill('alpha', { resourceBase: { kind: 'directory', path: 'D:\\alpha' } }),
      skill('beta'),
    ])
    const detached = detachSkillsSnapshot(raw)
    expect(detached).not.toBe(raw)
    expect(detached.skills).not.toBe(raw.skills)
    expect(Object.isFrozen(detached.skills[0]?.resourceBase)).toBe(true)
    expect(projectSkillsCatalog(detached, 'ALPHA workspace')).toMatchObject({
      rows: [{ name: 'alpha' }],
      totalCount: 2,
    })
    expect(projectSkillsCatalog(undefined, '')).toEqual({ rows: [], totalCount: 0 })

    let state = createSkillsFeatureState()
    expect(transitionSkillsFeature(state, { type: 'selection.activated' }).state).toBe(state)
    expect(transitionSkillsFeature(state, {
      type: 'selection.move', direction: 'down', amount: 0,
    }).state).toBe(state)
    const first = { scopeEpoch: 1, requestId: 1 }
    const second = { scopeEpoch: 1, requestId: 2 }
    state = transitionSkillsFeature(state, { type: 'load.started', request: first }).state
    expect(state.phase).toBe('loading')
    state = transitionSkillsFeature(state, {
      type: 'snapshot.changed', snapshot: snapshot([skill('during-load')]),
    }).state
    expect(state).toMatchObject({ phase: 'loading', snapshot: { skills: [{ name: 'during-load' }] } })
    expect(transitionSkillsFeature(state, {
      type: 'load.succeeded', request: second, snapshot: raw,
    }).state).toBe(state)
    expect(transitionSkillsFeature(state, {
      type: 'load.failed', request: second, message: 'late',
    }).state).toBe(state)
    state = transitionSkillsFeature(state, {
      type: 'load.succeeded', request: first, snapshot: raw,
    }).state
    expect(state).toMatchObject({ phase: 'ready', selectedName: 'alpha' })
    const errorRequest = { scopeEpoch: 1, requestId: 3 }
    state = transitionSkillsFeature(state, { type: 'load.started', request: errorRequest }).state
    state = transitionSkillsFeature(state, {
      type: 'load.succeeded',
      request: errorRequest,
      snapshot: snapshot([skill('alpha'), skill('beta')], { error: 'reported failure' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'reported failure' })
    state = transitionSkillsFeature(state, { type: 'load.started', request: second }).state
    expect(state.phase).toBe('refreshing')
    state = transitionSkillsFeature(state, {
      type: 'load.failed', request: second, message: 'failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', selectedName: 'alpha', error: 'failed' })
    expect(transitionSkillsFeature(state, { type: 'query.changed', query: '' }).state).toBe(state)
    state = transitionSkillsFeature(state, { type: 'selection.move', direction: 'down' }).state
    expect(state.selectedName).toBe('beta')
    expect(transitionSkillsFeature(state, { type: 'selection.move', direction: 'down' }).state).toBe(state)
    state = transitionSkillsFeature(state, {
      type: 'selection.move', direction: 'up', amount: Number.NaN,
    }).state
    expect(state.selectedName).toBe('alpha')
    expect(transitionSkillsFeature(state, { type: 'selection.activated' }).effects).toEqual([{
      type: 'route.open', routeId: SKILLS_DETAIL_ROUTE_ID,
    }])
    expect(transitionSkillsFeature(state, { type: 'refresh.requested' }).effects).toEqual([{
      type: 'resource.refresh', resourceId: SKILLS_RESOURCE_ID,
    }])
    state = transitionSkillsFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot([skill('alpha')], { error: 'adapter failure' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'adapter failure' })
  })

  it('isolates state and effect observers from failures and disposal', () => {
    const model = createSkillsFeatureModel()
    const changed = vi.fn()
    const effect = vi.fn()
    const stopChanged = model.onChanged(changed)
    const stopEffect = model.onEffect(effect)
    model.onChanged(() => { throw new Error('renderer failed') })
    model.onEffect(() => { throw new Error('observer failed') })
    model.dispatch({ type: 'query.changed', query: 'a' })
    model.dispatch({ type: 'refresh.requested' })
    expect(changed).toHaveBeenCalledOnce()
    expect(effect).toHaveBeenCalledExactlyOnceWith({
      type: 'resource.refresh', resourceId: SKILLS_RESOURCE_ID,
    })
    stopChanged()
    stopChanged()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.dispatch({ type: 'query.changed', query: 'b' })).toThrow('disposed')
    expect(() => model.onEffect(() => {})).toThrow('disposed')
  })
})
