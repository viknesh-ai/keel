import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

export type ConversationRow = {
  id: string;
  org_id: string;
  project_id: string;
  environment_id: string;
  identity_id: string | null;
  agent_version_id: string;
  title: string | null;
  status: string;
  started_at: Date;
  last_activity_at: Date;
  metadata: Record<string, unknown>;
};

export type MessageRow = {
  id: string;
  org_id: string;
  conversation_id: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: Date;
};

export async function createConversation(
  scope: OrgScope,
  input: {
    projectId: string;
    environmentId: string;
    agentVersionId: string;
    identityId?: string;
    title?: string;
  },
): Promise<ConversationRow> {
  const row = await scopedQueryOne<ConversationRow>(
    scope,
    `insert into conversations
       (org_id, project_id, environment_id, agent_version_id, identity_id, title)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      scope.orgId,
      input.projectId,
      input.environmentId,
      input.agentVersionId,
      input.identityId ?? null,
      input.title ?? null,
    ],
  );
  if (row === undefined) throw new Error("createConversation returned no row");
  return row;
}

export async function getConversation(
  scope: OrgScope,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  return scopedQueryOne<ConversationRow>(scope, "select * from conversations where id = $1", [
    conversationId,
  ]);
}

export async function listConversations(
  scope: OrgScope,
  projectId: string,
  limit = 25,
): Promise<ConversationRow[]> {
  return scopedQuery<ConversationRow>(
    scope,
    "select * from conversations where project_id = $1 order by last_activity_at desc limit $2",
    [projectId, limit],
  );
}

export async function closeConversation(
  scope: OrgScope,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  return scopedQueryOne<ConversationRow>(
    scope,
    "update conversations set status = 'closed' where id = $1 returning *",
    [conversationId],
  );
}

export async function deleteConversation(
  scope: OrgScope,
  conversationId: string,
): Promise<boolean> {
  const rows = await scopedQuery(scope, "delete from conversations where id = $1 returning id", [
    conversationId,
  ]);
  return rows.length === 1;
}

/** Appending a message also advances the conversation's activity clock. */
export async function appendMessage(
  scope: OrgScope,
  input: { conversationId: string; role: string; content: string; runId?: string },
): Promise<MessageRow> {
  const row = await scopedQueryOne<MessageRow>(
    scope,
    `insert into messages (org_id, conversation_id, role, content, run_id)
     values ($1, $2, $3, $4, $5) returning *`,
    [scope.orgId, input.conversationId, input.role, input.content, input.runId ?? null],
  );
  if (row === undefined) throw new Error("appendMessage returned no row");

  await scopedQuery(scope, "update conversations set last_activity_at = now() where id = $1", [
    input.conversationId,
  ]);

  return row;
}

export async function listMessages(scope: OrgScope, conversationId: string): Promise<MessageRow[]> {
  return scopedQuery<MessageRow>(
    scope,
    "select * from messages where conversation_id = $1 order by created_at, id",
    [conversationId],
  );
}
