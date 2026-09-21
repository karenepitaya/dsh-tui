import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  DSH_RC2_DISABLED_AGENT_PLANE_ROWS,
  DSH_RC2_PRODUCT_PROFILE_ROWS,
} from '../src/compat/dsh-rc2/profile-policy.ts'

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
  it('installs the official request-time clock with process-zone defaults', async () => {
    const inserted = (await readPatch()).flatMap(row => row.insert ?? [])
    expect(inserted.find(row => row.id === 'time-context')).toEqual({
      id: 'time-context',
      name: '@deepseek-ai/dsh-time-context',
      config: { refreshIntervalMs: 0 },
    })
  })

  it('atomically moves the official agent plane behind the shipped preset roster', async () => {
    const patches = await readPatch()
    const disabled = patches
      .filter(row => row.disabled === true)
      .map(row => row.id)
    expect(disabled).toEqual(['hmr', ...DSH_RC2_DISABLED_AGENT_PLANE_ROWS])

    for (const id of DSH_RC2_DISABLED_AGENT_PLANE_ROWS) {
      expect(patches.find(row => row.id === id)).toEqual({ id, disabled: true })
    }

    const inserted = patches.flatMap(row => row.insert ?? [])
    const insertedIds = inserted.map(row => row.id)
    expect(insertedIds).toEqual(DSH_RC2_PRODUCT_PROFILE_ROWS)
    expect(new Set(insertedIds).size).toBe(insertedIds.length)
    const byId = new Map(inserted.map(row => [row.id, row]))
    expect(byId.get('authorization')).toEqual({
      id: 'authorization',
      name: '@deepseek-ai/dsh-authorization',
    })
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
      name: 'dsh-tui/product',
    })
    expect(byId.get('dsh-tui-dsh-rc2')).toEqual({
      id: 'dsh-tui-dsh-rc2',
      name: 'dsh-tui/adapters/dsh-rc2',
    })
    expect(byId.get('dsh-tui-capabilities')).toEqual({
      id: 'dsh-tui-capabilities',
      name: 'dsh-tui/features/capabilities',
    })
    expect(byId.get('dsh-tui-modes')).toEqual({
      id: 'dsh-tui-modes',
      name: 'dsh-tui/features/modes',
    })
    expect(byId.get('dsh-tui-models')).toEqual({
      id: 'dsh-tui-models',
      name: 'dsh-tui/features/models',
    })
    expect(byId.get('dsh-tui-sessions')).toEqual({
      id: 'dsh-tui-sessions',
      name: 'dsh-tui/features/sessions',
    })
    expect(byId.get('dsh-tui-activity')).toEqual({
      id: 'dsh-tui-activity',
      name: 'dsh-tui/features/activity',
    })
    expect(byId.get('dsh-tui-legacy-chat')).toEqual({
      id: 'dsh-tui-legacy-chat',
      name: 'dsh-tui/features/legacy-chat',
    })
    expect(byId.get('dsh-tui-preferences')).toEqual({
      id: 'dsh-tui-preferences',
      name: 'dsh-tui/adapters/preferences',
    })
    expect(byId.get('dsh-tui-kernel')).toEqual({
      id: 'dsh-tui-kernel',
      name: 'dsh-tui/adapters/cordis',
    })
    expect(inserted.some(row => row.name === 'dsh-tui')).toBe(false)
  })

  it('pins every bundle-owned preset runtime to the audited 0.1.5-rc.2 line', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )
    const manifest = JSON.parse(source) as {
      readonly dependencies?: Readonly<Record<string, string>>
    }
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-agent-presets': '0.1.5-rc.2',
      '@deepseek-ai/dsh-authorization': '0.1.5-rc.2',
      '@deepseek-ai/dsh-code-runtime-worker-thread': '0.1.5-rc.2',
      '@deepseek-ai/dsh-cordis-host-runner': '0.1.5-rc.2',
      '@deepseek-ai/dsh-time-context': '0.1.5-rc.2',
    })
  })
})
