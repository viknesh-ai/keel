// @keel/tool-runtime
// Tool adapters: server, client, MCP, OpenAPI, workflow, navigation.

export {
  type ExecuteInput,
  type ExecuteResult,
  executeTool,
} from "./execute/executor.js";
export { CancelledError, type HttpCallInput, httpCall } from "./execute/http-adapter.js";
export {
  claimTtlSeconds,
  DEDUPE_TTL_SECONDS,
  type DedupeOutcome,
  type DedupeStore,
  deriveIdempotencyKey,
  type IdempotencyIssue,
  type IdempotencyResult,
  InMemoryDedupeStore,
  readPath,
} from "./execute/idempotency.js";
export {
  backoffMs,
  isRetryableTool,
  planRecovery,
  type RecoveryPlan,
  retryClassAllowed,
  type ToolRetryFacts,
} from "./execute/recovery.js";
export {
  describeVerificationFailure,
  type PostCondition,
  postConditionSchema,
  type ReadBack,
  type VerificationOutcome,
  verifyPostConditions,
} from "./execute/verification.js";
export {
  type DereferenceIssue,
  type DereferenceResult,
  dereference,
} from "./openapi/dereference.js";
export { emitToolsYaml } from "./openapi/emit.js";
export {
  type GeneratedTool,
  type GenerateIssue,
  type GenerateResult,
  generateFromSpec,
} from "./openapi/generate.js";
