export const ORB_THEME_NAMES = ["catppuccin", "github", "claude", "openai", "clay"] as const;
export type OrbThemeName = (typeof ORB_THEME_NAMES)[number];

export interface OrbTheme {
  readonly name: string;
  readonly background: string;
  readonly low: string;
  readonly medium: string;
  readonly high: string;
  readonly core: string;
  readonly label: string;
  readonly muted: string;
  readonly error: string;
}

export const ORB_THEMES: Readonly<Record<OrbThemeName, OrbTheme>> = Object.freeze({
  catppuccin: Object.freeze({
    name: "Catppuccin Mocha",
    background: "#1E1E2E",
    low: "#494060",
    medium: "#726090",
    high: "#9D82C2",
    core: "#CBA6F7",
    label: "#CDD6F4",
    muted: "#A6ADC8",
    error: "#F38BA8",
  }),
  github: Object.freeze({
    name: "GitHub Dark",
    background: "#0D1117",
    low: "#1D324E",
    medium: "#2A5083",
    high: "#3771BC",
    core: "#4493F8",
    label: "#F0F6FC",
    muted: "#9198A1",
    error: "#F85149",
  }),
  claude: Object.freeze({
    name: "Claude",
    background: "#141413",
    low: "#452E26",
    medium: "#734536",
    high: "#A55E46",
    core: "#D97757",
    label: "#FAF9F5",
    muted: "#B0AEA5",
    error: "#E06055",
  }),
  openai: Object.freeze({
    name: "OpenAI Mono",
    background: "#111111",
    low: "#4A4A4A",
    medium: "#828282",
    high: "#BEBEBE",
    core: "#FFFFFF",
    label: "#E7E7E7",
    muted: "#A3A3A3",
    error: "#FF6B6B",
  }),
  clay: Object.freeze({
    name: "Clay",
    background: "#171411",
    low: "#41382E",
    medium: "#6A5949",
    high: "#967E66",
    core: "#C4A484",
    label: "#EADFD2",
    muted: "#A99B8C",
    error: "#D96C5F",
  }),
});

const HEX_COLOR = /^#[\da-f]{6}$/iu;

function foregroundSequence(hex: string): string {
  if (!HEX_COLOR.test(hex)) throw new Error(`Invalid Orb theme color: ${hex}`);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function parseHex(hex: string): readonly [number, number, number] {
  if (!HEX_COLOR.test(hex)) throw new Error(`Invalid Orb theme color: ${hex}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function interpolateHexColor(from: string, to: string, progress: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  const amount = Math.max(0, Math.min(1, progress));
  const channels = start.map((channel, index) => {
    const target = end[index] ?? channel;
    return Math.round(channel + ((target - channel) * amount));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const ENERGY_STOPS = [
  [0, "low"],
  [0.35, "medium"],
  [0.70, "high"],
  [1, "core"],
] as const satisfies readonly (readonly [number, keyof OrbTheme])[];

export function orbColorAtEnergy(theme: OrbTheme, energy: number): string {
  const safeEnergy = Math.max(0, Math.min(1, energy));
  for (let index = 1; index < ENERGY_STOPS.length; index += 1) {
    const previous = ENERGY_STOPS[index - 1];
    const next = ENERGY_STOPS[index];
    if (previous === undefined || next === undefined || safeEnergy > next[0]) continue;
    const progress = (safeEnergy - previous[0]) / (next[0] - previous[0]);
    return interpolateHexColor(theme[previous[1]], theme[next[1]], progress);
  }
  return theme.core;
}

export function colorizeOrbGlyph(glyph: string, energy: number, theme: OrbTheme): string {
  return `${foregroundSequence(orbColorAtEnergy(theme, energy))}${glyph}\x1b[39m`;
}

export function colorizeHexText(text: string, color: string): string {
  return `${foregroundSequence(color)}${text}\x1b[39m`;
}

export type OrbThemeTextToken = "label" | "muted" | "high" | "error";

export function colorizeThemeText(
  text: string,
  token: OrbThemeTextToken,
  theme: OrbTheme,
): string {
  return `${foregroundSequence(theme[token])}${text}\x1b[39m`;
}

export function colorizeOrbLabel(label: string, theme: OrbTheme): string {
  return `${foregroundSequence(theme.label)}${label}\x1b[39m`;
}
