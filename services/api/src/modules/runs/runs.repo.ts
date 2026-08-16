import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

export type RunRow = {
  id: string;
  org_id: string;
  project_id: string;
  environment_id: string;
  conversation_id: string | null;
  agent_version_id: string;
  identity_id: string | null;
  trigger: string;
  state: string;
  idempotency_key: string | null;
  simulated: boolean;
  next_seq: number;
  started_at: Date;
  ended_at: Date | null;
  error_class: string | null;
  cost_usd: string;
  tokens_in: number;
  tokens_out: number;
};

export type RunStepRow = {
  id: string;
  org_id: string;
  run_id: string;
  seq: number;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  integrity: string;
  error_class: string | null;
  tool_version_id: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  latency_ms: number | null;
  started_at: Date;
  ended_at: Date | null;
};

export type StepType =
  | "context"
  | "retrieval"
  | "model"
  | "tool"
  | "policy"
  | "approval"
  | "verify"
  | "recover"
  | "route"
  | "response";

export async function createRun(
  scope: OrgScope,
  input: {
    projectId: string;
    environmentId: string;
    agentVersionId: string;
    trigger: string;
    conversationId?: string;
    identityId?: string;
    idempotencyKey?: string;
    simulated?: boolean;
  },
): Promise<RunRow> {
  const row = await scopedQueryOne<RunRow>(
    scope,
    `insert into runs
       (org_id, project_id, environment_id, agent_version_id, trigger,
        conversation_id, identity_id, idempotency_key, simulated)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [
      scope.orgId,
      input.projectId,
      input.environmentId,
      input.agentVersionId,
      input.trigger,
      input.conversationId ?? null,
      input.identityId ?? null,
      input.idempotencyKey ?? null,
      input.simulated ?? false,
    ],
  );
  if (row === undefined) throw new Error("createRun returned no row");
  return row;
}

/**
 * Idempotent start. A replayed request with the same key returns the original
 * run rather than starting a second one — the unique index on
 * (project_id, idempotency_key) is what makes the race safe rather than likely.
 */
export async function findRunByIdempotencyKey(
  scope: OrgScope,
  projectId: string,
  idempotencyKey: string,
): Promise<RunRow | undefined> {
  return scopedQueryOne<RunRow>(
    scope,
    "select * from runs where project_id = $1 and idempotency_key = $2",
    [projectId, idempotencyKey],
  );
}

export async function getRun(scope: OrgScope, runId: string): Promise<RunRow | undefined> {
  return scopedQueryOne<RunRow>(scope, "select * from runs where id = $1", [runId]);
}

export async function listRuns(scope: OrgScope, projectId: string, limit = 25): Promise<RunRow[]> {
  return scopedQuery<RunRow>(
    scope,
    "select * from runs where project_id = $1 order by started_at desc limit $2",
    [projectId, limit],
  );
}

export async function transitionRun(
  scope: OrgScope,
  runId: string,
  state: string,
): Promise<RunRow | undefined> {
  return scopedQueryOne<RunRow>(scope, "update runs set state = $2 where id = $1 returning *", [
    runId,
    state,
  ]);
}

export async function endRun(
  scope: OrgScope,
  runId: string,
  input: { state: string; errorClass?: string },
): Promise<RunRow | undefined> {
  return scopedQueryOne<RunRow>(
    scope,
    "update runs set state = $2, error_class = $3, ended_at = now() where id = $1 returning *",
    [runId, input.state, input.errorClass ?? null],
  );
}

/**
 * Cancels a run (doc 01 §4.2, session 2.5).
 *
 * Two properties, both of which are the point:
 *
 * - It is conditional on the run not already being terminal, in one statement.
 *   A cancel that overwrote `Completed` would rewrite history to say the user
 *   stopped something that had in fact finished.
 * - It touches `runs` only. The partial trace stays exactly as it was, because
 *   `run_steps` is append-only and a cancelled run is the case where the steps
 *   matter most: "how far did it get before I stopped it?" is unanswerable if
 *   cancelling tidies up after itself.
 */
export async function cancelRun(
  scope: OrgScope,
  runId: string,
  reason?: string,
): Promise<RunRow | undefined> {
  return scopedQueryOne<RunRow>(
    scope,
    `update runs
        set state = 'Cancelled', error_class = $2, ended_at = now()
      where id = $1
        and state not in ('Completed', 'Failed', 'Denied', 'Expired', 'Cancelled')
      returning *`,
    [runId, reason ?? null],
  );
}

/**
 * Append a step.
 *
 * The sequence number comes from `runs.next_seq`, taken under that row's lock
 * by the UPDATE itself. This is the resolution of the conflict documented at the
 * top of migration 0003: `run_steps` is partitioned by `started_at`, so a unique
 * constraint on (run_id, seq) alone is not creatable, and a run that pauses for
 * approval across a month boundary would otherwise be able to reuse a seq. The
 * counter makes (run_id, seq) unique by construction instead.
 *
 * There is no update or delete counterpart, and keel_app holds no privilege for
 * either: `run_steps` is append-only and a correction is a new step
 * (doc 04 §B3 invariant 4).
 */
export async function appendStep(
  scope: OrgScope,
  input: {
    runId: string;
    type: StepType;
    status: "ok" | "error" | "skipped" | "pending";
    payload?: Record<string, unknown>;
    integrity?: "system" | "developer" | "user" | "tool" | "external";
    errorClass?: string;
    toolVersionId?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    latencyMs?: number;
  },
): Promise<RunStepRow> {
  const allocated = await scopedQueryOne<{ seq: number }>(
    scope,
    "update runs set next_seq = next_seq + 1 where id = $1 returning next_seq - 1 as seq",
    [input.runId],
  );
  if (allocated === undefined) throw new Error(`no such run: ${input.runId}`);

  const row = await scopedQueryOne<RunStepRow>(
    scope,
    `insert into run_steps
       (org_id, run_id, seq, type, status, payload, integrity, error_class,
        tool_version_id, model, tokens_in, tokens_out, cost_usd, latency_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning *`,
    [
      scope.orgId,
      input.runId,
      allocated.seq,
      input.type,
      input.status,
      JSON.stringify(input.payload ?? {}),
      input.integrity ?? "system",
      input.errorClass ?? null,
      input.toolVersionId ?? null,
      input.model ?? null,
      input.tokensIn ?? 0,
      input.tokensOut ?? 0,
      input.costUsd ?? 0,
      input.latencyMs ?? null,
    ],
  );
  if (row === undefined) throw new Error("appendStep returned no row");

  // Run totals are the sum of their steps. Accumulating here rather than
  // recomputing on read keeps the run list cheap, which is the query an
  // operator runs most.
  await scopedQuery(
    scope,
    `update runs
        set tokens_in = tokens_in + $2,
            tokens_out = tokens_out + $3,
            cost_usd = cost_usd + $4
      where id = $1`,
    [input.runId, input.tokensIn ?? 0, input.tokensOut ?? 0, input.costUsd ?? 0],
  );

  return row;
}

/** The trace, in order. This is what the run-detail screen renders. */
export async function listSteps(scope: OrgScope, runId: string): Promise<RunStepRow[]> {
  return scopedQuery<RunStepRow>(scope, "select * from run_steps where run_id = $1 order by seq", [
    runId,
  ]);
}
