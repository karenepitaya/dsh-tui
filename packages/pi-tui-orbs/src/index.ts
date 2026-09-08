export { AnimatedFrames, type AnimatedFramesOptions } from "./animated-frames.js";
export { SettingsWorkspace, fitsSettingsConfirmation } from "./settings-workspace.js";
export {
  NEUTRAL_SETTINGS_WORKSPACE_THEME,
  type SettingsWorkspaceCategory,
  type SettingsWorkspaceChoice,
  type SettingsWorkspaceConfirmation,
  type SettingsWorkspaceDialog,
  type SettingsWorkspaceControl,
  type SettingsWorkspaceCursor,
  type SettingsWorkspaceEditor,
  type SettingsWorkspaceField,
  type SettingsWorkspaceGroup,
  type SettingsWorkspaceModal,
  type SettingsWorkspaceModel,
  type SettingsWorkspacePicker,
  type SettingsWorkspaceRole,
  type SettingsWorkspaceTheme,
} from "./settings-workspace-model.js";
export {
  type PreparedAdaptiveFrames,
  type PreparedFrame,
  type PreparedFrameGroup,
  prepareAdaptiveFrames,
} from "./frame-set.js";
export {
  MotionHost,
  type MotionHostOptions,
  type MotionLeaseOptions,
} from "./motion-host.js";
export {
  createOrbsRuntime,
  OrbsRuntime,
  type OrbsRuntimeOptions,
} from "./orbs-runtime.js";
export { Orb, type OrbOptions } from "./orb.js";
export { GradientBar, type GradientBarOptions } from "./gradient-bar.js";
export {
  EFFORT_METER_COMPACT_WIDTH,
  EFFORT_METER_FULL_WIDTH,
  EffortMeter,
  MODEL_EFFORTS,
  type EffortMeterOptions,
  type ModelEffort,
} from "./effort-meter.js";
export {
  MODEL_STATUS_PHASES,
  ModelStatusline,
  type ModelContextUsage,
  type ModelStatuslineOptions,
  type ModelStatuslineSnapshot,
  type ModelStatuslineStatus,
  type ModelStatusPhase,
} from "./model-statusline.js";
export {
  ChoiceControl,
  ControlPanel,
  SliderControl,
  ToggleControl,
  type ChoiceControlOptions,
  type ChoiceItem,
  type ControlAdjustment,
  type ControlPanelOptions,
  type LabControl,
  type LabControlColor,
  type LabControlGlyphs,
  type LabControlOptions,
  type LabControlTheme,
  type SliderControlOptions,
  type ToggleControlOptions,
} from "./lab-controls.js";
export {
  ShimmerText,
  type ShimmerState,
  type ShimmerTextOptions,
} from "./shimmer-text.js";
export {
  ExecutionStatus,
  type ExecutionPhase,
  type ExecutionStatusOptions,
} from "./execution-status.js";
export {
  TodoList,
  type TodoItem,
  type TodoListOptions,
  type TodoState,
} from "./todo-list.js";
export {
  GRADIENT_BAR_PERIODS,
  GRADIENT_BAR_TICK_MS,
  gradientBarCellEnergy,
  gradientBarPosition,
} from "./presets/gradient-bars.js";
export {
  StreamingText,
  type StreamingTextOptions,
} from "./streaming-text.js";
export {
  SHIMMER_PERIOD_MS,
  SHIMMER_PERIODS,
  SHIMMER_SOFT_BEZIER,
  SHIMMER_TICK_MS,
  SHIMMER_VELOCITIES,
  shimmerDirectionalEnergyAt,
  shimmerEnergyAt,
  shimmerFrameAt,
  shimmerPosition,
  shimmerWeight,
  type ShimmerCurve,
  type ShimmerDirection,
  type ShimmerFrame,
  type ShimmerFrameOptions,
  type ShimmerHeading,
  type ShimmerLoop,
  type ShimmerPosition,
} from "./presets/shimmer.js";
export {
  AGENT_STATUS_KINDS,
  AgentStatus,
  type AgentStatusKind,
  type AgentStatusOptions,
  type AgentStatusPhase,
} from "./agent-status.js";
export {
  AGENT_REQUEST_PHASES,
  AGENT_REQUEST_TICK_MS,
  AgentRequestStatus,
  type AgentRequestPhase,
  type AgentRequestStatusOptions,
  type AgentRequestStatusUpdate,
} from "./agent-request-status.js";
export {
  AgentRequestRuntime,
  createAgentRequestRuntime,
  type AgentRequestRuntimeOptions,
} from "./agent-request.js";
export {
  BREATH_PHASES,
  breathEnergy,
  cubicBezier,
  EXHALE_BEZIER,
  glyphForBreath,
  INHALE_BEZIER,
  ORB_SPEEDS,
  ORB_TICK_MS,
  type OrbSpeed,
} from "./presets/orbs.js";
export {
  type PreferenceContext,
  resolveColorPreference,
  resolveGlyphPreference,
  resolveMotionPreference,
} from "./preferences.js";
export {
  colorizeHexText,
  colorizeOrbGlyph,
  colorizeOrbLabel,
  colorizeThemeText,
  interpolateHexColor,
  orbColorAtEnergy,
  ORB_THEME_NAMES,
  ORB_THEMES,
  type OrbTheme,
  type OrbThemeName,
  type OrbThemeTextToken,
} from "./themes.js";
export type {
  AdaptiveFrames,
  ColorPreference,
  GlyphPreference,
  MotionComponent,
  MotionFrame,
  MotionLease,
  MotionPreference,
  ResolvedColorPreference,
  ResolvedGlyphPreference,
  ResolvedMotionPreference,
} from "./types.js";
