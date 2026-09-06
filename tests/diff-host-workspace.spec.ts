import { describe, expect, it, vi } from 'vitest'
import { DshTuiFeatureHost } from '../src/app/feature-host.ts'
import { FeatureSurfaceRuntime } from '../src/app/feature-surface-runtime.ts'
import { createDiffFeatureFactory, DIFF_WORKSPACE_CAPABILITY, type DiffStateSource } from '../src/features/diff/index.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import { mapTerminalKey } from '../src/navigation/commands.ts'
import { createNavigationState, transitionNavigation } from '../src/navigation/state.ts'
import { renderFeatureSurfaceFrame } from '../src/ui/feature-surface-frame.ts'

describe('Diff through the real Feature Host', () => {
  it('keeps unsupported search out of Insert while preserving folding, hunks, detail scrolling and one Escape', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('diff-host')
    const read = vi.fn(() => ({ digest: 'diff-host-document' }))
    const compute = vi.fn(() => ({ digest: 'diff-host-document', title: 'Workspace changes', files: [{
      path: `D:\\项目\\${'long-path-'.repeat(30)}tail.ts`, status: 'modified' as const,
      hunks: ['first', 'second'].map(id => ({ id, header: `@@ ${id} @@`, lines: Array.from({ length: 40 }, (_, index) => ({
        kind: 'added' as const, newLine: index + 1, text: `line ${index} ${'完整详情 '.repeat(30)}END_OF_LINE`,
      })) })),
    }] }))
    const instance = await createDiffFeatureFactory().create({ scope: session, dependencies: [
      { token: DIFF_WORKSPACE_CAPABILITY, value: { describeCurrent: read, compute } },
    ] })
    const state = (instance.contributions.surfaces![0]!.value as { node: { state: DiffStateSource } }).node.state
    const service = {
      ready: Promise.resolve([]), activateRoute: async () => [], activateCommand: async () => [],
      listActiveContributions: () => [{ featureId: 'legacy.chat', provenance: { authority: 'core', required: true }, contributions: {
        routes: [{ id: 'chat', value: { kind: 'chat' } }],
      } }, { featureId: 'diff', provenance: { authority: 'extension', required: false }, contributions: instance.contributions }],
    } as unknown as DshTuiFeatureService
    const host = new DshTuiFeatureHost(service)
    await host.start()
    const surfaces = new FeatureSurfaceRuntime(host)
    let viewport = { columns: 80, rows: 12 }
    const lease = surfaces.bindSession(session, viewport)
    const render = () => renderFeatureSurfaceFrame(lease.snapshot(), viewport).lines.join('\n')
    try {
      await lease.ready
      await host.openRoute('diff')
      await lease.settled()
      await vi.waitFor(() => expect(state.snapshot().phase).toBe('ready'))
      expect(host.navigation.mode).toBe('normal')
      await host.dispatchTerminalAction({ type: 'insert', text: '/' }).completion
      await host.dispatchTerminalAction({ type: 'insert', text: 'i' }).completion
      expect(host.navigation.mode).toBe('normal')
      await host.dispatchTerminalAction({ type: 'insert', text: 'h' }).completion
      expect(state.snapshot().collapsedHunkIds).toContain('first')
      await host.dispatchTerminalAction({ type: 'insert', text: 'l' }).completion
      expect(state.snapshot().collapsedHunkIds).not.toContain('first')
      await host.dispatchTerminalAction({ type: 'insert', text: ']' }).completion
      expect(state.snapshot().selection.hunkIndex).toBe(1)
      await host.dispatchTerminalAction({ type: 'insert', text: '[' }).completion
      expect(state.snapshot().selection.hunkIndex).toBe(0)
      await host.dispatchTerminalAction({ type: 'complete' }).completion
      await lease.settled()
      expect(host.navigation.route).toMatchObject({ pane: 'inspector' })
      const selected = state.snapshot().selection
      const before = render()
      await host.dispatchTerminalAction({ type: 'page-down' }).completion
      await lease.settled()
      expect(render()).not.toBe(before)
      expect(state.snapshot().selection).toEqual(selected)
      await host.dispatchTerminalAction({ type: 'insert', text: 'k' }).completion
      expect(state.snapshot().selection).toEqual(selected)
      for (const columns of [100, 140, 200, 80]) {
        viewport = { columns, rows: 12 }
        await lease.resize(viewport)
        expect(render()).toContain('Esc back')
      }
      expect(read).toHaveBeenCalledOnce()
      expect(compute).toHaveBeenCalledOnce()
      await host.dispatchTerminalAction({ type: 'escape' }).completion
      expect(host.navigation.route.kind).toBe('chat')
      expect(host.dispatchTerminalAction({ type: 'escape' }).handled).toBe(false)
    } finally {
      host.dispose()
      await surfaces.dispose()
      await instance.dispose()
      await manager.dispose()
    }
  })

  it('maps Escape from a Diff Insert state back without changing Chat or short-overlay input', () => {
    const chat = createNavigationState()
    const diff = transitionNavigation(chat, { type: 'navigate', route: { kind: 'diff', featureId: 'diff', pane: 'content' } }).state
    const inserted = transitionNavigation(diff, { type: 'set-mode', mode: 'insert' }).state
    const overlay = transitionNavigation(inserted, { type: 'push-overlay', overlay: { id: 'confirm', kind: 'custom', featureId: 'diff' } }).state
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: inserted })).toEqual({ type: 'navigation.back' })
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: chat })).toEqual({ type: 'mode.set', mode: 'normal' })
    const normalChat = transitionNavigation(chat, { type: 'set-mode', mode: 'normal' }).state
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: normalChat })).toEqual({ type: 'navigation.back' })
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: overlay })).toEqual({ type: 'mode.set', mode: 'normal' })
  })
})
