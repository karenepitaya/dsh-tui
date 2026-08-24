import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const DISABLED_AGENT_PLANE = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
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
] as const

interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Readonly<Record<string, unknown>>
  readonly insert?: readonly PatchRow[]
}

async function readPatch(): Promise<readonly PatchRow[]> {
  const source = await readFile(
    fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)),
    'utf8',
  )
  const parsed: unknown = load(source)
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml must contain a patch list')
  return parsed as PatchRow[]
}

describe('DSH-TUI rc.2 profile composition', () => {
  it('atomically moves the official agent plane behind the shipped preset roster', async () => {
    const patches = await readPatch()
    const disabled = patches
      .filter(row => row.disabled === true)
      .map(row => row.id)
    expect(disabled).toEqual(['hmr', ...DISABLED_AGENT_PLANE])

    for (const id of DISABLED_AGENT_PLANE) {
      expect(patches.find(row => row.id === id)).toEqual({ id, disabled: true })
    }

    const inserted = patches.flatMap(row => row.insert ?? [])
    const insertedIds = inserted.map(row => row.id)
    expect(insertedIds).toEqual([
      'code-runtime',
      'cordis-host-runner',
      'agent-presets',
      'dsh-tui',
    ])
    expect(new Set(insertedIds).size).toBe(insertedIds.length)
    const byId = new Map(inserted.map(row => [row.id, row]))
    expect(byId.get('code-runtime')).toEqual({
      id: 'code-runtime',
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
    })
    expect(byId.get('cordis-host-runner')).toEqual({
      id: 'cordis-host-runner',
      name: '@deepseek-ai/dsh-cordis-host-runner',
    })
    expect(byId.get('agent-presets')).toEqual({
      id: 'agent-presets',
      name: '@deepseek-ai/dsh-agent-presets',
      config: { default: 'standard' },
    })
    expect(byId.get('dsh-tui')).toEqual({
      id: 'dsh-tui',
      name: 'dsh-tui',
      config: { autoStart: true },
    })
  })

  it('pins every bundle-owned preset runtime to the audited rc.2 line', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )
    const manifest = JSON.parse(source) as {
      readonly dependencies?: Readonly<Record<string, string>>
    }
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2',
      '@deepseek-ai/dsh-code-runtime-worker-thread': '0.1.1-rc.2',
      '@deepseek-ai/dsh-cordis-host-runner': '0.1.1-rc.2',
    })
  })
})
