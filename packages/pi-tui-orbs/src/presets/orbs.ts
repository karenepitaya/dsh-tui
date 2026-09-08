import type { ResolvedGlyphPreference } from "../types.js";

export const ORB_SPEEDS = Object.freeze({
  slow: 2_200,
  normal: 1_600,
  fast: 1_200,
});
export type OrbSpeed = keyof typeof ORB_SPEEDS;

export const ORB_TICK_MS = 50;

export const BREATH_PHASES = Object.freeze({
  restEnd: 0.10,
  inhaleEnd: 0.45,
  apexEnd: 0.50,
});

export const INHALE_BEZIER = [0.33, 0, 0.20, 1] as const;
export const EXHALE_BEZIER = [0.40, 0, 0.67, 1] as const;

function cubicCoordinate(time: number, first: number, second: number): number {
  const inverse = 1 - time;
  return (3 * inverse * inverse * time * first)
    + (3 * inverse * time * time * second)
    + (time * time * time);
}

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  progress: number,
): number {
  const target = Math.max(0, Math.min(1, progress));
  if (target === 0 || target === 1) return target;

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const time = (lower + upper) / 2;
    if (cubicCoordinate(time, x1, x2) < target) lower = time;
    else upper = time;
  }

  return cubicCoordinate((lower + upper) / 2, y1, y2);
}

export function breathEnergy(elapsedMs: number, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new RangeError("Orb period must be a positive finite number.");
  }
  const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const phase = (((safeElapsed % periodMs) + periodMs) % periodMs) / periodMs;

  if (phase < BREATH_PHASES.restEnd) return 0;
  if (phase < BREATH_PHASES.inhaleEnd) {
    const progress = (phase - BREATH_PHASES.restEnd)
      / (BREATH_PHASES.inhaleEnd - BREATH_PHASES.restEnd);
    return cubicBezier(...INHALE_BEZIER, progress);
  }
  if (phase < BREATH_PHASES.apexEnd) return 1;

  const progress = (phase - BREATH_PHASES.apexEnd) / (1 - BREATH_PHASES.apexEnd);
  return 1 - cubicBezier(...EXHALE_BEZIER, progress);
}

export function glyphForBreath(
  energy: number,
  glyphs: ResolvedGlyphPreference,
): string {
  const safeEnergy = Math.max(0, Math.min(1, energy));
  if (safeEnergy < 0.22) return glyphs === "ascii" ? "." : "·";
  if (safeEnergy < 0.84) return glyphs === "ascii" ? "o" : "•";
  return glyphs === "ascii" ? "O" : "●";
}
