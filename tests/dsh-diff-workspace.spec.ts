import { describe, expect, it, vi } from 'vitest'
import type { CoreSessionPort } from '../src/runtime/core-session-port.ts'
import {
  createDshEventDelivery,
  type DshRuntimeEventItem,
} from '../src/runtime/delivery.ts'
import type { RuntimeEventOptions } from '../src/runtime/port.ts'
import { DIFF_WORKSPACE_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import { DshDiffWorkspace } from '../src/dsh/diff-workspace.ts'
import { durable, message } from './fixtures.ts'

type ReplayCore = Pick<CoreSessionPort, 'sessionId' | 'events'>

function replayCore(items: readonly DshRuntimeEventItem[], sessionId = 'session-a'): {
  readonly core: ReplayCore
  readonly events: ReturnType<typeof vi.fn>
} {
  const events = vi.fn((options: RuntimeEventOptions = {}) => (async function* () {
    for (const item of items) {
      if (options.signal?.aborted === true) return
      yield item
    }
    options.onCaughtUp?.({
      lastSeq: items.reduce((last, item) => (
        item.plane === 'durable' ? Math.max(last, item.seq) : last
      ), -1),
      status: 'idle',
    })
  })())
  return {
    core: { sessionId, events },
    events,
  }
}

function diffCall(
  seq: number,
  callId: string,
  diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[],
  title = `Edit ${callId}`,
) {
  return createDshEventDelivery(durable(seq, {
    type: 'tool/call',
    data: { turn: 1, step: seq + 1, callId, name: 'Edit', arguments: '{}' },
  }), {
    for: 'call',
    view: { phase: 'call', card: 'diff', title, diffs },
  })
}

function diffResult(
  seq: number,
  callId: string,
  diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[],
) {
  return createDshEventDelivery(durable(seq, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: seq,
      callId,
      message: message(`result-${callId}`, 'assistant', ''),
      surfaceOp: 'append',
    },
  }), {
    for: 'result',
    view: { phase: 'result', card: 'diff', title: `Applied ${callId}`, diffs },
  })
}

