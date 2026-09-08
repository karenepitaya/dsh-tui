import type {
  ColorPreference,
  GlyphPreference,
  MotionPreference,
  ResolvedColorPreference,
  ResolvedGlyphPreference,
  ResolvedMotionPreference,
} from "./types.js";

export interface PreferenceContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
}

function isTruthyEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function resolveMotionPreference(
  preference: MotionPreference,
  context: PreferenceContext,
): ResolvedMotionPreference {
  if (preference !== "auto") return preference;
  if (!context.isTTY) return "reduced";
  if (context.env.TERM?.toLowerCase() === "dumb") return "reduced";
  if (isTruthyEnvironmentFlag(context.env.CI)) return "reduced";
  return "full";
}

export function resolveGlyphPreference(
  preference: GlyphPreference,
  context: PreferenceContext,
): ResolvedGlyphPreference {
  if (preference !== "auto") return preference;
  if (context.env.TERM?.toLowerCase() === "dumb") return "ascii";

  const locale = context.env.LC_ALL ?? context.env.LC_CTYPE ?? context.env.LANG;
  if (locale === "C" || locale === "POSIX") return "ascii";
  return "unicode";
}

export function resolveColorPreference(
  preference: ColorPreference,
  context: PreferenceContext,
): ResolvedColorPreference {
  if (preference !== "auto") return preference;
  if (!context.isTTY) return "never";
  if (context.env.TERM?.toLowerCase() === "dumb") return "never";
  if (Object.hasOwn(context.env, "NO_COLOR")) return "never";
  return "always";
}
