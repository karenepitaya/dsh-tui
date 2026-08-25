export type {
  AgentStatus,
  DshDurableEvent,
  DshDurableEventMap,
  DshRuntimeEvent,
  DshRuntimeEventMap,
  DshTuiEvent,
  DurableDshEnvelope,
  LiveSourceId,
  RuntimeDshEnvelope,
  SessionId,
  SurfaceOp,
  UiAssistantChunk,
  UiAssistantDelta,
  UiContentBlock,
  UiImageAttachmentRef,
  UiImageContentBlock,
  UiMessage,
  UiReasoningContentBlock,
  UiReasoningDelta,
  UiTextContentBlock,
  UiTextDelta,
  UiToolCallContentBlock,
  UiUnsupportedAssistantChunk,
  UiUnsupportedContentBlock,
  UiCommandSource,
  UiTodoItem,
  UiTokenUsage,
} from './runtime/events.ts'
export {
  projectUiAssistantChunks,
  projectUiMessageContent,
} from './presentation/message-content.ts'
export type {
  UiAssistantDraftProjection,
  UiMessageContentProjection,
} from './presentation/message-content.ts'
export type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
  PendingApprovalInteraction,
  PendingInteraction,
  PendingQuestionInteraction,
  UiQuestion,
  UiQuestionAnswer,
  UiQuestionAnswerItem,
  UiQuestionIntent,
  UiQuestionOption,
} from './interaction/port.ts'
export {
  DshTuiSessionPort,
} from './runtime/tui-session-port.ts'
export type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandInputDescriptor,
  DshCommandPort,
  DshCommandResult,
  DshParsedCommand,
} from './command/port.ts'
export type {
  SessionCatalogDurability,
  SessionCatalogEntry,
  SessionCatalogListOptions,
  SessionCatalogPort,
  SessionCatalogSnapshot,
  SessionDurablePresence,
} from './session/catalog-port.ts'
export type {
  AgentPresetCatalogEntry,
  AgentPresetCatalogPort,
  AgentPresetCatalogSnapshot,
  AgentPresetSelectionPlan,
  AgentPresetTrust,
  ListAgentPresetsOptions,
} from './preset/catalog-port.ts'
export {
  SessionInspectionError,
} from './session/inspection-port.ts'
export type {
  SessionInspectionErrorCode,
  SessionInspectionHeader,
  SessionInspectionPort,
  SessionInspectionRequest,
  SessionInspectionSnapshot,
} from './session/inspection-port.ts'
export {
  COMMAND_MENU_LIMIT,
  commandCompletion,
  createCommandMenuState,
  decideCommandDispatch,
  dismissCommandMenu,
  moveCommandMenuSelection,
  selectCommandMenu,
} from './command/menu.ts'
export type {
  CommandMenuCandidate,
  CommandDispatchDecision,
  CommandMenuState,
  CommandMenuView,
} from './command/menu.ts'
export {
  SESSION_PICKER_LIMIT,
  applySessionPickerAction,
  createSessionPickerState,
  openSessionPicker,
  reconcileSessionPicker,
  selectSessionPicker,
} from './session/picker.ts'
export {
  STARTUP_PRESET_PICKER_LIMIT,
  applyStartupPresetPickerAction,
  createStartupPresetPickerState,
  openStartupPresetPicker,
  reconcileStartupPresetPicker,
  selectStartupPresetPicker,
} from './preset/picker.ts'
export type {
  StartupPresetPickerAction,
  StartupPresetPickerOutcome,
  StartupPresetPickerRow,
  StartupPresetPickerState,
  StartupPresetPickerTransition,
  StartupPresetPickerView,
} from './preset/picker.ts'
export {
  SESSION_INSPECTION_REPLAY_BATCH,
  projectSessionInspection,
} from './session/inspection-projection.ts'
export type {
  SessionPickerAction,
  SessionPickerOutcome,
  SessionPickerRelation,
  SessionPickerRow,
  SessionPickerState,
  SessionPickerTransition,
  SessionPickerView,
} from './session/picker.ts'
export type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  RuntimeReplayBoundary,
  SubmitInput,
  SubmitResult,
} from './runtime/port.ts'
export {
  convertSessionEvent,
} from './dsh/session-event-adapter.ts'
export {
  DshAgentRuntimePort,
  openDshRuntimePort,
} from './dsh/runtime-port.ts'
export {
  DshCommandSession,
} from './dsh/command-session.ts'
export {
  DshLiveSessionActivation,
} from './dsh/session-activation.ts'
export {
  DshColdResumeBusyError,
  DshColdResumeCoordinator,
  DshColdResumeExternalWinnerError,
  DshColdResumeSemanticDriftError,
} from './dsh/cold-resume-coordinator.ts'
export type {
  DshColdResumeRequest,
} from './dsh/cold-resume-coordinator.ts'
export {
  DshColdSessionActivation,
  DshSessionActivation,
} from './dsh/cold-session-activation.ts'
export {
  deriveColdResumePlan,
} from './dsh/cold-resume-plan.ts'
export type {
  ColdResumePlan,
  ColdResumePlanOptions,
} from './dsh/cold-resume-plan.ts'
export {
  DshSessionCatalog,
} from './dsh/session-catalog.ts'
export {
  DshSessionInspection,
  SESSION_INSPECTION_COPY_BATCH,
} from './dsh/session-inspection.ts'
export {
  DshAgentPresetCatalog,
} from './dsh/agent-preset-catalog.ts'
export type {
  DshAgentRuntimeLease,
  OpenDshRuntimeBase,
  OpenDshRuntimeOptions,
} from './dsh/runtime-port.ts'
export type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from './session/activation-port.ts'
export {
  apply,
  inject,
  name,
} from './plugin.ts'
export type {
  Config,
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from './plugin.ts'
export {
  parseDshTuiStartup,
} from './dsh/startup.ts'
export {
  InteractionSettlement,
  InteractionSettlementError,
} from './interaction/settlement.ts'
export type {
  InteractionFallbacks,
} from './interaction/settlement.ts'
export {
  applyInteractionReceipt,
  createInteractionEditorState,
  prepareInteractionCancel,
  prepareInteractionSubmit,
  reconcileInteractionEditor,
  reduceInteractionEditor,
  selectDshTuiInputMode,
} from './interaction/editor.ts'
export type {
  ActiveApprovalEditor,
  ActiveInteractionEditor,
  ActiveQuestionEditor,
  DshTuiInputMode,
  InteractionEditorCommand,
  InteractionEditorState,
} from './interaction/editor.ts'
export {
  decodeTerminalInput,
} from './terminal/input.ts'
export type {
  TerminalInputAction,
} from './terminal/input.ts'
export {
  mapTerminalPacket,
  TerminalInputDecoder,
} from './terminal/input-decoder.ts'
export type {
  TerminalInputDecoderOptions,
  TerminalInputPacket,
} from './terminal/input-decoder.ts'
export {
  PiTerminalDriver,
  RawBytePiTerminal,
  TERMINAL_RECOVERY_SEQUENCE,
} from './terminal/driver.ts'
export type {
  PiTerminalDriverOptions,
  TerminalByteInput,
  TerminalDriver,
  TerminalDriverCallbacks,
  TerminalDriverState,
  TerminalOutput,
} from './terminal/driver.ts'
export {
  createPromptEditorState,
  reducePromptEditor,
} from './ui/prompt-editor.ts'
export type {
  PromptEditorAction,
  PromptEditorState,
} from './ui/prompt-editor.ts'
export {
  renderDshFrame,
  renderStartupPresetFrame,
  sessionInspectionMaxScrollOffset,
} from './ui/frame.ts'
export type {
  DshTuiView,
  SessionInspectionCatalogObservation,
  SessionInspectionPanel,
  SessionPickerPanel,
  StartupPresetPanel,
  TerminalViewport,
  UiCursor,
  UiFrame,
} from './ui/frame.ts'
export {
  FrameScheduler,
} from './ui/frame-scheduler.ts'
export type {
  FrameInvalidationPriority,
  FrameSchedulerOptions,
} from './ui/frame-scheduler.ts'
export {
  DshTuiController,
} from './app/controller.ts'
export type {
  DshTuiApplicationPort,
  DshTuiControllerOptions,
  DshTuiControllerResult,
  DshTuiControllerState,
  DshTuiExitReason,
  DshTuiProductPort,
} from './app/controller.ts'
export {
  DshTuiProductRunner,
  sanitizeDshTuiProductError,
} from './app/runner.ts'
export type {
  DshTuiControllerPort,
  DshTuiOpenRequest,
  DshTuiProductRunnerOptions,
  DshTuiStartupRequest,
} from './app/runner.ts'
export {
  selectStartupPreset,
} from './app/startup-preset-selector.ts'
export type {
  StartupPresetSelectionLease,
  StartupPresetSelectionResult,
  StartupPresetSelector,
  StartupPresetSelectorOptions,
} from './app/startup-preset-selector.ts'
export {
  ShutdownCoordinator,
} from './lifecycle/shutdown.ts'
export type {
  ShutdownHooks,
  ShutdownIssue,
  ShutdownPhase,
  ShutdownResult,
} from './lifecycle/shutdown.ts'
export {
  UI_PROJECTION_LIMITS,
  createSessionUiState,
  createUiState,
} from './transcript/state.ts'
export {
  reduceUiEvent,
  replayUiEvents,
  selectSession,
  setUiPhase,
} from './transcript/reducer.ts'
export type {
  AssistantDraftRow,
  AssistantRow,
  CommandKey,
  CommandProtocolDiagnostics,
  CommandRow,
  ContextReplacement,
  SessionUiState,
  StepKey,
  ToolKey,
  ToolRow,
  TranscriptRow,
  UiFailure,
  UiState,
  UserRow,
} from './transcript/state.ts'
