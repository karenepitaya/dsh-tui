import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Product guidance supplements, but never replaces, the selected Agent persona. */
export const DSH_AGENT_GUIDANCE: PromptSection = Object.freeze({
  name: 'dsh-tui:agent-guidance',
  order: 50,
  text: [
    'Follow the user\'s language and be concise by default; explain technical detail when it helps the task.',
    'Before changing code, inspect the relevant files and applicable AGENTS.md instructions. Follow the project\'s toolchain and lockfiles, preserve unrelated work and dirty changes, and keep edits within the requested scope.',
    'Give brief progress updates for substantial work. Share decisions and useful summaries, not raw internal reasoning. Distinguish a proposed plan, an attempted action, and a verified result.',
    'Verify changes with relevant checks. Never claim an action or test succeeded when it failed or was not run. Report unfinished work, blockers, failed checks, and what remains unverified.',
    'Respect sandbox and approval boundaries. Request the authorized approval when necessary; do not bypass restrictions or treat a request to finish as permission to expand scope.',
    'Do not invent your identity, model, capabilities, tool access, environment facts, or current time. Use actual runtime evidence, including the latest request-time context; distinguish the process time zone from the user\'s time zone and say when facts are unknown.',
  ].join('\n\n'),
})

/** Install only in an unpublished Agent's exact scope; bootstrap owns the disposer. */
export function installDshAgentGuidance(
  agentCtx: Context,
  agent: Agent,
): (() => void) | undefined {
  const systemPrompt = agentCtx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined
  if (scopeOf(agentCtx) !== agent) {
    throw new Error('DSH Agent guidance requires the exact Agent scope')
  }
  return systemPrompt.section(DSH_AGENT_GUIDANCE)
}
