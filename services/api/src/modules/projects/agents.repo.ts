import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

/**
 * Agents and their immutable versions.
 *
 * Every function takes an OrgScope first. That is not a convention here — the
 * type cannot be constructed outside withOrgScope, so there is no call site
 * that reaches these queries without a tenant and without RLS active.
 */

export type AgentRow = {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  slug: string;
  current_version_id: string | null;
  created_at: Date;
};

export type AgentVersionRow = {
  id: string;
  org_id: string;
  agent_id: string;
  version: number;
  instructions: string;
  model_config: Record<string, unknown>;
  tool_selection: string[];
  knowledge_snapshot_id: string | null;
  policy_version_id: string | null;
  workflow_bindings: unknown;
  published_at: Date;
  published_by: string | null;
  notes: string | null;
};

export async function createAgent(
  scope: OrgScope,
  input: { projectId: string; name: string; slug: string },
): Promise<AgentRow> {
  const row = await scopedQueryOne<AgentRow>(
    scope,
    `insert into agents (org_id, project_id, name, slug)
     values ($1, $2, $3, $4) returning *`,
    [scope.orgId, input.projectId, input.name, input.slug],
  );
  if (row === undefined) throw new Error("createAgent returned no row");
  return row;
}

export async function getAgent(scope: OrgScope, agentId: string): Promise<AgentRow | undefined> {
  return scopedQueryOne<AgentRow>(scope, "select * from agents where id = $1", [agentId]);
}

export async function listAgents(scope: OrgScope, projectId: string): Promise<AgentRow[]> {
  return scopedQuery<AgentRow>(
    scope,
    "select * from agents where project_id = $1 order by created_at desc",
    [projectId],
  );
}

export async function renameAgent(
  scope: OrgScope,
  agentId: string,
  name: string,
): Promise<AgentRow | undefined> {
  return scopedQueryOne<AgentRow>(scope, "update agents set name = $2 where id = $1 returning *", [
    agentId,
    name,
  ]);
}

export async function deleteAgent(scope: OrgScope, agentId: string): Promise<boolean> {
  const rows = await scopedQuery(scope, "delete from agents where id = $1 returning id", [agentId]);
  return rows.length === 1;
}

/**
 * Publishing is insert-then-point: a new immutable version row, then the
 * agent's pointer moved to it. Both in the scope's transaction, so a run can
 * never observe an agent pointing at a version that does not exist.
 *
 * The version number is taken under the agent's row lock rather than computed
 * from a prior SELECT, so two concurrent publishes cannot both claim v3.
 */
export async function publishAgentVersion(
  scope: OrgScope,
  input: {
    agentId: string;
    instructions: string;
    modelConfig?: Record<string, unknown>;
    toolSelection?: readonly string[];
    publishedBy?: string;
    notes?: string;
  },
): Promise<AgentVersionRow> {
  const locked = await scopedQueryOne<{ id: string }>(
    scope,
    "select id from agents where id = $1 for update",
    [input.agentId],
  );
  if (locked === undefined) throw new Error(`no such agent: ${input.agentId}`);

  const next = await scopedQueryOne<{ version: number }>(
    scope,
    "select coalesce(max(version), 0) + 1 as version from agent_versions where agent_id = $1",
    [input.agentId],
  );

  const version = await scopedQueryOne<AgentVersionRow>(
    scope,
    `insert into agent_versions
       (org_id, agent_id, version, instructions, model_config, tool_selection,
        published_by, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      scope.orgId,
      input.agentId,
      next?.version ?? 1,
      input.instructions,
      JSON.stringify(input.modelConfig ?? {}),
      input.toolSelection ?? [],
      input.publishedBy ?? null,
      input.notes ?? null,
    ],
  );
  if (version === undefined) throw new Error("publishAgentVersion returned no row");

  await scopedQuery(scope, "update agents set current_version_id = $2 where id = $1", [
    input.agentId,
    version.id,
  ]);

  return version;
}

export async function getAgentVersion(
  scope: OrgScope,
  versionId: string,
): Promise<AgentVersionRow | undefined> {
  return scopedQueryOne<AgentVersionRow>(scope, "select * from agent_versions where id = $1", [
    versionId,
  ]);
}

export async function listAgentVersions(
  scope: OrgScope,
  agentId: string,
): Promise<AgentVersionRow[]> {
  return scopedQuery<AgentVersionRow>(
    scope,
    "select * from agent_versions where agent_id = $1 order by version desc",
    [agentId],
  );
}
