import { resolveColorPreference, resolveGlyphPreference, resolveMotionPreference } from "./preferences.js";
import type {
  ColorPreference,
  GlyphPreference,
  MotionLease,
  MotionPreference,
  ResolvedColorPreference,
  ResolvedGlyphPreference,
  ResolvedMotionPreference,
} from "./types.js";

export interface MotionHostOptions {
  readonly motion?: MotionPreference;
  readonly glyphs?: GlyphPreference;
  readonly color?: ColorPreference;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
}

export interface MotionLeaseOptions {
  readonly expiresAt?: number;
  readonly onExpire?: () => void;
}

interface MotionLeaseRecord {
  readonly intervalMs: number;
  readonly expiresAt?: number;
  readonly expire: () => void;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
  const candidate = timer as { unref?: () => void };
  candidate.unref?.();
}

export class MotionHost {
  readonly motion: ResolvedMotionPreference;
  readonly glyphs: ResolvedGlyphPreference;
  readonly color: ResolvedColorPreference;

  readonly #requestRender: () => void;
  readonly #now: () => number;
  readonly #leases = new Map<symbol, MotionLeaseRecord>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(requestRender: () => void, options: MotionHostOptions = {}) {
    this.#requestRender = requestRender;
    this.#now = options.now ?? (() => performance.now());

    const env = options.env ?? process.env;
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;
    const context = { env, isTTY };
    this.motion = resolveMotionPreference(options.motion ?? "auto", context);
    this.glyphs = resolveGlyphPreference(options.glyphs ?? "auto", context);
    this.color = resolveColorPreference(options.color ?? "auto", context);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  now(): number {
    return this.#now();
  }

  requestRender(): void {
    if (!this.#disposed) this.#requestRender();
  }

  retain(intervalMs: number, options: MotionLeaseOptions = {}): MotionLease {
    if (this.#disposed) throw new Error("MotionHost has been disposed.");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("Motion interval must be a positive finite number.");
    }

    const id = Symbol("motion-lease");
    const startedAt = this.now();
    const expiresAt = options.expiresAt;
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= startedAt)) {
      throw new RangeError("Motion lease expiry must be later than its start time.");
    }
    let released = false;

    const expire = (): void => {
      if (released) return;
      released = true;
      options.onExpire?.();
    };

    if (this.motion === "full") {
      const record: MotionLeaseRecord = expiresAt === undefined
        ? { intervalMs, expire }
        : { intervalMs, expiresAt, expire };
      this.#leases.set(id, record);
      this.#reschedule();
    }
    this.requestRender();

    return {
      startedAt,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#leases.delete(id)) this.#reschedule();
        this.requestRender();
      },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#leases.clear();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #reschedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || this.#leases.size === 0) return;

    const now = this.now();
    const intervalMs = Math.min(...[...this.#leases.values()].map((lease) => {
      if (lease.expiresAt === undefined) return lease.intervalMs;
      return Math.min(lease.intervalMs, Math.max(0, lease.expiresAt - now));
    }));
    const timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        const tickAt = this.now();
        const expired: MotionLeaseRecord[] = [];
        for (const [id, lease] of this.#leases) {
          if (lease.expiresAt === undefined || lease.expiresAt > tickAt) continue;
          this.#leases.delete(id);
          expired.push(lease);
        }
        let expirationError: unknown;
        let expirationFailed = false;
        for (const lease of expired) {
          try {
            lease.expire();
          } catch (error) {
            if (!expirationFailed) expirationError = error;
            expirationFailed = true;
          }
        }
        this.#requestRender();
        if (expirationFailed) throw expirationError;
      } finally {
        this.#reschedule();
      }
    }, intervalMs);
    this.#timer = timer;
    unrefTimer(timer);
  }
}
