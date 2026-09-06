import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-host.ts'
import {
  DIFF_CONTENT_RESOURCE_ID,
  DIFF_FEATURE_ID,
  DIFF_HUNK_NEXT_COMMAND,
  DIFF_HUNK_PREVIOUS_COMMAND,
  DIFF_ROUTE_ID,
  DIFF_WORKSPACE_CAPABILITY,
  createDiffFeatureFactory,
  createDiffFeatureState,
  projectDiffDocument,
  transitionDiffFeature,
  type DiffDocument,
  type DiffProjection,
  type DiffStateSource,
  type DiffWorkspacePort,
} from '../src/features/diff/index.ts'
import type { FeatureInstance } from '../src/kernel/feature.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import type { RoutedUiCommand } from '../src/navigation/commands.ts'
import { ResourceCoordinator, type ResourceDefinition } from '../src/resource/resource-coordinator.ts'

function document(digest = 'sha256:alpha'): DiffDocument {
  return {
    digest,
    title: 'Working tree',
    files: [
      {
        path: 'C:\\项目\\src\\入口.ts',
        status: 'modified',
        hunks: [
          {
            id: 'entry-imports',
            header: '@@ -1,2 +1,3 @@',
            lines: [
              { kind: 'context', oldLine: 1, newLine: 1, text: 'export {}' },
              { kind: 'added', newLine: 2, text: '你好，世界' },
            ],
          },
          {
            id: 'entry-body',
            header: '@@ -8,1 +9,1 @@',
            lines: [
              { kind: 'removed', oldLine: 8, text: 'old value' },
              { kind: 'added', newLine: 9, text: 'new value' },
            ],
          },
        ],
      },
      {
        path: 'README.md',
        status: 'added',
        hunks: [{
          id: 'readme',
          header: '@@ -0,0 +1 @@',
          lines: [{ kind: 'added', newLine: 1, text: '# 标题' }],
        }],
      },
    ],
  }
}

function routed(command: RoutedUiCommand['command']): RoutedUiCommand {
  return {
    target: { kind: 'feature', featureId: DIFF_FEATURE_ID },
    command,
  }
}

async function instantiate(
  port: DiffWorkspacePort,
  project = projectDiffDocument,
): Promise<{
  readonly manager: ScopeManager
  readonly instance: FeatureInstance
  readonly resource: ResourceDefinition<DiffProjection | null>
}> {
  const manager = new ScopeManager()
  const session = manager.createSession('diff-test')
  const factory = createDiffFeatureFactory({ project })
  const instance = await factory.create({
    scope: session,
    dependencies: [{ token: DIFF_WORKSPACE_CAPABILITY, value: port }],
  })
  const contribution = instance.contributions.resources?.find(
    candidate => candidate.id === DIFF_CONTENT_RESOURCE_ID,
  )
  if (contribution === undefined) throw new Error('missing Diff resource')
  return {
    manager,
    instance,
    resource: contribution.value as ResourceDefinition<DiffProjection | null>,
  }
}

