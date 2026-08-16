// @keel/api
// HTTP surface and module composition. The HTTP layer lands in a later session;
// what exists today is the persistence layer each module owns.

export { createPool } from "./db/pool.js";
export {
  type ActorScope,
  type OrgScope,
  scopedQuery,
  scopedQueryOne,
  withActorScope,
  withOrgScope,
} from "./db/scope.js";
export * as approvalsRepo from "./modules/approvals/approvals.repo.js";
export * as conversationsRepo from "./modules/conversations/conversations.repo.js";
export * as identityRepo from "./modules/identity/identity.repo.js";
export * as knowledgeRepo from "./modules/knowledge/knowledge.repo.js";
export {
  ACL_PREDICATE,
  aclPredicate,
  countExcludedByAcl,
  type Principal,
  type RetrievedChunk,
  type RetrieveInput,
  retrieve,
} from "./modules/knowledge/retrieval.repo.js";
export * as agentsRepo from "./modules/projects/agents.repo.js";
export {
  type ApprovalDecision,
  type ApprovalWait,
  deliverDecision,
  pendingWait,
  resetWaits,
} from "./modules/realtime/approval-waits.js";
export type { RecordDecision } from "./modules/realtime/approvals-route.js";
export type { Drive, DriveContext } from "./modules/realtime/drive.js";
export type { AguiEvent } from "./modules/realtime/events.js";
export {
  CLAIM_TTL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyStore,
  InMemoryIdempotencyStore,
  idempotencyGate,
  rememberResponse,
  scopeKey,
} from "./modules/realtime/idempotency-gate.js";
export { type Actor, type Owned, sameActor } from "./modules/realtime/ownership.js";
export {
  cancelRun,
  emit,
  endRun,
  getRun,
  type LiveRun,
  publish,
  resetRegistry,
  type Subscriber,
  startRun,
  subscribe,
} from "./modules/realtime/registry.js";
export { scriptedDrive } from "./modules/realtime/scripted-drive.js";
export {
  createRealtimeServer,
  type RealtimeDeps,
  type Sessions,
} from "./modules/realtime/server.js";
export {
  encodeFrame,
  framesAfter,
  KEEPALIVE,
  SSE_HEADERS,
  type SseFrame,
} from "./modules/realtime/sse.js";
export * as runsRepo from "./modules/runs/runs.repo.js";
export * as toolsRepo from "./modules/tools/tools.repo.js";
