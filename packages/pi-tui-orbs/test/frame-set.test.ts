import { describe, expect, it } from "vitest";
import { prepareAdaptiveFrames } from "../src/index.js";

describe("frame validation", () => {
  it("accepts stable Unicode and printable ASCII geometry", () => {
    const result = prepareAdaptiveFrames({
      unicode: ["·●", "●·"],
      ascii: [".O", "O."],
    });
    expect(result.unicode.frames).toHaveLength(2);
    expect(result.ascii.reduced).toEqual([".O"]);
  });

  it("rejects geometry changes, control sequences, and non-ASCII fallback glyphs", () => {
    expect(() => prepareAdaptiveFrames({ unicode: ["·", "··"], ascii: ["."] }))
      .toThrow(/changes visible width/u);
    expect(() => prepareAdaptiveFrames({ unicode: ["\x1b[31m●"], ascii: ["O"] }))
      .toThrow(/control sequences/u);
    expect(() => prepareAdaptiveFrames({ unicode: ["●"], ascii: ["●"] }))
      .toThrow(/7-bit ASCII/u);
  });
});