describe('DSH durable Diff workspace adapter', () => {
  it('keeps replay cold until describeCurrent and exposes the shared session token', async () => {
    expect(DIFF_WORKSPACE_CAPABILITY).toMatchObject({
      id: 'dsh-tui.diff.workspace/v1',
      scope: 'session',
    })
    const fixture = replayCore([])
    const workspace = new DshDiffWorkspace(fixture.core)

    expect(fixture.events).not.toHaveBeenCalled()
    await expect(workspace.describeCurrent({
      signal: new AbortController().signal,
    })).resolves.toBeNull()
    expect(fixture.events).toHaveBeenCalledOnce()
    expect(fixture.events.mock.calls[0]?.[0]).toMatchObject({ afterSeq: -1 })
    expect(fixture.events.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(fixture.events.mock.calls[0]?.[0].onCaughtUp).toEqual(expect.any(Function))

    await workspace.dispose()
  })

  it('derives a stable digest from reducer-projected tool presentations and computes semantic files', async () => {
    const fixture = replayCore([
      diffCall(0, 'added', [{
        path: 'C:\\项目\\README\t\u001b[31m.md',
        oldText: null,
        newText: '# 标题\n\t内容\u0007\n',
      }]),
      diffCall(1, 'deleted', [{
        path: 'C:\\项目\\旧文件.txt',
        oldText: '第一行\n第二行',
        newText: '',
      }]),
      diffCall(2, 'modified', [{
        path: 'C:\\项目\\入口.ts',
        oldText: 'same\n旧值\nend',
        newText: 'same\n新值\nend',
      }]),
      // The result presentation is the reducer's effective presentation and
      // must replace the same tool row's call presentation without duplication.
      diffResult(3, 'modified', [{
        path: 'C:\\项目\\入口.ts',
        oldText: 'same\n旧值\nend',
        newText: 'same\n最终值\nend',
      }]),
    ])
    const workspace = new DshDiffWorkspace(fixture.core)
    const signal = new AbortController().signal

    const first = await workspace.describeCurrent({ signal })
    const second = await workspace.describeCurrent({ signal })
    expect(first).toEqual(second)
    expect(first?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(() => workspace.compute({
      reference: { digest: 'sha256:not-the-described-snapshot' },
      signal,
    })).toThrow('does not match')

    const document = await workspace.compute({ reference: first!, signal })
    expect(document.digest).toBe(first?.digest)
    expect(document.files).toHaveLength(3)
    expect(document.files.map(file => file.status)).toEqual([
      'added',
      'deleted',
      'modified',
    ])
    expect(document.files[0]?.path).toBe('C:\\项目\\README��[31m.md')
    expect(document.files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'added', newLine: 1, text: '# 标题' },
      { kind: 'added', newLine: 2, text: '\t内容�' },
      { kind: 'added', newLine: 3, text: '' },
    ])
    expect(document.files[1]?.hunks[0]?.lines).toEqual([
      { kind: 'removed', oldLine: 1, text: '第一行' },
      { kind: 'removed', oldLine: 2, text: '第二行' },
    ])
    expect(document.files[2]?.hunks[0]?.lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'same' },
      { kind: 'removed', oldLine: 2, text: '旧值' },
      { kind: 'added', newLine: 2, text: '最终值' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'end' },
    ])
    expect(JSON.stringify(document)).not.toContain('\u001b')
    expect(JSON.stringify(document)).not.toContain('\u0007')

    await workspace.dispose()
    await workspace.dispose()
  })

  it('addresses equal semantic content independently of DSH call identity', async () => {
    const diffs = [{ path: 'same.ts', oldText: 'before', newText: 'after' }]
    const first = new DshDiffWorkspace(replayCore([
      diffCall(0, 'call-one', diffs, 'Edit file'),
    ]).core)
    const second = new DshDiffWorkspace(replayCore([
      diffCall(0, 'call-two', diffs, 'Edit file'),
    ]).core)
    const signal = new AbortController().signal

    await expect(first.describeCurrent({ signal })).resolves.toEqual(
      await second.describeCurrent({ signal }),
    )
    await first.dispose()
    await second.dispose()
  })

  it('ignores non-diff tools and fails closed when replay ends before its caught-up boundary', async () => {
    const plain = createDshEventDelivery(durable(0, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'read', name: 'Read', arguments: '{}' },
    }), {
      for: 'call',
      view: { phase: 'call', card: 'generic', title: 'Read', kind: 'read' },
    })
    const empty = replayCore([plain])
    const workspace = new DshDiffWorkspace(empty.core)
    await expect(workspace.describeCurrent({
      signal: new AbortController().signal,
    })).resolves.toBeNull()
    expect(() => workspace.compute({
      reference: { digest: 'sha256:none' },
      signal: new AbortController().signal,
    })).toThrow('no described durable snapshot')

    const incompleteEvents = vi.fn((_options: RuntimeEventOptions = {}) => (
      async function* (): AsyncIterable<DshRuntimeEventItem> {
        yield plain
      }
    )())
    const incomplete = new DshDiffWorkspace({ sessionId: 'session-a', events: incompleteEvents })
    await expect(incomplete.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toThrow('before the durable replay boundary')

    await workspace.dispose()
    await incomplete.dispose()
  })

  it('rejects crossed session identity, incompatible replay, and source failures', async () => {
    const crossed = replayCore([diffCall(0, 'crossed', [{
      path: 'crossed.ts', oldText: null, newText: 'bad',
    }])])
    const crossedWorkspace = new DshDiffWorkspace({
      sessionId: 'bound-session',
      events: crossed.core.events,
    })
    await expect(crossedWorkspace.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toThrow('crossed its bound session identity')

    const incompatible = replayCore([durable(0, {
      type: 'session/unsupported', data: { sourceType: 'future/diff' },
    })])
    const incompatibleWorkspace = new DshDiffWorkspace(incompatible.core)
    await expect(incompatibleWorkspace.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toThrow('required DSH session event')

    const rawFailure = new Error('source replay failed')
    const failedWorkspace = new DshDiffWorkspace({
      sessionId: 'session-a',
      events: () => (async function* (): AsyncIterable<DshRuntimeEventItem> {
        throw rawFailure
      })(),
    })
    await expect(failedWorkspace.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toBe(rawFailure)

    await crossedWorkspace.dispose()
    await incompatibleWorkspace.dispose()
    await failedWorkspace.dispose()
  })

  it('treats caught-up iterator termination as internal and handles empty hunks', async () => {
    const items = [diffCall(0, 'empty-hunks', [
      { path: 'empty.txt', oldText: null, newText: '' },
      { path: 'same.txt', oldText: 'same', newText: 'same' },
    ])]
    const events = vi.fn((options: RuntimeEventOptions = {}) => (async function* () {
      yield* items
      options.onCaughtUp?.({ lastSeq: 0, status: 'idle' })
      throw new Error('iterator observed its internal abort')
    })())
    const workspace = new DshDiffWorkspace({ sessionId: 'session-a', events })
    const signal = new AbortController().signal
    const reference = await workspace.describeCurrent({ signal })
    const document = workspace.compute({ reference: reference!, signal })
    expect(document.title).toBe('Edit empty-hunks')
    expect(document.files.map(file => ({ status: file.status, hunks: file.hunks }))).toEqual([
      { status: 'added', hunks: [] },
      { status: 'modified', hunks: [] },
    ])
    await workspace.dispose()
  })

  it('uses a stable fallback title when the effective result has no title', async () => {
    const call = diffCall(0, 'untitled', [{
      path: 'untitled.ts', oldText: 'before', newText: 'during',
    }])
    const result = createDshEventDelivery(durable(1, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId: 'untitled',
        message: message('result-untitled', 'assistant', ''),
        surfaceOp: 'append',
      },
    }), {
      for: 'result',
      view: {
        phase: 'result',
        card: 'diff',
        diffs: [{ path: 'untitled.ts', oldText: 'before', newText: 'after' }],
      },
    })
    const fixture = replayCore([call, result])
    const workspace = new DshDiffWorkspace(fixture.core)
    const signal = new AbortController().signal
    const reference = await workspace.describeCurrent({ signal })

    expect(workspace.compute({ reference: reference!, signal }).title).toBe('Session changes')
    await workspace.dispose()
  })

  it('uses latest-wins snapshot assignment for overlapping describes', async () => {
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let invocation = 0
    const olderItem = diffCall(0, 'older', [{ path: 'old.ts', oldText: null, newText: 'old' }])
    const newerItem = diffCall(0, 'newer', [{ path: 'new.ts', oldText: null, newText: 'new' }])
    const events = vi.fn((options: RuntimeEventOptions = {}) => {
      invocation += 1
      const current = invocation
      return (async function* () {
        if (current === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
          yield olderItem
        } else {
          yield newerItem
        }
        options.onCaughtUp?.({ lastSeq: 0, status: 'idle' })
      })()
    })
    const workspace = new DshDiffWorkspace({ sessionId: 'session-a', events })
    const signal = new AbortController().signal
    const older = workspace.describeCurrent({ signal })
    await firstStarted.promise
    const newer = await workspace.describeCurrent({ signal })
    releaseFirst.resolve()
    const olderReference = await older

    expect(newer?.digest).not.toBe(olderReference?.digest)
    expect(workspace.compute({ reference: newer!, signal }).files[0]?.path).toBe('new.ts')
    expect(() => workspace.compute({ reference: olderReference!, signal })).toThrow('does not match')
    await workspace.dispose()
  })

  it('does not let an older empty describe erase a newer snapshot', async () => {
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let invocation = 0
    const item = diffCall(0, 'newer', [{ path: 'new.ts', oldText: null, newText: 'new' }])
    const events = vi.fn((options: RuntimeEventOptions = {}) => {
      invocation += 1
      const current = invocation
      return (async function* () {
        if (current === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        } else {
          yield item
        }
        options.onCaughtUp?.({ lastSeq: current === 1 ? -1 : 0, status: 'idle' })
      })()
    })
    const workspace = new DshDiffWorkspace({ sessionId: 'session-a', events })
    const signal = new AbortController().signal
    const olderEmpty = workspace.describeCurrent({ signal })
    await firstStarted.promise
    const newer = await workspace.describeCurrent({ signal })
    releaseFirst.resolve()
    await expect(olderEmpty).resolves.toBeNull()
    expect(workspace.compute({ reference: newer!, signal }).files[0]?.path).toBe('new.ts')
    await workspace.dispose()
  })

  it('aborts an in-flight replay on release and never leaves background work alive', async () => {
    let observedSignal: AbortSignal | undefined
    let iteratorClosed = false
    const started = Promise.withResolvers<void>()
    const events = vi.fn((options: RuntimeEventOptions = {}) => (async function* () {
      observedSignal = options.signal
      started.resolve()
      try {
        await new Promise<void>(resolve => {
          if (options.signal?.aborted === true) return resolve()
          options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally {
        iteratorClosed = true
      }
    })())
    const workspace = new DshDiffWorkspace({ sessionId: 'session-a', events })
    const reading = workspace.describeCurrent({ signal: new AbortController().signal })
    await started.promise

    await workspace.dispose()
    await expect(reading).rejects.toThrow('disposed')
    expect(observedSignal?.aborted).toBe(true)
    expect(iteratorClosed).toBe(true)
    await expect(workspace.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toThrow('disposed')
  })

  it('forwards caller cancellation into the independent replay iterator', async () => {
    let observedSignal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const events = vi.fn((options: RuntimeEventOptions = {}) => (async function* () {
      observedSignal = options.signal
      started.resolve()
      await new Promise<void>(resolve => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    })())
    const workspace = new DshDiffWorkspace({ sessionId: 'session-a', events })
    const controller = new AbortController()
    const reading = workspace.describeCurrent({ signal: controller.signal })
    await started.promise
    controller.abort(new Error('caller cancelled'))

    await expect(reading).rejects.toThrow('caller cancelled')
    expect(observedSignal?.reason).toEqual(new Error('caller cancelled'))
    await workspace.dispose()
  })
})
