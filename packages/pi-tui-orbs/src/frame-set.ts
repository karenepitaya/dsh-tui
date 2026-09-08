import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { AdaptiveFrames, MotionFrame } from "./types.js";

export type PreparedFrame = readonly string[];

export interface PreparedFrameGroup {
  readonly frames: readonly PreparedFrame[];
  readonly reduced: PreparedFrame;
}

export interface PreparedAdaptiveFrames {
  readonly unicode: PreparedFrameGroup;
  readonly ascii: PreparedFrameGroup;
}

function normalizeFrame(frame: MotionFrame): PreparedFrame {
  const lines = typeof frame === "string" ? [frame] : [...frame];
  if (lines.length === 0) throw new Error("A motion frame must contain at least one line.");
  return Object.freeze(lines);
}

function assertSafeLine(line: string, kind: "unicode" | "ascii"): void {
  if (stripTerminalSequences(line) !== line) {
    throw new Error(`${kind} motion frames cannot contain terminal control sequences.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(line)) {
    throw new Error(`${kind} motion frames cannot contain control characters.`);
  }
  if (kind === "ascii" && /[^\x20-\x7e]/u.test(line)) {
    throw new Error("ASCII motion frames must contain printable 7-bit ASCII only.");
  }
}

function assertGeometry(
  frame: PreparedFrame,
  expectedWidths: readonly number[],
  kind: "unicode" | "ascii",
): void {
  if (frame.length !== expectedWidths.length) {
    throw new Error(`${kind} motion frames must all have the same number of lines.`);
  }
  frame.forEach((line, row) => {
    assertSafeLine(line, kind);
    if (visibleWidth(line) !== expectedWidths[row]) {
      throw new Error(`${kind} motion frame row ${row} changes visible width.`);
    }
  });
}

function prepareGroup(
  kind: "unicode" | "ascii",
  frames: readonly MotionFrame[],
  reducedFrame: MotionFrame | undefined,
): PreparedFrameGroup {
  if (frames.length === 0) throw new Error(`${kind} motion frames cannot be empty.`);

  const prepared = frames.map(normalizeFrame);
  const first = prepared[0];
  if (first === undefined) throw new Error(`${kind} motion frames cannot be empty.`);
  const expectedWidths = first.map((line) => visibleWidth(line));
  for (const frame of prepared) assertGeometry(frame, expectedWidths, kind);

  const reduced = normalizeFrame(reducedFrame ?? first);
  assertGeometry(reduced, expectedWidths, kind);

  return Object.freeze({
    frames: Object.freeze(prepared),
    reduced,
  });
}

export function prepareAdaptiveFrames(frames: AdaptiveFrames): PreparedAdaptiveFrames {
  return Object.freeze({
    unicode: prepareGroup("unicode", frames.unicode, frames.reduced?.unicode),
    ascii: prepareGroup("ascii", frames.ascii, frames.reduced?.ascii),
  });
}
