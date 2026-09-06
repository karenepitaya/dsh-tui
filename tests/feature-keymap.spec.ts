import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  DshTuiFeatureHost,
  type FeatureCommandHandler,
} from '../src/app/feature-host.ts'
import {
  provideDshTuiFeatures,
} from '../src/dsh/feature-service.ts'
import { legacyChatFeature } from '../src/features/legacy-chat.ts'
import { FEATURE_API_VERSION } from '../src/kernel/feature.ts'
import { decodeTerminalInput } from '../src/terminal/input.ts'
import { transitionNavigation, type NavigationState } from '../src/navigation/state.ts'

describe('Feature keymap routing', () => {
  it('routes an active Feature binding through a semantic feature command', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root, {}, [legacyChatFeature])
    const host = new DshTuiFeatureHost(features.service, {
      slotDefinitions: features.slotDefinitions,
    })
    const handle = vi.fn<FeatureCommandHandler['handle']>()
    const registration = features.service.registerFeature({
      manifest: {
        id: 'diff',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'on-route',
        required: false,
        requires: [],
      },
      declarations: {
        routes: ['diff'],
        commands: ['diff.hunk.next'],
        keymaps: ['diff.normal'],
      },
      create: () => ({
        contributions: {
          routes: [{
            id: 'diff',
            value: { kind: 'diff', featureId: 'diff', pane: 'content' },
          }],
          commands: [{
            id: 'diff.hunk.next',
            value: { handle },
          }],
          keymaps: [{
            id: 'diff.normal',
            value: {
              context: { routeKind: 'diff', featureId: 'diff', mode: 'normal' },
              bindings: [
                { key: ']', commandId: 'diff.hunk.next' },
                { key: 'enter', commandId: 'diff.hunk.next' },
                { key: 's', commandId: 'diff.hunk.next', ctrl: true },
                { key: 'x', commandId: 'diff.hunk.next', ctrl: true, alt: true, shift: true },
              ],
            },
          }],
        },
        dispose() {},
      }),
    })

    await host.start()
    await host.openRoute('diff')
    const dispatch = host.dispatchTerminalAction({ type: 'insert', text: ']' })
    expect(dispatch.handled).toBe(true)
    await dispatch.completion
    expect(handle).toHaveBeenCalledExactlyOnceWith(
      {
        target: { kind: 'feature', featureId: 'diff' },
        command: { type: 'feature.command', commandId: 'diff.hunk.next' },
      },
      expect.objectContaining({ navigation: expect.objectContaining({ value: 'diff' }) }),
    )

    await host.dispatchTerminalAction(decodeTerminalInput('\x1b[200~]\x1b[201~')).completion
    expect(handle).toHaveBeenCalledOnce()
    for (const key of [
      { type: 'text', text: 'x' },
      { type: 'text', text: 'x', ctrl: true },
      { type: 'text', text: 'x', ctrl: true, alt: true },
      { type: 'named', key: 'enter', shift: true },
    ] as const) await host.dispatchTerminalKey(key).completion
    expect(handle).toHaveBeenCalledOnce()
    await host.dispatchTerminalKey({ type: 'text', text: 'x', ctrl: true, alt: true, shift: true }).completion
    await host.dispatchTerminalKey({ type: 'named', key: 'enter' }).completion
    expect(handle).toHaveBeenCalledTimes(3)

    const probe = host as unknown as { navigationState: NavigationState }
    probe.navigationState = transitionNavigation(host.navigation, {
      type: 'push-overlay', overlay: { id: 'diff-probe', kind: 'custom', featureId: 'diff' },
    }).state
    await host.dispatchTerminalKey({ type: 'text', text: ']' }).completion
    expect(handle.mock.calls.at(-1)?.[0].target).toEqual({ kind: 'overlay', overlayId: 'diff-probe', featureId: 'diff' })
    await host.dispatchTerminalKey({ type: 'text', text: 'i' }).completion
    expect(host.navigation.mode).toBe('insert')
    await host.dispatchTerminalKey({ type: 'named', key: 'escape' }).completion
    expect(host.navigation.route.kind).toBe('diff')
    await host.dispatchUiCommand('mode.set', { target: { kind: 'shell' }, command: { type: 'mode.set', mode: 'normal' } })
    await host.dispatchTerminalKey({ type: 'text', text: 'i' }).completion
    expect(host.navigation.mode).toBe('normal')
    await host.dispatchTerminalKey({ type: 'text', text: ']' }).completion
    expect(handle).toHaveBeenCalledTimes(5)
    await host.dispatchTerminalKey({ type: 'named', key: 'escape' }).completion
    expect(host.navigation.route.kind).toBe('chat')
    await host.dispatchTerminalAction(decodeTerminalInput('\x13')).completion
    expect(handle).toHaveBeenCalledTimes(5)

    await registration.release()
    host.dispose()
    expect(host.dispatchTerminalKey({ type: 'text', text: ']' }).handled).toBe(false)
    await features.dispose()
    await root.fiber.dispose()
  })

  it('rejects malformed bindings before publishing an optional Feature', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const registration = features.service.registerFeature({
      manifest: {
        id: 'bad.keys',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'on-command',
        required: false,
        requires: [],
      },
      declarations: { commands: ['bad.open'], keymaps: ['bad.keys'] },
      create: () => ({
        contributions: {
          commands: [{ id: 'bad.open', value: { handle() {} } }],
          keymaps: [{
            id: 'bad.keys',
            value: {
              context: { routeKind: 'workspace', featureId: 'bad.keys', mode: 'normal' },
              bindings: [{ key: '', commandId: 'missing.command' }],
            },
          }],
        },
        dispose() {},
      }),
    })

    await features.ready
    await expect(features.service.activateCommand('bad.open')).resolves.toEqual([{
      featureId: 'bad.keys',
      state: 'unavailable',
      error: expect.objectContaining({ code: 'invalid-keymap' }),
    }])

    await registration.release()
    await features.dispose()
    await root.fiber.dispose()
  })
})
