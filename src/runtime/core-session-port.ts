import type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
} from '../interaction/port.ts'
import type { DshRuntimeEventItem } from './delivery.ts'
import type { SessionId } from './events.ts'
import type {
  CancelCause,
  Delivery,
  RuntimeEventOptions,
  SubmitInput,
  SubmitOptions,
  SubmitResult,
} from './port.ts'

/**
 * The always-present session seam used by Chat and safety interactions.
 * Optional catalogs and secondary surfaces are acquired through capability
 * leases instead of growing this interface.
 */
export interface CoreSessionPort extends Pick<
  DshInteractionPort,
  'disposeInteractions'
> {
  readonly sessionId: SessionId
  readonly ownsAgentLifecycle: boolean
  events(options?: RuntimeEventOptions): AsyncIterable<DshRuntimeEventItem>
  submit(
    input: SubmitInput,
    delivery: Delivery,
    options?: SubmitOptions,
  ): Promise<SubmitResult>
  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  flush(): Promise<void>
  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot>
  respond(response: InteractionResponse): InteractionReceipt
  dispose(): Promise<void>
}
