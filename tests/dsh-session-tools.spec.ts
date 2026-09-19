import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshSessionTools } from '../src/dsh/session-tools.ts'

interface ToolSchemaFixture {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties?: Readonly<Record<string, unknown>>
    readonly required?: readonly string[]
  }
}

interface ToolRuntimeFixture {
  schemas(scope?: Agent): ToolSchemaFixture[]
}

interface ToolContext {
  provide(name: 'tools', service: ToolRuntimeFixture): void
  emit(name: 'tools/change'): void
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function schema(
  name: string,
  properties: readonly string[] = [],
  required: readonly string[] = [],
): ToolSchemaFixture {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(properties.map(key => [key, { type: 'string' }])),
      required,
    },
  }
}

function setup(options: {
  readonly schemas?: readonly ToolSchemaFixture[]
  readonly provideTools?: boolean
  readonly provideAgents?: boolean
} = {}): {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: ToolRuntimeFixture & { readonly schemas: ReturnType<typeof vi.fn> }
  readonly setSchemas: (schemas: readonly ToolSchemaFixture[]) => void
  readonly setLiveAgent: (agent: Agent | undefined) => void
} {
  const ctx = new Context()
  contexts.push(ctx)
  const agentCtx = new Context()
  contexts.push(agentCtx)
  const id = SessionId('tools-session')
  const session = Session.create(id, undefined, {
    version: 3,
    id,
    createdAt: 1,
    isSeeded: false,
    agentPreset: 'standard',
  })
  const agent = {
    id,
    session,
    ctx: agentCtx,
    status: 'idle',
  } as unknown as Agent
  let liveAgent: Agent | undefined = agent
  let schemas = [...(options.schemas ?? [])]
  const runtime = {
    schemas: vi.fn((scope?: Agent) => {
      expect(scope).toBe(agent)
      return structuredClone(schemas)
    }),
  }
  if (options.provideTools !== false) {
    (ctx as unknown as ToolContext).provide('tools', runtime)
  }
  if (options.provideAgents !== false) {
    ctx.provide('agents', { get: () => liveAgent } as never)
  }
  return {
    ctx,
    agent,
    runtime,
    setSchemas: value => { schemas = [...value] },
    setLiveAgent: value => { liveAgent = value },
  }
}

