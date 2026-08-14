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
export * as conversationsRepo from "./modules/conversations/conversations.repo.js";
export * as identityRepo from "./modules/identity/identity.repo.js";
export * as agentsRepo from "./modules/projects/agents.repo.js";
export type { AguiEvent } from "./modules/realtime/events.js";
export {
  cancelRun,
  emit,
  endRun,
  getRun,
  type LiveRun,
  resetRegistry,
  startRun,
} from "./modules/realtime/registry.js";

export {
  createRealtimeServer,
  type RealtimeDeps,
  type Sessions,
  scriptedDrive,
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
