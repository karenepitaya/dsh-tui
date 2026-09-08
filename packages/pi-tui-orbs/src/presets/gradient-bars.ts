import type { OrbSpeed } from "./orbs.js";

export const GRADIENT_BAR_PERIODS: Readonly<Record<OrbSpeed, number>> = Object.freeze({
  slow: 1_800,
  normal: 1_300,
  fast: 900,
});

export const GRADIENT_BAR_TICK_MS = 50;

export function gradientBarPosition(elapsedMs: number, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new RangeError("Gradient bar period must be a positive finite number.");
  }
  const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const phase = (((safeElapsed % periodMs) + periodMs) % periodMs) / periodMs;
  return 0.5 - (0.5 * Math.cos(2 * Math.PI * phase));
}

export function gradientBarCellEnergy(
  cellIndex: number,
  cellCount: number,
  position: number,
): number {
  if (!Number.isInteger(cellCount) || cellCount < 1) {
    throw new RangeError("Gradient bar cell count must be a positive integer.");
  }
  const safeIndex = Math.max(0, Math.min(cellCount - 1, cellIndex));
  const safePosition = Math.max(0, Math.min(1, position));
  const center = safePosition * Math.max(0, cellCount - 1);
  const distance = (safeIndex - center) / 1.25;
  return Math.exp(-0.5 * distance * distance);
}
