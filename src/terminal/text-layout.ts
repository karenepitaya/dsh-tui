/**
 * Terminal text-layout adapter boundary.
 *
 * Presentation code consumes these product-owned primitives instead of
 * importing the retained UI toolkit directly. A future renderer can replace
 * the adapter without changing transcript or feature projection code.
 */
export {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
