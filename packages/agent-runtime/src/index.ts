// @keel/agent-runtime
// The durable state machine. Pure: ports only, no HTTP, no database driver.

export type {
  BudgetPort,
  ClockPort,
  ContextBlock,
  IdPort,
  Intent,
  KnowledgePort,
  ModelPort,
  ModelUsage,
  NewStep,
  PersistedStep,
  PlannedAction,
  PolicyDecision,
  PolicyInput,
  PolicyPort,
  Ports,
  ResolvedTool,
  RunSnapshot,
  StepLogPort,
  StepOutcome,
  ToolPort,
  ToolResult,
} from "./ports.js";
export { CorruptStepLogError, eventOf, replay, verifyAgainst } from "./replay.js";

export { initialSnapshot, type RunInput, run, step } from "./runtime.js";
export {
  InvalidTransitionError,
  isTerminal,
  RUN_STATES,
  type RunState,
  type RuntimeEvent,
  stepTypeFor,
  TERMINAL_STATES,
  type TerminalState,
  transition,
} from "./state.js";
