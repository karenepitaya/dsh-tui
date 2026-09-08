import { describe, expect, it, vi } from 'vitest'
import { DshTuiController, type DshTuiProductPort } from '../src/app/controller.ts'
import { createUnavailableDshCommandPort } from '../src/command/port.ts'
import { createUnavailableSessionModelPort } from '../src/model/port.ts'
import { DshSubmitRejectedError, type SubmitInput } from '../src/runtime/port.ts'
import type { PromptImageBytes } from '../src/attachment/port.ts'
import type { TerminalDriver, TerminalDriverCallbacks, TerminalDriverState } from '../src/terminal/driver.ts'
import type { UiFrame } from '../src/ui/frame.ts'

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal === undefined || signal.aborted) return Promise.resolve()
  return new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
}

/** Admission and clipboard promises are controlled; input goes through the real controller. */
async function fixture(commandFailure?: 'returned-error' | 'rejected-promise') {
  let release!: () => void
  const admission = new Promise<void>(resolve => { release = resolve })
  const submitted: SubmitInput[] = []
  const executed: SubmitInput[] = []
  const session: DshTuiProductPort = {
    ...createUnavailableDshCommandPort(),
    ...createUnavailableSessionModelPort(),
    sessionId: 'composer-recovery-fixture',
    ownsAgentLifecycle: true,
    async *events(options = {}) {
      options.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
      await untilAborted(options.signal)
    },
    async *interactions(options = {}) {
      yield { type: 'interaction/snapshot', sessionId: this.sessionId, pending: [] }
      await untilAborted(options.signal)
    },
    respond: () => ({ accepted: false, reason: 'not-pending' }),
    disposeInteractions() {},
    listCommands: () => commandFailure === undefined ? [] : [{
      name: 'inspect-fixture', description: 'Test image command', input: { hint: '<text>', images: true },
    }],
    parseCommand: line => line.startsWith('/inspect-fixture ')
      ? { name: 'inspect-fixture', rawInput: line.slice('/inspect-fixture '.length) }
      : undefined,
    async executeCommand(line, _signal, images) {
      executed.push({ text: line, ...(images === undefined ? {} : { images }) })
      await admission
      if (commandFailure === 'rejected-promise') throw new Error('Fixture command refused')
      return { commandId: 'fixture-command', result: { kind: 'error', text: 'Fixture command refused' } }
    },
    async submit(input) {
      submitted.push(input)
      if (submitted.length === 1 && commandFailure === undefined) {
        await admission
        throw new DshSubmitRejectedError('Model route changed during image admission', 'MODEL_DOES_NOT_SUPPORT_IMAGES')
      }
      return { inputId: `input-${submitted.length}` }
    },
    cancel() {},
    async whenIdle() {},
    async flush() {},
    async dispose() {},
    attachmentSnapshot: () => ({ available: true }),
    prepareImageBytes: async input => ({ ...input, bytes: input.data.byteLength }),
  }
  let callbacks!: TerminalDriverCallbacks
  let state: TerminalDriverState = 'idle'
  const frames: UiFrame[] = []
  const terminal: TerminalDriver = {
    get state() { return state },
    viewport: { columns: 120, rows: 30 },
    start(value) { callbacks = value; state = 'running' },
    handoff(value) { callbacks = value },
    render(frame) { frames.push(frame) },
    stopAcceptingInput() { state = 'quiescing' },
    restore() { state = 'restored' },
  }
  let clipboard: PromptImageBytes = { name: 'old.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }
  let clipboardDelay: Promise<void> | undefined
  const controller = new DshTuiController({
    session, terminal,
    catalog: { listSessions: async () => ({ durability: 'unavailable', sessions: [] }) },
    application: { requestExit() {}, forceExit() {} },
    clipboard: { read: async () => {
      const image = clipboard
      await clipboardDelay
      return { kind: 'image', image }
    } },
    frameIntervalMs: 1,
  })
  await controller.start()
  function beginPaste(name: string) {
    clipboard = { ...clipboard, name }
    callbacks.onInput({ type: 'paste-image' })
  }
  return {
    controller, submitted, executed, release, beginPaste,
    input: (action: Parameters<TerminalDriverCallbacks['onInput']>[0]) => callbacks.onInput(action),
    holdClipboard() {
      let resolve!: () => void
      clipboardDelay = new Promise<void>(done => { resolve = done })
      return () => { clipboardDelay = undefined; resolve() }
    },
    async paste(name: string) {
      beginPaste(name)
      await vi.waitFor(() => expect(controller.pendingAttachmentCount).toBe(0), { interval: 1 })
    },
    async settle() {
      release()
      await vi.waitFor(() => expect(controller.pendingSubmitCount).toBe(0), { interval: 1 })
      await vi.waitFor(() => expect(controller.pendingCommandCount).toBe(0), { interval: 1 })
      await vi.waitFor(() => expect(frames.at(-1)?.lines.join('\n')).toContain(
        commandFailure === undefined ? 'Prompt not sent' : 'Command failed',
      ), { interval: 1 })
    },
  }
}

describe('composer draft recovery keeps text and images together', () => {
  it('does not silently attach a refused old image to replacement text', async () => {
    const product = await fixture()
    try {
      await product.paste('old.png')
      product.input({ type: 'insert', text: 'describe the old picture' })
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(1), { interval: 1 })
      product.input({ type: 'insert', text: 'a new text-only question' })
      await product.settle()
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(2), { interval: 1 })
      expect(product.submitted[1]).toEqual({ text: 'a new text-only question' })
    } finally {
      product.release()
      await product.controller.requestExit('user')
    }
  })

  it('does not silently attach refused old text to a replacement image-only draft', async () => {
    const product = await fixture()
    try {
      await product.paste('old.png')
      product.input({ type: 'insert', text: 'describe the old picture' })
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(1), { interval: 1 })
      await product.paste('new.png')
      await product.settle()
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(2), { interval: 1 })
      expect(product.submitted[1]).toMatchObject({ text: '', images: [{ name: 'new.png' }] })
      expect(product.submitted[1]?.images).toHaveLength(1)
    } finally {
      product.release()
      await product.controller.requestExit('user')
    }
  })

  it.each(['returned-error', 'rejected-promise'] as const)('does not copy old command images into new text after %s', async outcome => {
    const product = await fixture(outcome)
    try {
      await product.paste('old-command.png')
      product.input({ type: 'insert', text: '/inspect-fixture original target' })
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.executed).toHaveLength(1), { interval: 1 })
      expect(product.executed[0]?.images?.[0]?.name).toBe('old-command.png')
      product.input({ type: 'insert', text: 'a different text-only question' })
      await product.settle()
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(1), { interval: 1 })
      expect(product.submitted[0]).toEqual({ text: 'a different text-only question' })
    } finally {
      product.release()
      await product.controller.requestExit('user')
    }
  })

  it('keeps an in-flight replacement paste separate from a refused prompt', async () => {
    const product = await fixture()
    let releaseClipboard = () => {}
    try {
      await product.paste('old.png')
      product.input({ type: 'insert', text: 'describe the old picture' })
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(1), { interval: 1 })
      releaseClipboard = product.holdClipboard()
      product.beginPaste('delayed-new.png')
      expect(product.controller.pendingAttachmentCount).toBe(1)
      await product.settle()
      expect(product.controller.pendingAttachmentCount).toBe(1)
      releaseClipboard()
      await vi.waitFor(() => expect(product.controller.pendingAttachmentCount).toBe(0), { interval: 1 })
      product.input({ type: 'submit' })
      await vi.waitFor(() => expect(product.submitted).toHaveLength(2), { interval: 1 })
      expect(product.submitted[1]).toMatchObject({ text: '', images: [{ name: 'delayed-new.png' }] })
      expect(product.submitted[1]?.images).toHaveLength(1)
    } finally {
      releaseClipboard()
      product.release()
      await product.controller.requestExit('user')
    }
  })
})