describe('Diff Feature', () => {
  it('declares a session on-route feature and keeps expensive work cold before its surface opens', async () => {
    const describeCurrent = vi.fn(() => ({ digest: 'sha256:alpha' }))
    const compute = vi.fn(() => document())
    const project = vi.fn(projectDiffDocument)
    const port: DiffWorkspacePort = { describeCurrent, compute }

    const factory = createDiffFeatureFactory({ project })
    expect(factory.manifest).toMatchObject({
      id: DIFF_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      requires: [DIFF_WORKSPACE_CAPABILITY],
    })
    expect(factory.declarations).toMatchObject({
      routes: [DIFF_ROUTE_ID],
      resources: [DIFF_CONTENT_RESOURCE_ID],
    })
    expect(describeCurrent).not.toHaveBeenCalled()
    expect(compute).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()

    const fixture = await instantiate(port, project)
    expect(describeCurrent).not.toHaveBeenCalled()
    expect(compute).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()

    const surface = fixture.manager.createSession('resource-owner').child('surface', 'diff')
    const coordinator = new ResourceCoordinator()
    await coordinator.activate(surface, fixture.resource)
    expect(describeCurrent).toHaveBeenCalledOnce()
    expect(compute).toHaveBeenCalledOnce()
    expect(project).toHaveBeenCalledOnce()

    await surface.dispose('test complete')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('uses a content digest to reuse last-good details across refreshes and surface lifetimes', async () => {
    let digest = 'sha256:alpha'
    const describeCurrent = vi.fn(() => ({ digest }))
    const compute = vi.fn(({ reference }: Parameters<DiffWorkspacePort['compute']>[0]) => (
      document(reference.digest)
    ))
    const project = vi.fn(projectDiffDocument)
    const fixture = await instantiate({ describeCurrent, compute }, project)
    const coordinator = new ResourceCoordinator()
    const owner = fixture.manager.createSession('surface-owner')
    const first = owner.child('surface', 'diff-one')

    const initial = await coordinator.activate(first, fixture.resource)
    const refreshed = await coordinator.refresh(first, fixture.resource)
    expect(initial.value?.digest).toBe('sha256:alpha')
    expect(refreshed.value).toBe(initial.value)
    expect(describeCurrent).toHaveBeenCalledTimes(2)
    expect(compute).toHaveBeenCalledOnce()
    expect(project).toHaveBeenCalledOnce()

    await first.dispose('close')
    const second = owner.child('surface', 'diff-two')
    const reopened = await coordinator.activate(second, fixture.resource)
    expect(reopened.value).toBe(initial.value)
    expect(compute).toHaveBeenCalledOnce()
    expect(project).toHaveBeenCalledOnce()

    digest = 'sha256:beta'
    const changed = await coordinator.refresh(second, fixture.resource)
    expect(changed.value?.digest).toBe('sha256:beta')
    expect(compute).toHaveBeenCalledTimes(2)
    expect(project).toHaveBeenCalledTimes(2)

    await owner.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('projects bounded semantic detail without ANSI and preserves CJK Windows paths', () => {
    const raw = document()
    const unsafe: DiffDocument = {
      ...raw,
      files: [{
        ...raw.files[0]!,
        hunks: [{
          ...raw.files[0]!.hunks[0]!,
          lines: [
            { kind: 'added', newLine: 1, text: `安全\u001b[31m${'长'.repeat(20)}` },
            { kind: 'added', newLine: 2, text: '第二行' },
            { kind: 'added', newLine: 3, text: '第三行' },
          ],
        }],
      }],
    }

    const projection = projectDiffDocument(unsafe, {
      maxFiles: 1,
      maxHunksPerFile: 1,
      maxLinesPerHunk: 2,
      maxTextCodePoints: 8,
    })

    expect(projection.files[0]?.path).toBe('C:\\项目\\src\\入口.ts')
    expect(projection.files[0]?.hunks[0]?.lines).toHaveLength(2)
    expect(projection.files[0]?.hunks[0]?.lines[0]?.text).toContain('安全')
    expect(projection.files[0]?.hunks[0]?.lines[0]?.text).not.toContain('\u001b')
    expect(projection.truncation).toEqual(expect.objectContaining({
      truncated: true,
      hiddenLines: 1,
    }))
    expect(JSON.stringify(projection)).not.toContain('\u001b')
  })

  it('runs an exhaustive navigation machine for j/k, h/l, page and hunk movement', () => {
    const projected = projectDiffDocument(document())
    let state = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded',
      projection: projected,
    }).state
    expect(state).toMatchObject({
      phase: 'ready',
      selection: { fileIndex: 0, hunkIndex: 0, lineIndex: 0, horizontalOffset: 0 },
    })

    state = transitionDiffFeature(state, {
      type: 'move', direction: 'down',
    }).state
    expect(state.selection.lineIndex).toBe(1)
    state = transitionDiffFeature(state, {
      type: 'move', direction: 'down',
    }).state
    expect(state.selection).toMatchObject({ fileIndex: 0, hunkIndex: 1, lineIndex: 0 })
    state = transitionDiffFeature(state, {
      type: 'move-hunk', direction: 'next',
    }).state
    expect(state.selection).toMatchObject({ fileIndex: 1, hunkIndex: 0, lineIndex: 0 })
    state = transitionDiffFeature(state, {
      type: 'move-hunk', direction: 'previous',
    }).state
    expect(state.selection).toMatchObject({ fileIndex: 0, hunkIndex: 1, lineIndex: 0 })

    const collapsed = transitionDiffFeature(state, {
      type: 'move', direction: 'left',
    })
    state = collapsed.state
    expect(state.collapsedHunkIds).toEqual(['entry-body'])
    expect(collapsed.effects).toContainEqual({ type: 'view-invalidated' })
    state = transitionDiffFeature(state, {
      type: 'move', direction: 'right',
    }).state
    expect(state.collapsedHunkIds).toEqual([])
    state = transitionDiffFeature(state, {
      type: 'move', direction: 'right',
    }).state
    expect(state.selection.horizontalOffset).toBe(1)

    const paged = transitionDiffFeature(state, {
      type: 'page', direction: 'down', size: 20,
    })
    expect(paged.state.selection).toMatchObject({ fileIndex: 1, hunkIndex: 0, lineIndex: 0 })
    expect(paged.effects).toContainEqual(expect.objectContaining({
      type: 'ensure-selection-visible',
    }))
  })

  it('contributes semantic content/inspector nodes and command/keymap handlers without owning Esc', async () => {
    const fixture = await instantiate({
      describeCurrent: () => ({ digest: 'sha256:alpha' }),
      compute: () => document(),
    })
    const contributions = fixture.instance.contributions
    expect(contributions.routes).toEqual([{
      id: DIFF_ROUTE_ID,
      value: { kind: 'diff', featureId: DIFF_FEATURE_ID, pane: 'content' },
    }])
    expect(contributions.surfaces).toEqual([
      expect.objectContaining({
        slot: 'workspace.content',
        value: expect.objectContaining({
          role: 'content',
          node: expect.objectContaining({
            kind: 'diff.content',
            resourceId: DIFF_CONTENT_RESOURCE_ID,
          }),
        }),
      }),
      expect.objectContaining({
        slot: 'workspace.inspector',
        value: expect.objectContaining({
          role: 'inspector',
          node: expect.objectContaining({ kind: 'diff.inspector' }),
        }),
      }),
    ])
    const content = contributions.surfaces?.[0]?.value as {
      readonly node: { readonly state: DiffStateSource }
    }
    const source = content.node.state
    const changes = vi.fn()
    const stop = source.onChanged(changes)

    const resourceOwner = fixture.manager.createSession('commands').child('surface', 'diff')
    const coordinator = new ResourceCoordinator()
    await coordinator.activate(resourceOwner, fixture.resource)
    const command = (id: string): FeatureCommandHandler => {
      const contribution = contributions.commands?.find(candidate => candidate.id === id)
      if (contribution === undefined) throw new Error(`missing command ${id}`)
      return contribution.value as FeatureCommandHandler
    }
    await command('navigation.move').handle(routed({
      type: 'navigation.move', direction: 'down',
    }), { navigation: {} as never, openRoute: async () => {} })
    expect(source.snapshot().selection.lineIndex).toBe(1)
    await command(DIFF_HUNK_NEXT_COMMAND).handle(routed({
      type: 'navigation.activate',
    }), { navigation: {} as never, openRoute: async () => {} })
    expect(source.snapshot().selection.hunkIndex).toBe(1)
    expect(changes).toHaveBeenCalled()

    expect(contributions.keymaps).toEqual([expect.objectContaining({
      id: 'diff.normal',
      value: expect.objectContaining({
        bindings: [
          { key: '[', commandId: DIFF_HUNK_PREVIOUS_COMMAND },
          { key: ']', commandId: DIFF_HUNK_NEXT_COMMAND },
        ],
      }),
    })])
    expect(contributions.commands?.some(candidate => candidate.id === 'navigation.back')).toBe(false)

    stop()
    await resourceOwner.dispose('done')
    await fixture.instance.dispose()
    await fixture.manager.dispose()
  })

  it('keeps the previous document visible when a refresh fails', () => {
    const projection = projectDiffDocument(document())
    const ready = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded', projection,
    }).state
    const loading = transitionDiffFeature(ready, { type: 'load-started' }).state
    const failure = new Error('diff unavailable')
    const failed = transitionDiffFeature(loading, {
      type: 'load-failed', error: failure,
    }).state

    expect(failed).toMatchObject({
      phase: 'failed',
      error: failure,
      projection,
    })
  })

  it('covers empty, invalid, failed and watched resource lifecycles without publishing stale work', async () => {
    const stopWatch = vi.fn()
    const watch = vi.fn(() => stopWatch)
    const empty = await instantiate({
      describeCurrent: () => null,
      compute: vi.fn(() => document()),
      watch,
    }, projectDiffDocument)
    const emptyOwner = empty.manager.createSession('empty-owner').child('surface', 'diff')
    const coordinator = new ResourceCoordinator()
    const emptyResult = await coordinator.activate(emptyOwner, empty.resource)
    expect(emptyResult).toMatchObject({ phase: 'ready', value: null })
    expect(watch).toHaveBeenCalledOnce()
    await emptyOwner.dispose('close empty')
    expect(stopWatch).toHaveBeenCalledOnce()
    await empty.instance.dispose()
    await empty.instance.dispose()
    await empty.manager.dispose()

    for (const fixture of [
      await instantiate({
        describeCurrent: () => ({ digest: ' bad ' }),
        compute: () => document(),
      }),
      await instantiate({
        describeCurrent: () => ({ digest: 'sha256:expected' }),
        compute: () => document('sha256:actual'),
      }),
      await instantiate({
        describeCurrent: () => ({ digest: 'sha256:expected' }),
        compute: () => document('sha256:expected'),
      }, () => projectDiffDocument(document('sha256:projector-changed'))),
    ]) {
      const owner = fixture.manager.createSession('bad-owner').child('surface', 'diff')
      const result = await new ResourceCoordinator().activate(owner, fixture.resource)
      expect(result.phase).toBe('failed')
      await owner.dispose('failed')
      await fixture.instance.dispose()
      await fixture.manager.dispose()
    }

    let rejectCompute!: (error: unknown) => void
    let computeSignal!: AbortSignal
    const aborted = await instantiate({
      describeCurrent: () => ({ digest: 'sha256:abort' }),
      compute: ({ signal }) => {
        computeSignal = signal
        return new Promise<DiffDocument>((_resolve, reject) => { rejectCompute = reject })
      },
    })
    const abort = new AbortController()
    const pending = aborted.resource.load({
      scope: aborted.manager.createSession('manual').child('surface', 'manual'),
      signal: abort.signal,
      requestId: 1,
      previous: undefined,
    })
    await vi.waitFor(() => expect(computeSignal).toBe(abort.signal))
    abort.abort('closed')
    rejectCompute(new Error('late failure'))
    await expect(pending).rejects.toThrow('late failure')
    await aborted.instance.dispose()
    await aborted.manager.dispose()
  })

  it('keeps model listeners isolated and handles every contributed command shape', async () => {
    const factory = createDiffFeatureFactory({
      limits: { maxFiles: 10 },
    })
    const manager = new ScopeManager()
    const session = manager.createSession('commands-all')
    const instance = await factory.create({
      scope: session,
      dependencies: [{
        token: DIFF_WORKSPACE_CAPABILITY,
        value: {
          describeCurrent: () => ({ digest: 'sha256:alpha' }),
          compute: () => document(),
        },
      }],
    })
    const node = (instance.contributions.surfaces?.[0]?.value as {
      readonly node: { readonly state: DiffStateSource }
    }).node
    const throwing = node.state.onChanged(() => { throw new Error('renderer failed') })
    const resource = instance.contributions.resources?.[0]?.value as ResourceDefinition<DiffProjection | null>
    const owner = session.child('surface', 'commands-all')
    await new ResourceCoordinator().activate(owner, resource)

    const context = { navigation: {} as never, openRoute: async () => {} }
    const command = (id: string): FeatureCommandHandler => (
      instance.contributions.commands?.find(candidate => candidate.id === id)?.value
    ) as FeatureCommandHandler
    await command('navigation.move').handle(routed({
      type: 'navigation.move', direction: 'up',
    }), context)
    await command('navigation.move').handle(routed({ type: 'navigation.activate' }), context)
    await command('navigation.page').handle(routed({ type: 'navigation.activate' }), context)
    await command('navigation.page').handle(routed({
      type: 'navigation.page', direction: 'down',
    }), context)
    await command('navigation.activate').handle(routed({
      type: 'navigation.move', direction: 'down',
    }), context)
    await command('navigation.activate').handle(routed({ type: 'navigation.activate' }), context)
    await command(DIFF_HUNK_PREVIOUS_COMMAND).handle(
      routed({ type: 'navigation.activate' }),
      context,
    )
    expect(node.state.snapshot().phase).toBe('ready')

    throwing()
    await instance.dispose()
    await command('navigation.move').handle(routed({
      type: 'navigation.move', direction: 'down',
    }), context)
    expect(() => node.state.onChanged(() => {})).toThrow('model is disposed')
    await instance.dispose()
    await owner.dispose('done')
    await manager.dispose()
  })

  it('covers empty and boundary navigation while preserving same-document selection', () => {
    const emptyProjection = projectDiffDocument({ digest: 'empty', files: [] })
    let empty = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded', projection: emptyProjection,
    }).state
    for (const event of [
      { type: 'move', direction: 'up' },
      { type: 'move', direction: 'left' },
      { type: 'page', direction: 'up' },
      { type: 'move-hunk', direction: 'previous' },
      { type: 'toggle-collapse' },
    ] as const) {
      expect(transitionDiffFeature(empty, event).state).toBe(empty)
    }

    const noHunkProjection = projectDiffDocument({
      digest: 'no-hunk',
      files: [{ path: 'empty.ts', status: 'modified', hunks: [] }],
    })
    empty = transitionDiffFeature(empty, {
      type: 'load-succeeded', projection: noHunkProjection,
    }).state
    expect(transitionDiffFeature(empty, { type: 'toggle-collapse' }).state).toBe(empty)
    const invalidNoHunk = {
      ...empty,
      selection: { fileIndex: 99, hunkIndex: 99, lineIndex: 99, horizontalOffset: 0 },
    } as typeof empty
    expect(transitionDiffFeature(invalidNoHunk, {
      type: 'load-succeeded', projection: noHunkProjection,
    }).state.selection).toMatchObject({ fileIndex: 0, hunkIndex: 0, lineIndex: 0 })

    const invalidEmpty = {
      ...transitionDiffFeature(createDiffFeatureState(), {
        type: 'load-succeeded', projection: emptyProjection,
      }).state,
      selection: { fileIndex: 99, hunkIndex: 99, lineIndex: 99, horizontalOffset: 0 },
    }
    expect(transitionDiffFeature(invalidEmpty, {
      type: 'load-succeeded', projection: emptyProjection,
    }).state.selection).toEqual({ fileIndex: 0, hunkIndex: 0, lineIndex: 0, horizontalOffset: 0 })

    const projection = projectDiffDocument(document())
    let state = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded', projection,
    }).state
    expect(transitionDiffFeature(state, {
      type: 'move-hunk', direction: 'previous',
    }).state).toBe(state)
    expect(transitionDiffFeature(state, {
      type: 'move', direction: 'up',
    }).state).toBe(state)
    expect(transitionDiffFeature(state, {
      type: 'page', direction: 'up', size: Number.NaN,
    }).state).toBe(state)

    state = transitionDiffFeature(state, {
      type: 'move', direction: 'left',
    }).state
    expect(transitionDiffFeature(state, {
      type: 'move', direction: 'down',
    }).state.selection).toMatchObject({ hunkIndex: 1, lineIndex: 0 })
    const collapsed = transitionDiffFeature(state, {
      type: 'load-succeeded', projection,
    }).state
    expect(collapsed.collapsedHunkIds).toEqual(['entry-imports'])
    state = transitionDiffFeature(collapsed, {
      type: 'move', direction: 'left',
    }).state
    expect(state.selection.horizontalOffset).toBe(0)
    expect(transitionDiffFeature(state, {
      type: 'move', direction: 'right',
    }).state.collapsedHunkIds).toEqual([])

    const invalidSelection = {
      ...state,
      selection: { fileIndex: 99, hunkIndex: 99, lineIndex: 99, horizontalOffset: 0 },
    } as typeof state
    expect(transitionDiffFeature(invalidSelection, {
      type: 'move', direction: 'down',
    }).state.selection).not.toEqual(invalidSelection.selection)
    expect(transitionDiffFeature(invalidSelection, {
      type: 'load-succeeded', projection,
    }).state.selection).toMatchObject({ fileIndex: 1, hunkIndex: 0, lineIndex: 0 })
    const reset = transitionDiffFeature(state, { type: 'reset' }).state
    expect(reset.phase).toBe('idle')
    expect(transitionDiffFeature(reset, {
      type: 'move', direction: 'down',
    }).state).toBe(reset)
    expect(transitionDiffFeature(reset, {
      type: 'page', direction: 'down',
    }).state).toBe(reset)
    expect(transitionDiffFeature(reset, {
      type: 'move-hunk', direction: 'next',
    }).state).toBe(reset)
    expect(transitionDiffFeature(reset, { type: 'toggle-collapse' }).state).toBe(reset)
    expect(transitionDiffFeature(reset, { type: 'load-empty' }).state.phase).toBe('empty')
  })

  it('accounts for hidden files/hunks and rejects malformed projection inputs', () => {
    const source: DiffDocument = {
      digest: 'sha256:limits',
      files: [
        {
          path: 'first.ts',
          previousPath: '旧.ts',
          status: 'renamed',
          hunks: [
            {
              id: 'visible',
              header: '\tvisible',
              lines: [{ kind: 'context', oldLine: 1, newLine: 1, text: '\tkeep' }],
            },
            {
              id: 'hidden-hunk',
              header: 'hidden',
              lines: [{ kind: 'added', newLine: 2, text: 'hidden' }],
            },
          ],
        },
        {
          path: 'second.ts',
          status: 'deleted',
          hunks: [{
            id: 'hidden-file',
            header: 'hidden',
            lines: [
              { kind: 'removed', oldLine: 1, text: 'gone' },
              { kind: 'added', newLine: 1, text: 'replacement' },
            ],
          }],
        },
      ],
    }
    const projection = projectDiffDocument(source, {
      maxFiles: 1,
      maxHunksPerFile: 1,
      maxLinesPerHunk: 1,
      maxTextCodePoints: 100,
    })
    expect(projection.title).toBeUndefined()
    expect(projection.files[0]).toMatchObject({ previousPath: '旧.ts', hiddenHunks: 1 })
    expect(projection.stats).toEqual({ files: 2, hunks: 3, lines: 4, added: 2, removed: 1 })
    expect(projection.truncation).toMatchObject({
      hiddenFiles: 1,
      hiddenHunks: 2,
      hiddenLines: 3,
    })

    for (const run of [
      () => projectDiffDocument({ digest: '', files: [] }),
      () => projectDiffDocument({
        digest: 'ok', files: [{ path: '', status: 'added', hunks: [] }],
      }),
      () => projectDiffDocument({
        digest: 'ok', files: [{
          path: 'x', status: 'modified', hunks: [{ id: ' bad ', header: '', lines: [] }],
        }],
      }),
      () => projectDiffDocument({
        digest: 'ok', files: [{
          path: 'x', status: 'modified', hunks: [{
            id: 'h', header: '', lines: [{ kind: 'added', newLine: 0, text: '' }],
          }],
        }],
      }),
      () => projectDiffDocument({ digest: 'ok', files: [] }, { maxFiles: 0 }),
    ]) expect(run).toThrow()
  })
})
