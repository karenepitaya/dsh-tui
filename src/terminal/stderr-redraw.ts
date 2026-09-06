import type { Writable } from 'node:stream'

/** Observe completed writes without redirecting diagnostics or taking ownership of errors. */
export function installStderrRedraw(
  stream: Pick<Writable, 'write'>,
  requestRedraw: () => void,
): () => void {
  const original = stream.write
  let active = true
  const write: typeof stream.write = function (this: unknown, ...args: unknown[]): boolean {
    if (!active) return Reflect.apply(original, this, args) as boolean
    const callbackIndex = args.length === 1 || typeof args[1] === 'function' ? 1 : 2
    const callback = args[callbackIndex]
    // Invalid callback arguments still belong to Writable's own validation.
    if (callback !== undefined && callback !== null && typeof callback !== 'function') {
      return Reflect.apply(original, this, args) as boolean
    }
    const forwarded = args.slice()
    forwarded[callbackIndex] = function (this: unknown, ...result: unknown[]): void {
      try {
        if (typeof callback === 'function') Reflect.apply(callback, this, result)
      } finally {
        // Native TTY writes can finish asynchronously. Repair only afterwards,
        // and never re-enter rendering from stderr or a user callback.
        queueMicrotask(() => { if (active) requestRedraw() })
      }
    }
    return Reflect.apply(original, this, forwarded) as boolean
  }
  stream.write = write
  return () => {
    active = false
    // A later owner may wrap us; leave its method installed and make ours inert.
    if (stream.write === write) stream.write = original
  }
}
