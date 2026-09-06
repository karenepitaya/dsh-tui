import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { mcpFeature } from '../features/mcp/factory.ts'

export const name = 'dsh-tui-mcp'
export const inject = ['dshTuiFeatures']

/** Register the optional MCP workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, mcpFeature)
}

export { mcpFeature }
