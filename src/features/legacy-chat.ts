import {
  FEATURE_API_VERSION,
  type FeatureFactory,
} from '../kernel/feature.ts'
import type { LayoutRegion } from '../layout/strategy.ts'
import type { NavigationRoute } from '../navigation/state.ts'

const LEGACY_CHAT_ROUTE: NavigationRoute = Object.freeze({ kind: 'chat' })
const LEGACY_CHAT_REGION: LayoutRegion<{ readonly kind: 'legacy-chat-root' }> = Object.freeze({
  id: 'legacy.chat.root',
  role: 'timeline',
  node: Object.freeze({ kind: 'legacy-chat-root' }),
})

/**
 * Milestone-1 strangler seam around the existing product-owned chat surface.
 * It contributes identity and ownership only; the legacy Controller remains
 * the renderer until the dedicated Chat feature is migrated.
 */
export const legacyChatFeature: FeatureFactory = Object.freeze({
  manifest: Object.freeze({
    id: 'legacy.chat',
    apiVersion: FEATURE_API_VERSION,
    scope: 'application',
    activation: 'eager',
    required: true,
    requires: Object.freeze([]),
  }),
  declarations: Object.freeze({
    routes: Object.freeze(['chat']),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'shell.root', cardinality: 'single' }),
    ]),
  }),
  create: () => ({
    contributions: Object.freeze({
      routes: Object.freeze([
        Object.freeze({
          id: 'chat',
          value: LEGACY_CHAT_ROUTE,
        }),
      ]),
      surfaces: Object.freeze([
        Object.freeze({
          id: 'legacy.chat.root',
          slot: 'shell.root',
          value: LEGACY_CHAT_REGION,
        }),
      ]),
    }),
    dispose: () => {},
  }),
})
