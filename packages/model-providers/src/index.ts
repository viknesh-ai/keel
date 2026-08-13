// @keel/model-providers
// Provider interface, implementations and the task-class router (doc 01 §5).

export { type Budget, BudgetAccumulator, type Spend } from "./budget.js";
export { isAbort, ProviderError, type ProviderFailure, toKeelError } from "./errors.js";
export { estimateCostUsd, isLocal, isPriced, PRICES, type Price, priceFor } from "./pricing.js";
export { type AnthropicOptions, AnthropicProvider } from "./providers/anthropic.js";
export {
  type OpenAiCompatibleOptions,
  OpenAiCompatibleProvider,
} from "./providers/openai-compatible.js";
export {
  ModelRouter,
  type RoutedCall,
  type RouterConfig,
  type RouteTarget,
  type RoutingDecision,
  UnknownProviderError,
} from "./router.js";
export type {
  Capability,
  EmbedRequest,
  EmbedResult,
  FinishReason,
  GenerateEvent,
  GenerateRequest,
  Message,
  ModelProvider,
  Role,
  Structured,
  StructuredRequest,
  TaskClass,
  TokenCountInput,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";
export { addUsage, emptyUsage } from "./types.js";
