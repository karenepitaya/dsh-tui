import type { Component } from "@earendil-works/pi-tui";

export type MotionPreference = "auto" | "full" | "reduced";
export type GlyphPreference = "auto" | "unicode" | "ascii";
export type ColorPreference = "auto" | "always" | "never";
export type ResolvedMotionPreference = Exclude<MotionPreference, "auto">;
export type ResolvedGlyphPreference = Exclude<GlyphPreference, "auto">;
export type ResolvedColorPreference = Exclude<ColorPreference, "auto">;

export type MotionFrame = string | readonly string[];

export interface AdaptiveFrames {
  readonly unicode: readonly MotionFrame[];
  readonly ascii: readonly MotionFrame[];
  readonly reduced?: {
    readonly unicode: MotionFrame;
    readonly ascii: MotionFrame;
  };
}

export interface MotionComponent extends Component {
  readonly running: boolean;
  start(): void;
  stop(): void;
  dispose(): void;
}

export interface MotionLease {
  readonly startedAt: number;
  readonly released: boolean;
  release(): void;
}
