/**
 * Audited DSH 0.1.5-rc.2 profile policy.
 *
 * Keep version-sensitive Loader row identities here so an rc upgrade has one
 * compatibility surface and the shipped YAML can be checked against it.
 */
export const DSH_RC2_DISABLED_AGENT_PLANE_ROWS: readonly string[] = Object.freeze([
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
])

export const DSH_RC2_PRODUCT_PROFILE_ROWS: readonly string[] = Object.freeze([
  'dsh-tui',
  'dsh-tui-capabilities',
  'dsh-tui-modes',
  'dsh-tui-models',
  'dsh-tui-sessions',
  'dsh-tui-activity',
  'dsh-tui-dsh-rc2',
  'dsh-tui-legacy-chat',
  'dsh-tui-preferences',
  'dsh-tui-kernel',
  'authorization',
  'code-runtime',
  'cordis-host-runner',
  'time-context',
  'subagent-model-selection-settings',
  'agent-presets',
])
