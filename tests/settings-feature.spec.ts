import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-contribution-contract.ts'
import {
  SETTINGS_ACTIVATE_COMMAND_ID,
  SETTINGS_CONTENT_SURFACE_ID,
  SETTINGS_CYCLE_NEXT_COMMAND_ID,
  SETTINGS_CYCLE_PREVIOUS_COMMAND_ID,
  SETTINGS_FEATURE_ID,
  SETTINGS_FIELD_IDS,
  SETTINGS_KEYMAP_ID,
  SETTINGS_MOVE_DOWN_COMMAND_ID,
  SETTINGS_MOVE_UP_COMMAND_ID,
  SETTINGS_REFRESH_COMMAND_ID,
  SETTINGS_RESOURCE_ID,
  SETTINGS_ROUTE_ID,
  createSettingsContentNode,
  createSettingsFeatureModel,
  createSettingsFeatureState,
  cycleSettingsPreference,
  detachSettingsFeatureSnapshot,
  projectSettingsRows,
  settingsFeature,
  transitionSettingsFeature,
  type DshTuiPreferencesApplicationPort,
  type DshTuiPreferencesApplicationStatus,
  type SettingsFeatureInstance,
  type SettingsFeatureSnapshot,
  type SettingsFeatureStateSource,
} from '../src/features/settings/index.ts'
import { DSH_TUI_PREFERENCES_CAPABILITY } from '../src/features/settings/port.ts'
import { ScopeManager, type ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type { RoutedUiCommand } from '../src/navigation/commands.ts'
import {
  DEFAULT_DSH_TUI_PREFERENCES,
  type DshTuiPreferencesV1,
} from '../src/preferences/contracts.ts'
import {
  ResourceCoordinator,
  type ResourceDefinition,
} from '../src/resource/resource-coordinator.ts'

function preferences(
  overrides: Partial<DshTuiPreferencesV1> = {},
): DshTuiPreferencesV1 {
  return {
    ...DEFAULT_DSH_TUI_PREFERENCES,
    ...overrides,
    theme: {
      ...DEFAULT_DSH_TUI_PREFERENCES.theme,
      ...overrides.theme,
    },
  }
}

interface FakePreferencesPort extends DshTuiPreferencesApplicationPort {
  readonly status: ReturnType<typeof vi.fn<() => DshTuiPreferencesApplicationStatus>>
  readonly read: ReturnType<typeof vi.fn<DshTuiPreferencesApplicationPort['read']>>
  readonly write: ReturnType<typeof vi.fn<DshTuiPreferencesApplicationPort['write']>>
  readonly onChanged: ReturnType<typeof vi.fn<DshTuiPreferencesApplicationPort['onChanged']>>
  setStatus(next: DshTuiPreferencesApplicationStatus): void
  setPreferences(next: DshTuiPreferencesV1, revision?: number): void
  emit(): void
}

function fakePort(options: {
  readonly status?: DshTuiPreferencesApplicationStatus
  readonly preferences?: DshTuiPreferencesV1
  readonly revision?: number
} = {}): FakePreferencesPort {
  let currentStatus = options.status ?? {
    available: true,
    writable: true,
    documentBacked: true,
  }
  let current = {
    revision: options.revision ?? 2,
    preferences: options.preferences ?? preferences(),
  }
  const listeners = new Set<() => void>()
  const status = vi.fn(() => currentStatus)
  const read = vi.fn(async () => current)
  const write = vi.fn(async (
    expectedRevision: number,
    next: DshTuiPreferencesV1,
  ) => {
    if (!currentStatus.available) throw new Error('Settings unavailable')
    if (!currentStatus.writable) throw new Error('Settings read-only')
    if (expectedRevision !== current.revision) {
      throw new Error(`CAS conflict: expected ${expectedRevision}, actual ${current.revision}`)
    }
    current = { revision: current.revision + 1, preferences: next }
    for (const listener of [...listeners]) listener()
    return current
  })
  const onChanged = vi.fn((listener: () => void) => {
    listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
    }
  })
  return {
    status,
    read,
    write,
    onChanged,
    setStatus: next => { currentStatus = next },
    setPreferences: (next, revision = current.revision + 1) => {
      current = { revision, preferences: next }
    },
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

interface Fixture {
  readonly manager: ScopeManager
  readonly instance: SettingsFeatureInstance
  readonly session: ResourceScope
  readonly resource: ResourceDefinition<SettingsFeatureSnapshot>
}

async function instantiate(port: DshTuiPreferencesApplicationPort): Promise<Fixture> {
  const manager = new ScopeManager()
  const instance = await settingsFeature.create({
    scope: manager.app,
    dependencies: [{ token: DSH_TUI_PREFERENCES_CAPABILITY, value: port }],
  }) as SettingsFeatureInstance
  const resource = instance.contributions.resources?.find(
    contribution => contribution.id === SETTINGS_RESOURCE_ID,
  )?.value
  if (resource === undefined) throw new Error('missing Settings resource')
  return {
    manager,
    instance,
    session: manager.createSession('settings-test'),
    resource,
  }
}

function routed(command: RoutedUiCommand['command']): RoutedUiCommand {
  return Object.freeze({
    target: Object.freeze({ kind: 'feature' as const, featureId: SETTINGS_FEATURE_ID }),
    command,
  })
}

function command(instance: SettingsFeatureInstance, id: string): FeatureCommandHandler {
  const handler = instance.contributions.commands?.find(candidate => candidate.id === id)?.value
  if (handler === undefined) throw new Error(`missing command ${id}`)
  return handler
}

const commandContext = {
  navigation: {} as never,
  openRoute: vi.fn(async () => {}),
}

describe('Settings Feature', () => {
  it('does not enter editing before preferences load', () => {
    expect(transitionSettingsFeature(createSettingsFeatureState(), { type: 'editing.toggle' }).state)
      .toMatchObject({ editing: false, error: 'Preferences are not loaded' })
  })
  it('declares one lazy application preference workspace and performs zero IO before opening', async () => {
    const port = fakePort()
    expect(SETTINGS_ROUTE_ID).toBe('preferences')
    expect(settingsFeature.manifest).toMatchObject({
      id: SETTINGS_FEATURE_ID,
      scope: 'application',
      activation: 'on-route',
      required: false,
      requires: [DSH_TUI_PREFERENCES_CAPABILITY],
    })
    expect(settingsFeature.declarations).toEqual(expect.objectContaining({
      routes: [SETTINGS_ROUTE_ID],
      keymaps: [SETTINGS_KEYMAP_ID],
      resources: [SETTINGS_RESOURCE_ID],
    }))

    const fixture = await instantiate(port)
    expect(port.read).not.toHaveBeenCalled()
    expect(port.status).not.toHaveBeenCalled()
    expect(port.onChanged).not.toHaveBeenCalled()

    const surface = fixture.session.child('surface', 'settings')
    const result = await new ResourceCoordinator().activate(surface, fixture.resource)
    expect(result).toMatchObject({
      phase: 'ready',
      value: { revision: 2, status: { available: true, writable: true } },
    })
    expect(port.read).toHaveBeenCalledOnce()
    expect(port.status).toHaveBeenCalledOnce()
    expect(port.onChanged).toHaveBeenCalledOnce()

    await surface.dispose('closed')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('contributes a compact semantic surface, Vim keymap, and leaves Escape to the shell', async () => {
    const fixture = await instantiate(fakePort())
    expect(fixture.instance.contributions.routes).toEqual([{
      id: SETTINGS_ROUTE_ID,
      value: { kind: 'workspace', featureId: SETTINGS_FEATURE_ID, pane: 'content' },
    }])
    expect(fixture.instance.contributions.surfaces).toEqual([
      expect.objectContaining({
        id: SETTINGS_CONTENT_SURFACE_ID,
        slot: 'workspace.content',
        value: expect.objectContaining({
          role: 'content',
          node: expect.objectContaining({ kind: 'settings.content' }),
        }),
      }),
    ])
    expect(fixture.instance.contributions.keymaps).toEqual([{
      id: SETTINGS_KEYMAP_ID,
      value: {
        context: { routeKind: 'workspace', featureId: SETTINGS_FEATURE_ID, mode: 'normal' },
        bindings: [
          { key: 'k', commandId: SETTINGS_MOVE_UP_COMMAND_ID },
          { key: 'j', commandId: SETTINGS_MOVE_DOWN_COMMAND_ID },
          { key: 'enter', commandId: SETTINGS_ACTIVATE_COMMAND_ID },
          { key: 'r', commandId: SETTINGS_REFRESH_COMMAND_ID },
        ],
      },
    }])
    expect(fixture.instance.contributions.commands?.some(
      contribution => contribution.id === 'navigation.back',
    )).toBe(false)
    const node = fixture.instance.contributions.surfaces?.[0]?.value.node
    if (node === undefined) throw new Error('missing Settings node')
    expect(node.project({
      bounds: { x: 0, y: 0, width: 80, height: 12 },
      focus: true,
      mode: 'normal',
      resources: [],
    }).rows[0]?.text).toBe('Appearance & interaction')
    const invalidated = vi.fn()
    const stop = node.onChanged(invalidated)
    fixture.instance.model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(invalidated).toHaveBeenCalledOnce()
    stop()
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('uses a pure exhaustive machine for request stamps, selection, writes, and blocks', () => {
    const firstRequest = { scopeEpoch: 1, requestId: 1 }
    const secondRequest = { scopeEpoch: 2, requestId: 1 }
    let state = createSettingsFeatureState()
    expect(state).toMatchObject({ phase: 'idle', selectedIndex: 0, saving: false })
    state = transitionSettingsFeature(state, {
      type: 'preference.cycle',
      direction: 'next',
      requestId: 1,
    }).state
    expect(state.error).toBe('Preferences are not loaded')
    state = transitionSettingsFeature(state, { type: 'load.started', request: firstRequest }).state
    expect(state.phase).toBe('loading')
    state = transitionSettingsFeature(state, { type: 'load.started', request: secondRequest }).state
    expect(transitionSettingsFeature(state, {
      type: 'load.failed',
      request: firstRequest,
      message: 'stale failure',
    }).state).toBe(state)
    const stale = transitionSettingsFeature(state, {
      type: 'load.succeeded',
      request: firstRequest,
      snapshot: {
        status: { available: true, writable: true, documentBacked: true },
        revision: 1,
        preferences: preferences(),
      },
    })
    expect(stale.state).toBe(state)
    state = transitionSettingsFeature(state, {
      type: 'load.succeeded',
      request: secondRequest,
      snapshot: {
        status: { available: true, writable: true, documentBacked: true },
        revision: 4,
        preferences: preferences(),
      },
    }).state
    expect(transitionSettingsFeature(state, {
      type: 'selection.move',
      direction: 'up',
    }).state).toBe(state)
    state = transitionSettingsFeature(state, { type: 'selection.move', direction: 'down' }).state
    expect(SETTINGS_FIELD_IDS[state.selectedIndex]).toBe('density')
    const update = transitionSettingsFeature(state, {
      type: 'preference.cycle',
      direction: 'next',
      requestId: 7,
    })
    expect(update.effects).toEqual([{
      type: 'preferences.write',
      requestId: 7,
      expectedRevision: 4,
      preferences: expect.objectContaining({ density: 'comfortable' }),
    }])
    expect(update.state).toMatchObject({ saving: true, writeRequestId: 7 })
    expect(transitionSettingsFeature(update.state, {
      type: 'preference.cycle',
      direction: 'next',
      requestId: 8,
    }).state.error).toBe('A preference update is already running')
    expect(transitionSettingsFeature(update.state, {
      type: 'save.succeeded',
      requestId: 6,
      snapshot: update.state.snapshot!,
    }).state).toBe(update.state)
    expect(transitionSettingsFeature(update.state, {
      type: 'save.failed',
      requestId: 6,
      message: 'stale',
    }).state).toBe(update.state)
    state = transitionSettingsFeature(update.state, {
      type: 'save.failed',
      requestId: 7,
      message: 'CAS conflict',
    }).state
    expect(state).toMatchObject({ phase: 'failed', saving: false, error: 'CAS conflict' })
    const refresh = transitionSettingsFeature(state, { type: 'refresh.requested' })
    expect(refresh.effects).toEqual([{
      type: 'resource.refresh',
      resourceId: SETTINGS_RESOURCE_ID,
    }])
  })

  it('navigates and persists complete v1 documents through exact-revision CAS', async () => {
    const port = fakePort({ revision: 5 })
    const fixture = await instantiate(port)
    const coordinator = new ResourceCoordinator()
    const surface = fixture.session.child('surface', 'commands')
    await coordinator.activate(surface, fixture.resource)
    const generic = command(fixture.instance, 'navigation.move')

    await generic.handle(
      routed({ type: 'navigation.move', direction: 'down' }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_ACTIVATE_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_ACTIVATE_COMMAND_ID }),
      commandContext,
    )
    await generic.handle(
      routed({ type: 'navigation.move', direction: 'left' }),
      commandContext,
    )
    expect(port.write).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ version: 1, density: 'comfortable' }),
    )
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'ready',
      saving: false,
      snapshot: { revision: 6, preferences: { density: 'comfortable' } },
    })

    await generic.handle(
      routed({ type: 'navigation.move', direction: 'right' }),
      commandContext,
    )

    await command(fixture.instance, SETTINGS_MOVE_DOWN_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_MOVE_DOWN_COMMAND_ID }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_MOVE_UP_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_MOVE_UP_COMMAND_ID }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_CYCLE_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_NEXT_COMMAND_ID }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_CYCLE_PREVIOUS_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_PREVIOUS_COMMAND_ID }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_ACTIVATE_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_ACTIVATE_COMMAND_ID }),
      commandContext,
    )
    await command(fixture.instance, 'navigation.activate').handle(
      routed({ type: 'navigation.activate' }),
      commandContext,
    )
    await command(fixture.instance, SETTINGS_MOVE_UP_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: 'foreign' }),
      commandContext,
    )
    await generic.handle(routed({ type: 'edit.move', direction: 'left' }), commandContext)
    expect(port.write).toHaveBeenCalledTimes(4)

    await surface.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('refreshes from external changes and releases both watchers with the surface', async () => {
    const port = fakePort()
    const fixture = await instantiate(port)
    const coordinator = new ResourceCoordinator()
    const surface = fixture.session.child('surface', 'watch')
    await coordinator.activate(surface, fixture.resource)
    expect(port.read).toHaveBeenCalledTimes(1)

    await command(fixture.instance, SETTINGS_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_REFRESH_COMMAND_ID }),
      commandContext,
    )
    await vi.waitFor(() => expect(port.read).toHaveBeenCalledTimes(2))
    port.setPreferences(preferences({ layoutMode: 'split' }), 9)
    port.emit()
    await vi.waitFor(() => expect(port.read).toHaveBeenCalledTimes(3))
    expect(fixture.instance.model.snapshot()).toMatchObject({
      snapshot: { revision: 9, preferences: { layoutMode: 'split' } },
    })

    await surface.dispose('closed')
    const reads = port.read.mock.calls.length
    const stalePreferenceListener = port.onChanged.mock.calls[0]?.[0]
    stalePreferenceListener?.()
    port.emit()
    fixture.instance.model.dispatch({ type: 'refresh.requested' })
    expect(port.read).toHaveBeenCalledTimes(reads)
    await fixture.instance.dispose()
    await fixture.instance.dispose()
    expect(() => fixture.instance.model.onEffect(() => {})).toThrow('disposed')
    await fixture.manager.dispose()
  })

  it('keeps last-good data on read failure and ignores late loader completion', async () => {
    const port = fakePort({ preferences: preferences({ density: 'comfortable' }) })
    const fixture = await instantiate(port)
    const coordinator = new ResourceCoordinator()
    const surface = fixture.session.child('surface', 'last-good')
    const initial = await coordinator.activate(surface, fixture.resource)
    port.read.mockRejectedValueOnce(new Error('Settings document unavailable'))
    const failed = await coordinator.refresh(surface, fixture.resource)
    expect(failed).toMatchObject({
      phase: 'failed',
      value: { preferences: { density: 'comfortable' } },
      lastGood: { preferences: { density: 'comfortable' } },
      error: expect.objectContaining({ message: 'Settings document unavailable' }),
    })
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      snapshot: { preferences: { density: 'comfortable' } },
    })

    port.read.mockRejectedValueOnce('offline')
    await expect(coordinator.refresh(surface, fixture.resource)).resolves.toMatchObject({
      phase: 'failed',
      error: 'offline',
    })

    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let call = 0
    port.read.mockImplementation(async () => {
      const index = call++
      await gates[index]!.promise
      return {
        revision: index + 20,
        preferences: preferences({ layoutMode: index === 0 ? 'single' : 'split' }),
      }
    })
    const firstSurface = fixture.session.child('surface', 'first')
    const secondSurface = fixture.session.child('surface', 'second')
    const first = fixture.resource.load({
      scope: firstSurface,
      signal: firstSurface.signal,
      requestId: 10,
      previous: initial.value,
    })
    const second = fixture.resource.load({
      scope: secondSurface,
      signal: secondSurface.signal,
      requestId: 11,
      previous: initial.value,
    })
    gates[1]!.resolve()
    await second
    gates[0]!.resolve()
    await first
    expect(fixture.instance.model.snapshot()).toMatchObject({
      phase: 'ready',
      snapshot: { revision: 21, preferences: { layoutMode: 'split' } },
    })

    await secondSurface.dispose('done')
    await firstSurface.dispose('done')
    await surface.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('blocks unavailable/read-only writes and recovers from CAS conflicts', async () => {
    const unavailable = fakePort({
      status: { available: false, writable: false, documentBacked: false },
    })
    const missingFixture = await instantiate(unavailable)
    const missingSurface = missingFixture.session.child('surface', 'missing')
    await new ResourceCoordinator().activate(missingSurface, missingFixture.resource)
    await command(missingFixture.instance, SETTINGS_ACTIVATE_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_ACTIVATE_COMMAND_ID }),
      commandContext,
    )
    expect(unavailable.write).not.toHaveBeenCalled()
    await command(missingFixture.instance, SETTINGS_CYCLE_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_NEXT_COMMAND_ID }), commandContext,
    )
    expect(missingFixture.instance.model.snapshot().error).toBe(
      'DSH Settings service is unavailable',
    )
    await missingSurface.dispose('done')
    await missingFixture.instance.dispose()
    await missingFixture.manager.dispose()

    const readOnly = fakePort({
      status: { available: true, writable: false, documentBacked: false },
    })
    const readOnlyFixture = await instantiate(readOnly)
    const readOnlySurface = readOnlyFixture.session.child('surface', 'read-only')
    await new ResourceCoordinator().activate(readOnlySurface, readOnlyFixture.resource)
    await command(readOnlyFixture.instance, SETTINGS_ACTIVATE_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_ACTIVATE_COMMAND_ID }),
      commandContext,
    )
    expect(readOnly.write).not.toHaveBeenCalled()
    await command(readOnlyFixture.instance, SETTINGS_CYCLE_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_NEXT_COMMAND_ID }), commandContext,
    )
    expect(readOnlyFixture.instance.model.snapshot().error).toBe('DSH Settings is read-only')
    await readOnlySurface.dispose('done')
    await readOnlyFixture.instance.dispose()
    await readOnlyFixture.manager.dispose()

    const conflict = fakePort()
    conflict.write.mockRejectedValueOnce(new Error('SETTINGS_CONFLICT expected 2 actual 3'))
    const conflictFixture = await instantiate(conflict)
    const conflictSurface = conflictFixture.session.child('surface', 'conflict')
    await new ResourceCoordinator().activate(conflictSurface, conflictFixture.resource)
    await command(conflictFixture.instance, SETTINGS_CYCLE_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_NEXT_COMMAND_ID }),
      commandContext,
    )
    await vi.waitFor(() => expect(conflict.read).toHaveBeenCalledTimes(2))
    expect(conflictFixture.instance.model.snapshot()).toMatchObject({ saving: false })
    await conflictSurface.dispose('done')
    await conflictFixture.instance.dispose()
    await conflictFixture.manager.dispose()
  })

  it('projects six bounded safe rows and preserves semantic RGB palette edits', () => {
    const sourcePreferences = preferences({
      theme: {
        preset: 'auto',
        palette: { accent: '#112233', error: 'redBright' },
        colors: { accent: 'cyan' },
      },
    })
    const snapshot = detachSettingsFeatureSnapshot({
      status: { available: true, writable: true, documentBacked: true },
      revision: 7,
      preferences: sourcePreferences,
    })
    expect(projectSettingsRows(snapshot.preferences)).toHaveLength(6)
    expect(cycleSettingsPreference(snapshot.preferences, 'theme', 'next')).toMatchObject({
      theme: {
        preset: 'cordis',
        palette: { accent: '#112233', error: 'redBright' },
        colors: { accent: 'cyan' },
      },
    })
    let state = createSettingsFeatureState()
    state = transitionSettingsFeature(state, {
      type: 'load.started',
      request: { scopeEpoch: 1, requestId: 1 },
    }).state
    state = transitionSettingsFeature(state, {
      type: 'load.succeeded',
      request: { scopeEpoch: 1, requestId: 1 },
      snapshot,
    }).state
    const stateSource: SettingsFeatureStateSource = {
      snapshot: () => state,
      onChanged: () => () => {},
    }
    const node = createSettingsContentNode(stateSource)
    const projection = node.project({
      bounds: { x: 0, y: 0, width: 34, height: 12 },
      focus: true,
      mode: 'normal',
      resources: [],
    })
    expect(projection).toMatchObject({ title: 'Preferences' })
    expect(projection.rows.some(row => row.text.includes('Theme'))).toBe(true)
    expect(projection.rows.every(row => !row.text.includes('\u001b'))).toBe(true)
    expect(projection.rows.every(row => row.text.length <= 34)).toBe(true)
    expect(Object.isFrozen(snapshot.preferences.theme.palette)).toBe(true)
    state = transitionSettingsFeature(state, { type: 'editing.toggle' }).state
    const editing = node.project({ bounds: { x: 0, y: 0, width: 120, height: 12 }, focus: true, mode: 'normal', resources: [] })
    expect(editing.rows[0]?.text).toContain('EDITING')
    expect(editing.actionHint).toContain('←/→ change value · Enter finish')
    for (let index = 0; index < 5; index += 1) state = transitionSettingsFeature(state, { type: 'selection.move', direction: 'down' }).state
    const short = node.project({ bounds: { x: 0, y: 0, width: 80, height: 5 }, focus: false, mode: 'normal', resources: [] })
    expect(short.rows.some(row => row.selected && !row.dim)).toBe(true)
    expect(short.actionHint).toContain('Enter edit')
  })

  it('projects every loading/source/error/read-only row state and invalidates through the node', () => {
    const context = {
      bounds: { x: 0, y: 0, width: 120, height: 20 },
      focus: true,
      mode: 'normal',
      resources: [] as readonly { id: string; phase: 'loading' }[],
    }
    const project = (
      state: ReturnType<typeof createSettingsFeatureState>,
      resources = context.resources,
    ) => createSettingsContentNode({
      snapshot: () => state,
      onChanged: () => () => {},
    }).project({ ...context, resources })

    const idle = createSettingsFeatureState()
    expect(project(idle).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Preferences have not been loaded', tone: 'muted' }),
    ]))
    expect(project(idle, [{ id: SETTINGS_RESOURCE_ID, phase: 'loading' }]).rows)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'Loading preferences…', tone: 'warning' }),
      ]))

    for (const phase of ['ready', 'failed'] as const) {
      const state = phase === 'failed'
        ? { ...idle, phase, error: 'boom' }
        : { ...idle, phase }
      const projected = project(state)
      expect(projected.rows[0]?.tone).toBe(phase === 'failed' ? 'danger' : 'accent')
      expect(projected.rows[1]?.tone).toBe(phase === 'failed' ? 'danger' : 'success')
    }

    const memorySnapshot = detachSettingsFeatureSnapshot({
      status: { available: true, writable: false, documentBacked: false },
      revision: 8,
      preferences: preferences(),
    })
    const refreshing = project({
      ...idle,
      phase: 'refreshing',
      snapshot: memorySnapshot,
      saving: true,
      pendingPreferences: preferences({ density: 'comfortable' }),
      error: 'retrying',
    })
    expect(refreshing.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('Changes are not saved after exit') }),
      expect.objectContaining({ text: expect.stringContaining('Read-only') }),
      expect.objectContaining({ text: expect.stringContaining('Last operation failed') }),
      expect.objectContaining({ text: expect.stringContaining('Saving…'), tone: 'warning' }),
    ]))

    const unavailableSnapshot = detachSettingsFeatureSnapshot({
      status: { available: false, writable: false, documentBacked: false },
      revision: 0,
      preferences: preferences(),
    })
    expect(project({ ...idle, phase: 'failed', snapshot: unavailableSnapshot }).rows)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('Settings service unavailable'),
          tone: 'warning',
        }),
      ]))

    let stateListener: ((state: ReturnType<typeof createSettingsFeatureState>) => void) | undefined
    const stop = vi.fn()
    const invalidated = vi.fn()
    const node = createSettingsContentNode({
      snapshot: () => idle,
      onChanged: listener => {
        stateListener = listener
        return stop
      },
    })
    expect(node.onChanged(invalidated)).toBe(stop)
    stateListener?.(idle)
    expect(invalidated).toHaveBeenCalledOnce()
  })

  it('contains model observers and disposes listener registrations idempotently', () => {
    const model = createSettingsFeatureModel()
    const changed = vi.fn()
    const effected = vi.fn()
    const stopChanged = model.onChanged(changed)
    model.onChanged(() => { throw new Error('presentation failed') })
    const stopEffect = model.onEffect(effected)
    model.onEffect(() => { throw new Error('effect observer failed') })

    model.dispatch({ type: 'selection.move', direction: 'down' })
    model.dispatch({ type: 'refresh.requested' })
    expect(changed).toHaveBeenCalledOnce()
    expect(effected).toHaveBeenCalledWith({
      type: 'resource.refresh',
      resourceId: SETTINGS_RESOURCE_ID,
    })
    stopChanged()
    stopChanged()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.dispatch({ type: 'refresh.requested' })).toThrow('disposed')
    expect(() => model.onChanged(() => {})).toThrow('disposed')
    expect(() => model.onEffect(() => {})).toThrow('disposed')
  })

  it('ignores resource callbacks after abort and settled writes after feature disposal', async () => {
    const watchFixture = await instantiate(fakePort())
    const watchScope = watchFixture.session.child('surface', 'aborted-watch')
    const invalidated = vi.fn()
    const stopWatch = watchFixture.resource.watch?.({
      scope: watchScope,
      signal: watchScope.signal,
      invalidate: invalidated,
    })
    await watchScope.dispose('aborted')
    watchFixture.instance.model.dispatch({ type: 'refresh.requested' })
    expect(invalidated).not.toHaveBeenCalled()
    await stopWatch?.()
    await watchFixture.instance.dispose()
    await watchFixture.manager.dispose()

    for (const outcome of ['resolve', 'reject'] as const) {
      const port = fakePort()
      const fixture = await instantiate(port)
      const surface = fixture.session.child('surface', `inactive-${outcome}`)
      await new ResourceCoordinator().activate(surface, fixture.resource)
      const gate = Promise.withResolvers<Awaited<ReturnType<typeof port.write>>>()
      port.write.mockImplementationOnce(() => gate.promise)
      const task = command(fixture.instance, SETTINGS_CYCLE_NEXT_COMMAND_ID).handle(
        routed({ type: 'feature.command', commandId: SETTINGS_CYCLE_NEXT_COMMAND_ID }),
        commandContext,
      )
      await vi.waitFor(() => expect(port.write).toHaveBeenCalledOnce())
      await fixture.instance.dispose()
      if (outcome === 'resolve') {
        gate.resolve({ revision: 3, preferences: preferences({ density: 'comfortable' }) })
      } else {
        gate.reject('late failure')
      }
      await task
      await surface.dispose('done')
      await fixture.manager.dispose()
    }

    const abortedPort = fakePort()
    const abortedFixture = await instantiate(abortedPort)
    const abortedScope = abortedFixture.session.child('surface', 'aborted-load')
    await abortedScope.dispose('aborted')
    abortedPort.read.mockRejectedValueOnce(new Error('late read'))
    await expect(abortedFixture.resource.load({
      scope: abortedScope,
      signal: abortedScope.signal,
      requestId: 99,
      previous: undefined,
    })).rejects.toThrow('late read')
    expect(abortedFixture.instance.model.snapshot().error).toBeUndefined()
    await abortedFixture.instance.dispose()
    await abortedFixture.manager.dispose()
  })

  it('cycles and labels every preference field in both directions', () => {
    const source = {
      ...preferences({
      density: 'comfortable',
      navigationKeys: 'arrows',
      reducedMotion: true,
      layoutMode: 'single',
      defaultTranscriptMode: 'verbose',
      }),
      theme: {},
    }
    expect(projectSettingsRows(source).map(row => row.value)).toEqual([
      'Auto',
      'Comfortable',
      'Arrow keys',
      'On',
      'Single pane',
      'Verbose',
    ])
    for (const id of SETTINGS_FIELD_IDS) {
      expect(cycleSettingsPreference(source, id, 'next')).toMatchObject({ version: 1 })
      expect(cycleSettingsPreference(source, id, 'previous')).toMatchObject({ version: 1 })
    }
    expect(cycleSettingsPreference({
      ...source,
      theme: { preset: 'future' as never },
    }, 'theme', 'next').theme.preset).toBe('cordis')
  })
})
