import type { Context } from '@deepseek-ai/cordis'
import type { AgentPreset, AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type {
  AgentPresetCatalogEntry,
  AgentPresetCatalogPort,
  AgentPresetCatalogSnapshot,
  ListAgentPresetsOptions,
} from '../preset/catalog-port.ts'

type OfficialAgentPresets = Pick<AgentPresets, 'defaultId' | 'list'>

function copyEntry(preset: AgentPreset, defaultId: string): AgentPresetCatalogEntry {
  return Object.freeze({
    id: preset.id,
    trust: preset.trust,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    sourcePath: preset.path,
    isDefault: preset.id === defaultId,
  })
}

/** Official AgentPresets adapter for live, read-only preset discovery. */
export class DshAgentPresetCatalog implements AgentPresetCatalogPort {
  private readonly agentPresets: OfficialAgentPresets

  constructor(ctx: Context) {
    const agentPresets = ctx.get('agentPresets')
    if (agentPresets === undefined) {
      throw new Error('DSH AgentPresets service is unavailable')
    }
    this.agentPresets = agentPresets
  }

  async listPresets(
    options: ListAgentPresetsOptions = {},
  ): Promise<AgentPresetCatalogSnapshot> {
    const signal = options.signal
    signal?.throwIfAborted()
    const defaultId = this.agentPresets.defaultId
    const officialPresets = await this.agentPresets.list()
    signal?.throwIfAborted()
    const presets = Object.freeze(
      officialPresets.map(preset => copyEntry(preset, defaultId)),
    )
    return Object.freeze({ defaultId, presets })
  }
}
