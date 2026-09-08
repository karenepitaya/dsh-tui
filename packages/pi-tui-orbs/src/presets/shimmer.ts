import { cubicBezier, type OrbSpeed } from "./orbs.js";

export const SHIMMER_TICK_MS = 50;
export const SHIMMER_PERIODS: Readonly<Record<OrbSpeed, number>> = Object.freeze({
  slow: 1_400,
  normal: 1_000,
  fast: 760,
});
export const SHIMMER_PERIOD_MS = SHIMMER_PERIODS.normal;

export const SHIMMER_VELOCITIES: Readonly<Record<OrbSpeed, number>> = Object.freeze({
  slow: 12,
  normal: 20,
  fast: 32,
});

export const SHIMMER_SOFT_BEZIER = [0.42, 0, 0.58, 1] as const;

export type ShimmerDirection = "left-to-right" | "right-to-left";
export type ShimmerLoop = "wrap" | "ping-pong" | "once";
export type ShimmerCurve = "linear" | "soft";
export type ShimmerHeading = 1 | -1;

export interface ShimmerPosition {
  readonly position: number;
  readonly finished: boolean;
}

export interface ShimmerFrameOptions {
  readonly trackWidth: number;
  readonly velocity: number;
  readonly coreWidth: number;
  readonly trailLength: number;
  readonly holdMs: number;
  readonly direction: ShimmerDirection;
  readonly loop: ShimmerLoop;
  readonly curve: ShimmerCurve;
}

export interface ShimmerFrame {
  readonly beamCenter: number;
  readonly heading: ShimmerHeading;
  readonly active: boolean;
  readonly finished: boolean;
}

function positiveDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("Shimmer duration must be a positive finite number.");
  }
  return durationMs;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function finiteCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number.`);
  }
  return value;
}

function validDirection(direction: ShimmerDirection): ShimmerDirection {
  if (direction !== "left-to-right" && direction !== "right-to-left") {
    throw new TypeError("Shimmer direction must be left-to-right or right-to-left.");
  }
  return direction;
}

function validLoop(loop: ShimmerLoop): ShimmerLoop {
  if (loop !== "wrap" && loop !== "ping-pong" && loop !== "once") {
    throw new TypeError("Shimmer loop must be wrap, ping-pong, or once.");
  }
  return loop;
}

function validCurve(curve: ShimmerCurve): ShimmerCurve {
  if (curve !== "linear" && curve !== "soft") {
    throw new TypeError("Shimmer curve must be linear or soft.");
  }
  return curve;
}

function validHeading(heading: ShimmerHeading): ShimmerHeading {
  if (heading !== 1 && heading !== -1) {
    throw new TypeError("Shimmer heading must be 1 or -1.");
  }
  return heading;
}

function eased(progress: number, curve: ShimmerCurve): number {
  if (curve === "linear") return progress;
  return cubicBezier(...SHIMMER_SOFT_BEZIER, progress);
}

export function shimmerPosition(
  elapsedMs: number,
  durationMs: number,
  direction: ShimmerDirection,
  loop: ShimmerLoop,
  curve: ShimmerCurve,
): ShimmerPosition {
  const duration = positiveDuration(durationMs);
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  let progress: number;
  let finished = false;

  if (loop === "once") {
    progress = Math.min(1, elapsed / duration);
    finished = elapsed >= duration;
  } else if (loop === "ping-pong") {
    const leg = elapsed / duration;
    const legIndex = Math.floor(leg);
    const legProgress = leg - legIndex;
    progress = legIndex % 2 === 0 ? legProgress : 1 - legProgress;
  } else {
    progress = (elapsed % duration) / duration;
  }

  const curved = eased(progress, curve);
  return {
    position: direction === "left-to-right" ? curved : 1 - curved,
    finished,
  };
}

/**
 * Resolves one direction-aware shimmer frame in terminal-cell coordinates.
 * Velocity is the average center travel in cells per second. Both headings use
 * the same offscreen endpoints so ping-pong can reverse without a center jump.
 */
export function shimmerFrameAt(
  elapsedMs: number,
  options: ShimmerFrameOptions,
): ShimmerFrame {
  const safeElapsed = Math.max(0, finiteCoordinate(elapsedMs, "Shimmer elapsed time"));
  const trackWidth = positiveFinite(options.trackWidth, "Shimmer track width");
  const velocity = positiveFinite(options.velocity, "Shimmer velocity");
  const coreWidth = positiveFinite(options.coreWidth, "Shimmer core width");
  const trailLength = nonNegativeFinite(options.trailLength, "Shimmer trail length");
  const holdMs = nonNegativeFinite(options.holdMs, "Shimmer hold time");
  const initialHeading: ShimmerHeading = validDirection(options.direction) === "left-to-right"
    ? 1
    : -1;
  const loop = validLoop(options.loop);
  const curve = validCurve(options.curve);

  const offscreenExtent = Math.max(coreWidth, trailLength);
  const lowerCenter = -offscreenExtent;
  const upperCenter = trackWidth + offscreenExtent;
  const travelDistance = upperCenter - lowerCenter;
  const travelMs = (travelDistance / velocity) * 1_000;

  const centerAt = (heading: ShimmerHeading, progress: number): number => {
    const start = heading === 1 ? lowerCenter : upperCenter;
    const end = heading === 1 ? upperCenter : lowerCenter;
    return start + ((end - start) * eased(progress, curve));
  };

  if (loop === "once") {
    const finished = safeElapsed >= travelMs;
    const progress = finished ? 1 : safeElapsed / travelMs;
    return {
      beamCenter: centerAt(initialHeading, progress),
      heading: initialHeading,
      active: !finished,
      finished,
    };
  }

  const legMs = travelMs + holdMs;
  const legIndex = Math.floor(safeElapsed / legMs);
  const legElapsed = safeElapsed - (legIndex * legMs);
  const heading: ShimmerHeading = loop === "ping-pong" && legIndex % 2 === 1
    ? (initialHeading === 1 ? -1 : 1)
    : initialHeading;
  const active = legElapsed < travelMs;

  return {
    beamCenter: centerAt(heading, active ? legElapsed / travelMs : 1),
    heading,
    active,
    finished: false,
  };
}

export function shimmerEnergyAt(position: number, center: number, spread: number): number {
  if (!Number.isFinite(spread) || spread <= 0) {
    throw new RangeError("Shimmer spread must be a positive finite number.");
  }
  const safePosition = Number.isFinite(position) ? position : 0;
  const safeCenter = Number.isFinite(center) ? center : 0;
  const distance = (safePosition - safeCenter) / spread;
  return Math.exp(-0.5 * distance * distance);
}

/**
 * Returns a directional band energy. The leading half-core is compact while
 * the trailing side can extend for trailLength cells; reversing heading mirrors
 * the result exactly.
 */
export function shimmerDirectionalEnergyAt(
  position: number,
  beamCenter: number,
  heading: ShimmerHeading,
  coreWidth: number,
  trailLength: number,
  curve: ShimmerCurve,
): number {
  const safePosition = finiteCoordinate(position, "Shimmer sample position");
  const safeCenter = finiteCoordinate(beamCenter, "Shimmer beam center");
  const safeHeading = validHeading(heading);
  const safeCoreWidth = positiveFinite(coreWidth, "Shimmer core width");
  const safeTrailLength = nonNegativeFinite(trailLength, "Shimmer trail length");
  const safeCurve = validCurve(curve);

  const directedDistance = (safePosition - safeCenter) * safeHeading;
  const leadingExtent = safeCoreWidth / 2;
  const trailingExtent = Math.max(leadingExtent, safeTrailLength);
  const extent = directedDistance < 0 ? trailingExtent : leadingExtent;
  const progress = Math.abs(directedDistance) / extent;
  if (progress >= 1) return 0;
  return 1 - eased(progress, safeCurve);
}

export function shimmerWeight(energy: number, peak = 0.86): number {
  const safeEnergy = Math.max(0, Math.min(1, Number.isFinite(energy) ? energy : 0));
  const safePeak = Math.max(0, Math.min(1, Number.isFinite(peak) ? peak : 0));
  if (safeEnergy < 0.12) return 0;
  if (safeEnergy < 0.35) return safePeak * (0.18 / 0.86);
  if (safeEnergy < 0.65) return safePeak * (0.38 / 0.86);
  if (safeEnergy < 0.88) return safePeak * (0.62 / 0.86);
  return safePeak;
}
