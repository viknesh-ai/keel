import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

export type ToolRow = {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  target: string;
  current_version_id: string | null;
  enabled: boolean;
  created_at: Date;
};

export type ToolVersionRow = {
  id: string;
  org_id: string;
  tool_id: string;
  version: number;
  contract: Record<string, unknown>;
  source: string;
  source_ref: string | null;
  checksum: string;
  created_at: Date;
};

export type ToolBindingRow = {
  id: string;
  org_id: string;
  tool_version_id: string;
  environment_id: string;
  auth_binding: Record<string, unknown>;
  base_url: string | null;
  secret_ref: string | null;
  enabled: boolean;
  created_at: Date;
};

export async function createTool(
  scope: OrgScope,
  input: { projectId: string; name: string; target: string },
): Promise<ToolRow> {
  // `enabled` is not settable here. A tool is created disabled and turned on by
  // an explicit, separate act — default-deny (CLAUDE.md hard rule 6).
  const row = await scopedQueryOne<ToolRow>(
    scope,
    "insert into tools (org_id, project_id, name, target) values ($1, $2, $3, $4) returning *",
    [scope.orgId, input.projectId, input.name, input.target],
  );
  if (row === undefined) throw new Error("createTool returned no row");
  return row;
}

export async function getTool(scope: OrgScope, toolId: string): Promise<ToolRow | undefined> {
  return scopedQueryOne<ToolRow>(scope, "select * from tools where id = $1", [toolId]);
}

export async function listTools(
  scope: OrgScope,
  projectId: string,
  options: { enabledOnly?: boolean } = {},
): Promise<ToolRow[]> {
  return options.enabledOnly === true
    ? scopedQuery<ToolRow>(
        scope,
        "select * from tools where project_id = $1 and enabled order by name",
        [projectId],
      )
    : scopedQuery<ToolRow>(scope, "select * from tools where project_id = $1 order by name", [
        projectId,
      ]);
}

export async function setToolEnabled(
  scope: OrgScope,
  toolId: string,
  enabled: boolean,
): Promise<ToolRow | undefined> {
  return scopedQueryOne<ToolRow>(scope, "update tools set enabled = $2 where id = $1 returning *", [
    toolId,
    enabled,
  ]);
}

export async function deleteTool(scope: OrgScope, toolId: string): Promise<boolean> {
  const rows = await scopedQuery(scope, "delete from tools where id = $1 returning id", [toolId]);
  return rows.length === 1;
}

export async function publishToolVersion(
  scope: OrgScope,
  input: {
    toolId: string;
    contract: Record<string, unknown>;
    source: string;
    sourceRef?: string;
    checksum: string;
  },
): Promise<ToolVersionRow> {
  const locked = await scopedQueryOne<{ id: string }>(
    scope,
    "select id from tools where id = $1 for update",
    [input.toolId],
  );
  if (locked === undefined) throw new Error(`no such tool: ${input.toolId}`);

  const next = await scopedQueryOne<{ version: number }>(
    scope,
    "select coalesce(max(version), 0) + 1 as version from tool_versions where tool_id = $1",
    [input.toolId],
  );

  const version = await scopedQueryOne<ToolVersionRow>(
    scope,
    `insert into tool_versions (org_id, tool_id, version, contract, source, source_ref, checksum)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [
      scope.orgId,
      input.toolId,
      next?.version ?? 1,
      JSON.stringify(input.contract),
      input.source,
      input.sourceRef ?? null,
      input.checksum,
    ],
  );
  if (version === undefined) throw new Error("publishToolVersion returned no row");

  await scopedQuery(scope, "update tools set current_version_id = $2 where id = $1", [
    input.toolId,
    version.id,
  ]);

  return version;
}

export async function listToolVersions(scope: OrgScope, toolId: string): Promise<ToolVersionRow[]> {
  return scopedQuery<ToolVersionRow>(
    scope,
    "select * from tool_versions where tool_id = $1 order by version desc",
    [toolId],
  );
}

export async function bindTool(
  scope: OrgScope,
  input: {
    toolVersionId: string;
    environmentId: string;
    authBinding?: Record<string, unknown>;
    baseUrl?: string;
    secretRef?: string;
  },
): Promise<ToolBindingRow> {
  const row = await scopedQueryOne<ToolBindingRow>(
    scope,
    `insert into tool_bindings
       (org_id, tool_version_id, environment_id, auth_binding, base_url, secret_ref)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tool_version_id, environment_id) do update
       set auth_binding = excluded.auth_binding,
           base_url = excluded.base_url,
           secret_ref = excluded.secret_ref
     returning *`,
    [
      scope.orgId,
      input.toolVersionId,
      input.environmentId,
      JSON.stringify(input.authBinding ?? { kind: "none" }),
      input.baseUrl ?? null,
      input.secretRef ?? null,
    ],
  );
  if (row === undefined) throw new Error("bindTool returned no row");
  return row;
}

export async function listBindings(
  scope: OrgScope,
  environmentId: string,
): Promise<ToolBindingRow[]> {
  return scopedQuery<ToolBindingRow>(
    scope,
    "select * from tool_bindings where environment_id = $1 order by created_at",
    [environmentId],
  );
}