describe('DSH exact-Agent tool capability adapter', () => {
  it('projects the official scoped schema catalog without claiming execution ownership', () => {
    const { ctx, agent, runtime } = setup({
      schemas: [
        schema('write_file', ['path', 'content'], ['path', 'content']),
        schema('mcp__github__create_issue', ['owner', 'title'], ['owner']),
        schema('run_code', ['code'], ['code']),
      ],
    })

    const port = new DshSessionTools(ctx, agent)
    const snapshot = port.toolsSnapshot()

    expect(runtime.schemas).toHaveBeenCalledExactlyOnceWith(agent)
    expect(snapshot).toEqual({
      available: true,
      stale: false,
      generation: 0,
      tools: [
        {
          name: 'write_file',
          description: 'write_file description',
          group: 'core',
          parameterNames: ['content', 'path'],
          requiredParameterNames: ['content', 'path'],
        },
        {
          name: 'mcp__github__create_issue',
          description: 'mcp__github__create_issue description',
          group: 'mcp',
          parameterNames: ['owner', 'title'],
          requiredParameterNames: ['owner'],
        },
        {
          name: 'run_code',
          description: 'run_code description',
          group: 'transport',
          parameterNames: ['code'],
          requiredParameterNames: ['code'],
        },
      ],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tools)).toBe(true)
    expect(Object.isFrozen(snapshot.tools[0])).toBe(true)
    expect(Object.isFrozen(snapshot.tools[0]?.parameterNames)).toBe(true)
    expect(Object.isFrozen(snapshot.tools[0]?.requiredParameterNames)).toBe(true)
  })

  it('re-reads the exact Agent scope on registry and matching preset changes', () => {
    const { ctx, agent, runtime, setSchemas } = setup({
      schemas: [schema('read_file')],
    })
    const port = new DshSessionTools(ctx, agent)
    const listener = vi.fn()
    const stop = port.onToolsChanged(listener)

    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(runtime.schemas).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()

    setSchemas([schema('read_file'), schema('search_files', ['query'], ['query'])])
    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(listener).toHaveBeenCalledOnce()
    expect(port.toolsSnapshot()).toMatchObject({
      generation: 1,
      tools: [{ name: 'read_file' }, { name: 'search_files' }],
    })

    ctx.emit('agent-preset/selected', SessionId('foreign'), 'code')
    expect(runtime.schemas).toHaveBeenCalledTimes(3)
    ctx.emit('agent-preset/selected', agent.id, 'code')
    expect(runtime.schemas).toHaveBeenCalledTimes(4)
    expect(listener).toHaveBeenCalledOnce()

    stop()
    stop()
    setSchemas([schema('run_code')])
    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('retains the last good projection when the official catalog cannot be observed', () => {
    const { ctx, agent, runtime, setLiveAgent } = setup({
      schemas: [schema('read_file')],
    })
    const port = new DshSessionTools(ctx, agent)
    const listener = vi.fn()
    port.onToolsChanged(listener)

    runtime.schemas.mockImplementationOnce(() => { throw new Error('catalog failed') })
    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(port.toolsSnapshot()).toMatchObject({
      available: true,
      stale: true,
      error: 'catalog failed',
      tools: [{ name: 'read_file' }],
    })
    expect(listener).toHaveBeenCalledOnce()

    runtime.schemas.mockImplementationOnce(() => { throw 'string failure' })
    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(port.toolsSnapshot().error).toBe('string failure')

    setLiveAgent(undefined)
    ;(ctx as unknown as ToolContext).emit('tools/change')
    expect(port.toolsSnapshot().error).toContain('no longer the live Agent')
  })

  it('contains malformed parameter metadata while retaining official names and descriptions', () => {
    const malformed = [
      { name: 'string_parameters', description: 'string', parameters: 'bad' },
      { name: 'null_parameters', description: 'null', parameters: null },
      { name: 'array_parameters', description: 'array', parameters: [] },
      {
        name: 'array_properties',
        description: 'array properties',
        parameters: { type: 'object', properties: [], required: 'bad' },
      },
      {
        name: 'mixed_required',
        description: 'mixed required',
        parameters: {
          type: 'object',
          properties: { known: { type: 'string' } },
          required: ['known', 'known', 'missing', 7],
        },
      },
    ] as unknown as readonly ToolSchemaFixture[]
    const { ctx, agent } = setup({ schemas: malformed })

    const snapshot = new DshSessionTools(ctx, agent).toolsSnapshot()

    expect(snapshot.tools.filter(tool => tool.name !== 'mixed_required').every(tool => (
      tool.parameterNames.length === 0 && tool.requiredParameterNames.length === 0
    ))).toBe(true)
    expect(snapshot.tools.find(tool => tool.name === 'mixed_required')).toMatchObject({
      parameterNames: ['known'],
      requiredParameterNames: ['known'],
    })
  })

  it('reports unavailable/missing owners and contains teardown callbacks', () => {
    const missing = setup({ provideTools: false })
    const unavailable = new DshSessionTools(missing.ctx, missing.agent)
    expect(unavailable.toolsSnapshot()).toEqual({
      available: false,
      stale: false,
      generation: 0,
      tools: [],
    })

    const noAgents = setup({ provideAgents: false })
    const failed = new DshSessionTools(noAgents.ctx, noAgents.agent)
    expect(failed.toolsSnapshot()).toMatchObject({
      available: true,
      stale: true,
      error: 'DSH Agent service is unavailable',
      tools: [],
    })

    const callbacks = new Map<string, (...args: unknown[]) => void>()
    const fakeCtx = {
      get(name: string): unknown {
        if (name === 'tools') return { schemas: () => [schema('read_file')] }
        if (name === 'agents') return { get: () => missing.agent }
        return undefined
      },
      on(name: string, listener: (...args: unknown[]) => void): () => boolean {
        callbacks.set(name, listener)
        return () => true
      },
    } as unknown as Context
    const port = new DshSessionTools(fakeCtx, missing.agent)
    const listener = vi.fn()
    port.onToolsChanged(listener)
    port.disposeTools()
    port.disposeTools()
    expect(port.toolsSnapshot()).toEqual({
      available: false,
      stale: false,
      generation: 0,
      tools: [],
    })
    expect(() => port.onToolsChanged(listener)).toThrow('disposed')
    expect(() => callbacks.get('tools/change')?.()).not.toThrow()
    expect(() => callbacks.get('agent-preset/selected')?.(missing.agent.id, 'code')).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
