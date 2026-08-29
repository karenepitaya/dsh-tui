import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  resolveSessionPreset,
  type AgentPreset,
} from '@deepseek-ai/dsh-agent-presets'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { isDelegatedSession } from './session-eligibility.ts'

export interface ColdResumePlanOptions {
  readonly sessionId: string
  /** Fork planning may read delegated history; this never authorizes resuming it. */
  readonly allowDelegatedSource?: boolean
  readonly explicitSelection?: ModelSelection
  readonly explicitMaxTokens?: number
  readonly defaultSelection: ModelSelection
  readonly defaultPresetId: string
  readonly resolvePreset: (
    id: string,
  ) => Promise<Pick<AgentPreset, 'id' | 'trust' | 'path'>>
}

export interface ColdResumePlan {
  readonly sessionId: string
  readonly selection: ModelSelection
  readonly maxTokens?: number
  readonly provenance: {
    readonly route: 'explicit' | 'persisted' | 'default'
    readonly reasoning: 'explicit' | 'persisted' | 'default' | 'omitted'
    readonly maxTokens: 'explicit' | 'persisted' | 'omitted'
  }
  readonly preset: Pick<AgentPreset, 'id' | 'trust' | 'path'> & {
    readonly provenance: 'event' | 'header' | 'default'
  }
  readonly fingerprint: string
}

function optionalFact<T>(value: T | undefined): T | null {
  return value ?? null
}

function latestSelectedPreset(
  inspection: SessionInspection,
): string | undefined {
  for (let index = inspection.events.length - 1; index >= 0; index -= 1) {
    const event = inspection.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return undefined
}

function semanticFingerprint(
  inspection: SessionInspection,
  plan: Omit<ColdResumePlan, 'fingerprint'>,
): string {
  const header = inspection.meta
  return JSON.stringify({
    profile: 'dsh-tui/roster-required',
    session: {
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      cwd: optionalFact(header.cwd),
      parentSession: optionalFact(header.parentSession),
      seedLength: optionalFact(header.seedLength),
      origin: optionalFact(header.origin),
      delegationDepth: optionalFact(header.delegationDepth),
      creationAgentPreset: optionalFact(header.agentPreset),
    },
    selection: {
      provider: plan.selection.provider,
      model: plan.selection.model,
      reasoningEffort: optionalFact(plan.selection.reasoningEffort),
      routeProvenance: plan.provenance.route,
      reasoningProvenance: plan.provenance.reasoning,
    },
    maxTokens: {
      value: optionalFact(plan.maxTokens),
      provenance: plan.provenance.maxTokens,
    },
    preset: plan.preset,
  })
}

/** Derive the construction-time values that an exact cold resume must preserve. */
export async function deriveColdResumePlan(
  inspection: SessionInspection,
  options: ColdResumePlanOptions,
): Promise<ColdResumePlan> {
  if (inspection.meta.id !== options.sessionId) {
    throw new Error(
      `DSH cold resume inspection returned "${inspection.meta.id}" for "${options.sessionId}"`,
    )
  }
  if (
    options.allowDelegatedSource !== true
    && isDelegatedSession(inspection.meta)
  ) {
    throw new Error(`DSH-TUI cannot resume subagent session "${options.sessionId}"`)
  }

  const persisted = foldRequestHeader(inspection.events)
  let selection: ModelSelection
  let routeProvenance: ColdResumePlan['provenance']['route']
  let reasoningProvenance: ColdResumePlan['provenance']['reasoning']
  if (options.explicitSelection !== undefined) {
    selection = { ...options.explicitSelection }
    routeProvenance = 'explicit'
    reasoningProvenance = options.explicitSelection.reasoningEffort === undefined
      ? 'omitted'
      : 'explicit'
  } else if (persisted !== undefined) {
    const reasoningEffort = persisted.adapterDefaults?.reasoningEffort === true
      ? undefined
      : persisted.config.reasoningEffort
    selection = {
      provider: persisted.config.provider,
      model: persisted.config.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    routeProvenance = 'persisted'
    reasoningProvenance = reasoningEffort === undefined ? 'omitted' : 'persisted'
  } else {
    selection = { ...options.defaultSelection }
    routeProvenance = 'default'
    reasoningProvenance = options.defaultSelection.reasoningEffort === undefined
      ? 'omitted'
      : 'default'
  }

  const persistedMaxTokens = persisted?.adapterDefaults?.maxTokens === true
    ? undefined
    : persisted?.config.maxTokens
  const maxTokens = options.explicitMaxTokens ?? persistedMaxTokens
  const maxTokensProvenance: ColdResumePlan['provenance']['maxTokens'] =
    options.explicitMaxTokens !== undefined
      ? 'explicit'
      : persistedMaxTokens !== undefined
        ? 'persisted'
        : 'omitted'

  const eventPreset = latestSelectedPreset(inspection)
  const historicalPreset = resolveSessionPreset({
    header: inspection.meta,
    events: inspection.events,
  })
  const presetId = historicalPreset ?? options.defaultPresetId
  const presetProvenance: ColdResumePlan['preset']['provenance'] =
    eventPreset !== undefined
      ? 'event'
      : historicalPreset !== undefined
        ? 'header'
        : 'default'
  const resolvedPreset = await options.resolvePreset(presetId)
  if (resolvedPreset.id !== presetId) {
    throw new Error(
      `DSH Agent preset resolution returned "${resolvedPreset.id}" for "${presetId}"`,
    )
  }

  const withoutFingerprint: Omit<ColdResumePlan, 'fingerprint'> = {
    sessionId: options.sessionId,
    selection,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    provenance: {
      route: routeProvenance,
      reasoning: reasoningProvenance,
      maxTokens: maxTokensProvenance,
    },
    preset: {
      id: resolvedPreset.id,
      trust: resolvedPreset.trust,
      path: resolvedPreset.path,
      provenance: presetProvenance,
    },
  }
  return deepFreeze({
    ...withoutFingerprint,
    fingerprint: semanticFingerprint(inspection, withoutFingerprint),
  })
}
