import type { DshToolPresentationAnnotation } from '../dsh/tool-presentation.ts'
import type { DshTuiEvent } from './events.ts'

/**
 * Ephemeral delivery metadata rides beside, never inside, the durable event.
 * Top-level event fields are mirrored only so existing in-process ports can be
 * introduced incrementally; consumers must reduce `event`, not this wrapper.
 */
export type DshEventDelivery = DshTuiEvent & {
  readonly event: DshTuiEvent
  readonly toolPresentation?: DshToolPresentationAnnotation
}

export type DshRuntimeEventItem = DshTuiEvent | DshEventDelivery

export function createDshEventDelivery(
  event: DshTuiEvent,
  toolPresentation?: DshToolPresentationAnnotation,
): DshEventDelivery {
  return {
    ...event,
    event,
    ...(toolPresentation === undefined ? {} : { toolPresentation }),
  }
}

export function unpackDshEventDelivery(item: DshRuntimeEventItem): {
  readonly event: DshTuiEvent
  readonly toolPresentation?: DshToolPresentationAnnotation
} {
  if ('event' in item) {
    return {
      event: item.event,
      ...(item.toolPresentation === undefined
        ? {}
        : { toolPresentation: item.toolPresentation }),
    }
  }
  return { event: item }
}
