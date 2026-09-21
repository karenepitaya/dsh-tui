import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, {
  parseCommand as parseOfficialCommand,
  type CommandDefinition,
} from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { DshCommandSession } from '../src/dsh/command-session.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function commandHarness(): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly port: DshCommandSession
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('command-session'))
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, port: new DshCommandSession(ctx, agent) }
}

function command(definition: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name: 'inspect',
    description: 'Inspect state',
    input: { hint: '<target>', attachments: true },
    handler: () => ({ kind: 'success' }),
    ...definition,
  }
}

describe('official DSH command session adapter', () => {
  it('returns deeply detached product-owned command descriptors', async () => {
    const { ctx, agent, port } = await commandHarness()
    ctx.commands.register(command())
    ctx.commands.register(command({
      name: 'plain',
      input: { hint: '<value>' },
    }))
    const official = ctx.commands.list(agent)

    const listed = port.listCommands()

    expect(listed).toEqual([{
      name: 'inspect',
      description: 'Inspect state',
      input: { hint: '<target>', images: true },
    }, {
      name: 'plain',
      description: 'Inspect state',
      input: { hint: '<value>' },
    }])
    expect(listed).not.toBe(official)
    expect(listed[0]).not.toBe(official[0])
    expect(listed[0]?.input).not.toBe(official[0]?.input)
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.input)).toBe(true)
  })

  it('parses through the official grammar while detaching the parsed value', async () => {
    const { port } = await commandHarness()
    const official = parseOfficialCommand('/inspect\t untouched ')

    const parsed = port.parseCommand('/inspect\t untouched ')

    expect(parsed).toEqual({ name: 'inspect', rawInput: '\t untouched ' })
    expect(parsed).not.toBe(official)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(port.parseCommand('inspect')).toBeUndefined()
  })

  it('executes against the exact unpublished Agent with no images', async () => {
    const { ctx, agent, port } = await commandHarness()
    const seen = vi.fn(() => ({
      kind: 'success' as const,
      text: 'done',
      sourceEventSeq: SessionSeq(7),
    }))
    ctx.commands.register(command({ name: 'deploy', handler: seen }))
    ctx.commands.register({
      name: 'deny',
      description: 'Deny command',
      handler: () => ({ kind: 'error', text: 'not now' }),
    })
    ctx.commands.register({
      name: 'silent',
      description: 'Silent command',
      handler: () => ({ kind: 'success' }),
    })
    const controller = new AbortController()

    const execution = await port.executeCommand('/deploy  untouched ', controller.signal)

    expect(execution).toMatchObject({
      commandId: expect.any(String),
      result: { kind: 'success', text: 'done', sourceEventSeq: 7 },
    })
    expect(Object.isFrozen(execution)).toBe(true)
    expect(Object.isFrozen(execution?.result)).toBe(true)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      rawInput: '  untouched ',
      attachments: [],
      signal: controller.signal,
    }))
    await expect(port.executeCommand('/deny', controller.signal)).resolves.toMatchObject({
      result: { kind: 'error', text: 'not now' },
    })
    await expect(port.executeCommand('/silent', controller.signal)).resolves.toMatchObject({
      result: { kind: 'success' },
    })
    await expect(port.executeCommand('/missing', controller.signal)).resolves.toBeUndefined()

    const aborted = new AbortController()
    aborted.abort(new Error('command cancelled'))
    await expect(port.executeCommand('/deploy', aborted.signal)).rejects.toThrow(
      'command cancelled',
    )
  })

  it('encodes staged image bytes for an official image-capable command', async () => {
    const { ctx, agent, port } = await commandHarness()
    const seen = vi.fn(() => ({ kind: 'success' as const }))
    const saveImages = vi.fn(async () => [{
      attachmentId: 'attachment-command-1',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'panel.png',
    }])
    ctx.provide('attachments', { saveImages } as never)
    ctx.commands.register(command({ name: 'inspect-image', handler: seen }))
    const signal = new AbortController().signal

    await expect(port.executeCommand('/inspect-image target', signal, [{
      name: 'panel.png',
      mediaType: 'image/png',
      bytes: 4,
      data: new Uint8Array([1, 2, 3, 4]),
    }])).resolves.toMatchObject({ result: { kind: 'success' } })

    expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent,
      rawInput: ' target',
      attachments: [{
        type: 'image',
        attachment: expect.objectContaining({
          attachmentId: 'attachment-command-1',
          name: 'panel.png',
        }),
      }],
      signal,
    }))
    expect(saveImages).toHaveBeenCalledExactlyOnceWith([{
      name: 'panel.png',
      mediaType: 'image/png',
      data: new Uint8Array([1, 2, 3, 4]),
    }])
  })

  it('owns registry and exact-session preset subscriptions and makes disposal idempotent', async () => {
    const { ctx, agent, port } = await commandHarness()
    const changed = vi.fn()
    const stop = port.onCommandsChanged(changed)
    const unregister = ctx.commands.register(command())
    expect(changed).toHaveBeenCalledOnce()

    ctx.emit('agent-preset/selected', SessionId('foreign-session'), 'minimal')
    expect(changed).toHaveBeenCalledOnce()
    ctx.emit('agent-preset/selected', agent.id, 'minimal')
    expect(changed).toHaveBeenCalledTimes(2)

    stop()
    stop()
    unregister()
    expect(changed).toHaveBeenCalledTimes(2)

    const active = vi.fn()
    const existingDisposer = port.onCommandsChanged(active)
    port.disposeCommands()
    port.disposeCommands()
    existingDisposer()
    ctx.commands.register(command({ name: 'later' }))
    expect(active).not.toHaveBeenCalled()

    expect(() => port.listCommands()).toThrow('DSH command port is closed')
    expect(() => port.onCommandsChanged(() => {})).toThrow(
      'DSH command port is closed',
    )
    await expect(port.executeCommand('/later', new AbortController().signal)).rejects.toThrow(
      'DSH command port is closed',
    )
    expect(port.parseCommand('/later x')).toEqual({ name: 'later', rawInput: ' x' })
  })

  it('fails loud when the official command service is unavailable', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = { id: SessionId('missing-commands') } as Agent

    expect(() => new DshCommandSession(ctx, agent)).toThrow(
      'DSH command service is unavailable',
    )
  })
})
