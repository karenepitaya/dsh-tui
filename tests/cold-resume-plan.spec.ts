import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { deriveColdResumePlan } from '../src/dsh/cold-resume-plan.ts'

function createInspection(
  id: string,
  header: Partial<SessionHeader> = {},
): { readonly inspection: SessionInspection; readonly session: Session } {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 1,
    ...header,
  })
  return {
    inspection: {
      meta: session.header,
      get events() { return session.events },
    },
    session,
  }
}

function presetResolver(pathRoot = 'D:\\presets') {
  return vi.fn(async (id: string) => ({
    id,
    trust: 'system' as const,
    path: `${pathRoot}\\${id}\\agent.cordis.yml`,
  }))
}

describe('deriveColdResumePlan', () => {
  it('restores the persisted route, explicit adapter-independent limits, and latest preset', async () => {
    const { inspection, session } = createInspection('cold-history', {
      cwd: 'D:\\historic-workspace',
      agentPreset: 'historic-created',
    })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'historic-provider',
          model: 'historic-model',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 4096,
        },
      },
    })
    session.append('agent-preset/selected', {
      agentPreset: 'historic-selected',
    })
    const resolvePreset = presetResolver()

    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'cold-history',
      defaultSelection: {
        provider: 'current-provider',
        model: 'current-model',
        reasoningEffort: ReasoningEffortId('low'),
      },
      defaultPresetId: 'current-default',
      resolvePreset,
    })

    expect(plan).toMatchObject({
      selection: {
        provider: 'historic-provider',
        model: 'historic-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      maxTokens: 4096,
      preset: {
        id: 'historic-selected',
        trust: 'system',
        path: 'D:\\presets\\historic-selected\\agent.cordis.yml',
        provenance: 'event',
      },
      provenance: {
        route: 'persisted',
        reasoning: 'persisted',
        maxTokens: 'persisted',
      },
    })
    expect(resolvePreset).toHaveBeenCalledExactlyOnceWith('historic-selected')
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.selection)).toBe(true)
    expect(Object.isFrozen(plan.preset)).toBe(true)
  })

  it('uses programmatic selection and maxTokens without inheriting persisted reasoning', async () => {
    const { inspection, session } = createInspection('explicit', {
      parentSession: SessionId('fork-parent'),
      seedLength: 0,
      delegationDepth: 0,
      agentPreset: 'created-preset',
    })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'persisted-provider',
          model: 'persisted-model',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 2048,
        },
      },
    })

    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'explicit',
      explicitSelection: {
        provider: 'chosen-provider',
        model: 'chosen-model',
      },
      explicitMaxTokens: 8192,
      defaultSelection: {
        provider: 'default-provider',
        model: 'default-model',
      },
      defaultPresetId: 'default-preset',
      resolvePreset: presetResolver(),
    })

    expect(plan.selection).toEqual({
      provider: 'chosen-provider',
      model: 'chosen-model',
    })
    expect(plan.maxTokens).toBe(8192)
    expect(plan.provenance).toEqual({
      route: 'explicit',
      reasoning: 'omitted',
      maxTokens: 'explicit',
    })
    expect(plan.preset.provenance).toBe('header')
    expect(JSON.parse(plan.fingerprint)).toMatchObject({
      profile: 'dsh-tui/roster-required',
      session: {
        parentSession: 'fork-parent',
        seedLength: 0,
        delegationDepth: 0,
        creationAgentPreset: 'created-preset',
      },
    })
  })

  it('keeps an explicit reasoning effort and records its provenance', async () => {
    const { inspection } = createInspection('explicit-reasoning', {
      agentPreset: 'created-preset',
    })
    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'explicit-reasoning',
      explicitSelection: {
        provider: 'chosen-provider',
        model: 'chosen-model',
        reasoningEffort: ReasoningEffortId('max'),
      },
      defaultSelection: { provider: 'default-provider', model: 'default-model' },
      defaultPresetId: 'default-preset',
      resolvePreset: presetResolver(),
    })

    expect(plan.selection.reasoningEffort).toBe(ReasoningEffortId('max'))
    expect(plan.provenance.reasoning).toBe('explicit')
  })

  it('does not freeze adapter-owned reasoning or maxTokens from persisted history', async () => {
    const { inspection, session } = createInspection('adapter-defaults', {
      agentPreset: 'historic-preset',
    })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'persisted-provider',
          model: 'persisted-model',
          reasoningEffort: ReasoningEffortId('adapter-owned'),
          maxTokens: 16384,
        },
        adapterDefaults: { reasoningEffort: true, maxTokens: true },
      },
    })

    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'adapter-defaults',
      defaultSelection: {
        provider: 'default-provider',
        model: 'default-model',
        reasoningEffort: ReasoningEffortId('low'),
      },
      defaultPresetId: 'default-preset',
      resolvePreset: presetResolver(),
    })

    expect(plan.selection).toEqual({
      provider: 'persisted-provider',
      model: 'persisted-model',
    })
    expect(plan).not.toHaveProperty('maxTokens')
    expect(plan.provenance).toEqual({
      route: 'persisted',
      reasoning: 'omitted',
      maxTokens: 'omitted',
    })
  })

  it('uses current defaults only when history has no request or preset facts', async () => {
    const { inspection } = createInspection('legacy-defaults')
    const resolvePreset = presetResolver()
    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'legacy-defaults',
      defaultSelection: {
        provider: 'default-provider',
        model: 'default-model',
        reasoningEffort: ReasoningEffortId('medium'),
      },
      defaultPresetId: 'default-preset',
      resolvePreset,
    })

    expect(plan.selection).toEqual({
      provider: 'default-provider',
      model: 'default-model',
      reasoningEffort: ReasoningEffortId('medium'),
    })
    expect(plan).not.toHaveProperty('maxTokens')
    expect(plan.provenance).toEqual({
      route: 'default',
      reasoning: 'default',
      maxTokens: 'omitted',
    })
    expect(plan.preset).toMatchObject({
      id: 'default-preset',
      provenance: 'default',
    })
    expect(resolvePreset).toHaveBeenCalledExactlyOnceWith('default-preset')
  })

  it('records omitted default reasoning and preserves persisted maxTokens with an explicit route', async () => {
    const { inspection, session } = createInspection('mixed-precedence', {
      agentPreset: 'historic-preset',
    })
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'persisted-provider',
          model: 'persisted-model',
          maxTokens: 3072,
        },
      },
    })
    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'mixed-precedence',
      explicitSelection: { provider: 'chosen-provider', model: 'chosen-model' },
      defaultSelection: { provider: 'default-provider', model: 'default-model' },
      defaultPresetId: 'default-preset',
      resolvePreset: presetResolver(),
    })

    expect(plan.maxTokens).toBe(3072)
    expect(plan.provenance).toEqual({
      route: 'explicit',
      reasoning: 'omitted',
      maxTokens: 'persisted',
    })

    const empty = createInspection('default-no-effort')
    const defaultPlan = await deriveColdResumePlan(empty.inspection, {
      sessionId: 'default-no-effort',
      defaultSelection: { provider: 'default-provider', model: 'default-model' },
      defaultPresetId: 'default-preset',
      resolvePreset: presetResolver(),
    })
    expect(defaultPlan.provenance.reasoning).toBe('omitted')
  })

  it.each([
    { origin: 'subagent' as const },
    { delegationDepth: 1 },
  ])('rejects subagent ownership facts %#', async (header) => {
    const { inspection } = createInspection('subagent', header)
    await expect(deriveColdResumePlan(inspection, {
      sessionId: 'subagent',
      defaultSelection: { provider: 'p', model: 'm' },
      defaultPresetId: 'standard',
      resolvePreset: presetResolver(),
    })).rejects.toThrow('cannot resume subagent session')
  })

  it('can derive composition for a delegated fork source without authorizing resume', async () => {
    const { inspection } = createInspection('subagent-fork-source', {
      origin: 'subagent',
      parentSession: SessionId('owner'),
      agentPreset: 'research',
    })

    const plan = await deriveColdResumePlan(inspection, {
      sessionId: 'subagent-fork-source',
      allowDelegatedSource: true,
      defaultSelection: { provider: 'p', model: 'm' },
      defaultPresetId: 'standard',
      resolvePreset: presetResolver(),
    })

    expect(plan.preset).toMatchObject({ id: 'research', provenance: 'header' })
  })

  it('rejects inspection identity and preset-source identity mismatches', async () => {
    const { inspection } = createInspection('actual', { agentPreset: 'standard' })
    await expect(deriveColdResumePlan(inspection, {
      sessionId: 'requested',
      defaultSelection: { provider: 'p', model: 'm' },
      defaultPresetId: 'standard',
      resolvePreset: presetResolver(),
    })).rejects.toThrow('returned "actual" for "requested"')

    await expect(deriveColdResumePlan(inspection, {
      sessionId: 'actual',
      defaultSelection: { provider: 'p', model: 'm' },
      defaultPresetId: 'standard',
      resolvePreset: async () => ({
        id: 'shadowed',
        trust: 'user',
        path: 'D:\\user\\shadowed\\agent.cordis.yml',
      }),
    })).rejects.toThrow('resolution returned "shadowed" for "standard"')
  })

  it('ignores unrelated appends but detects current preset source changes', async () => {
    const { inspection, session } = createInspection('semantic', {
      cwd: 'D:\\workspace',
      agentPreset: 'standard',
    })
    const options = {
      sessionId: 'semantic',
      defaultSelection: { provider: 'p', model: 'm' },
      defaultPresetId: 'standard',
      resolvePreset: presetResolver('D:\\system-presets'),
    } as const
    const before = await deriveColdResumePlan(inspection, options)
    session.append('todo/write', { todos: [] })
    const afterAppend = await deriveColdResumePlan(inspection, options)
    const movedSource = await deriveColdResumePlan(inspection, {
      ...options,
      resolvePreset: presetResolver('D:\\user-presets'),
    })

    expect(afterAppend.fingerprint).toBe(before.fingerprint)
    expect(movedSource.fingerprint).not.toBe(before.fingerprint)
  })
})
