import { type OrgScope, scopedQuery, scopedQueryOne } from "../../db/scope.js";

/**
 * Knowledge documents, versions and chunks (doc 03 §A1, §A3).
 *
 * The write path exists to serve one invariant: a half-indexed version is never
 * live. A version's chunks are written first and `current_version_id` is moved
 * last, so retrieval either sees the old version complete or the new version
 * complete, and never a partial one.
 */

export type DocumentRow = {
  id: string;
  org_id: string;
  project_id: string;
  source_id: string;
  uri: string;
  title: string | null;
  content_sha256: string;
  visibility: "public" | "org" | "acl";
  acl_tags: string[];
  current_version_id: string | null;
  fetched_at: Date;
  last_seen_at: Date;
  deleted_at: Date | null;
};

export type VersionRow = {
  id: string;
  org_id: string;
  document_id: string;
  content_sha256: string;
  text: string;
  created_at: Date;
};

export async function createSource(
  scope: OrgScope,
  input: { projectId: string; kind: string; name: string; config?: Record<string, unknown> },
): Promise<{ id: string; state: string }> {
  const row = await scopedQueryOne<{ id: string; state: string }>(
    scope,
    `insert into knowledge_sources (org_id, project_id, kind, name, config)
     values ($1, $2, $3, $4, $5) returning id, state`,
    [scope.orgId, input.projectId, input.kind, input.name, JSON.stringify(input.config ?? {})],
  );
  if (row === undefined) throw new Error("createSource returned no row");
  return row;
}

/**
 * Records a source's outcome.
 *
 * `partial` is a real state, not a rounding of `ready`. A source that indexed
 * 374 of 412 documents is partial, and reporting it as ready is exactly how a
 * customer ends up with confident answers from a third of a knowledge base.
 */
export async function setSourceState(
  scope: OrgScope,
  sourceId: string,
  state: string,
  errorCount = 0,
): Promise<void> {
  await scopedQuery(
    scope,
    `update knowledge_sources
        set state = $2, error_count = $3, last_sync_at = now()
      where id = $1`,
    [sourceId, state, errorCount],
  );
}

export type UpsertResult =
  | { readonly changed: false; readonly document: DocumentRow }
  | { readonly changed: true; readonly document: DocumentRow; readonly version: VersionRow };

/**
 * Upserts a document, creating a version only when the content actually moved.
 *
 * The unchanged path bumps `last_seen_at` and stops. That is the whole point of
 * `content_sha256`: on a typical docs-site re-crawl this is the difference
 * between re-embedding four thousand chunks and re-embedding forty.
 */
export async function upsertDocument(
  scope: OrgScope,
  input: {
    projectId: string;
    sourceId: string;
    uri: string;
    title?: string;
    text: string;
    contentSha256: string;
    visibility?: "public" | "org" | "acl";
    aclTags?: readonly string[];
  },
): Promise<UpsertResult> {
  const existing = await scopedQueryOne<DocumentRow>(
    scope,
    "select * from knowledge_documents where source_id = $1 and uri = $2",
    [input.sourceId, input.uri],
  );

  if (existing !== undefined && existing.content_sha256 === input.contentSha256) {
    const touched = await scopedQueryOne<DocumentRow>(
      scope,
      "update knowledge_documents set last_seen_at = now() where id = $1 returning *",
      [existing.id],
    );
    return { changed: false, document: touched ?? existing };
  }

  const document =
    existing === undefined
      ? await scopedQueryOne<DocumentRow>(
          scope,
          `insert into knowledge_documents
             (org_id, project_id, source_id, uri, title, content_sha256, visibility, acl_tags)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
          [
            scope.orgId,
            input.projectId,
            input.sourceId,
            input.uri,
            input.title ?? null,
            input.contentSha256,
            input.visibility ?? "org",
            [...(input.aclTags ?? [])],
          ],
        )
      : await scopedQueryOne<DocumentRow>(
          scope,
          `update knowledge_documents
              set content_sha256 = $2, title = $3, fetched_at = now(), last_seen_at = now()
            where id = $1 returning *`,
          [existing.id, input.contentSha256, input.title ?? null],
        );

  if (document === undefined) throw new Error("upsertDocument returned no document");

  const version = await scopedQueryOne<VersionRow>(
    scope,
    `insert into document_versions (org_id, document_id, content_sha256, text)
     values ($1, $2, $3, $4) returning *`,
    [scope.orgId, document.id, input.contentSha256, input.text],
  );
  if (version === undefined) throw new Error("upsertDocument returned no version");

  return { changed: true, document, version };
}

/**
 * Publishes a version by pointing the document at it.
 *
 * Called *after* the chunks are written, never before. Retrieval filters on
 * `current_version_id = document_version_id`, so until this runs the new
 * chunks are invisible and the old version keeps answering — which is the
 * behaviour you want during an index, rather than a window where half a
 * document is retrievable.
 */
export async function publishVersion(
  scope: OrgScope,
  documentId: string,
  versionId: string,
): Promise<void> {
  await scopedQuery(scope, "update knowledge_documents set current_version_id = $2 where id = $1", [
    documentId,
    versionId,
  ]);
}

export async function insertChunks(
  scope: OrgScope,
  input: {
    documentId: string;
    versionId: string;
    chunks: readonly {
      seq: number;
      content: string;
      contentSha256: string;
      headingPath: readonly string[];
      tokenCount: number;
      embedding: readonly number[] | null;
    }[];
  },
): Promise<number> {
  let written = 0;
  for (const chunk of input.chunks) {
    await scopedQuery(
      scope,
      `insert into knowledge_chunks
         (org_id, document_id, document_version_id, seq, content_sha256, content,
          heading_path, token_count, embedding)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        scope.orgId,
        input.documentId,
        input.versionId,
        chunk.seq,
        chunk.contentSha256,
        chunk.content,
        [...chunk.headingPath],
        chunk.tokenCount,
        chunk.embedding === null ? null : `[${chunk.embedding.join(",")}]`,
      ],
    );
    written += 1;
  }
  return written;
}

export async function setVisibility(
  scope: OrgScope,
  documentId: string,
  visibility: "public" | "org" | "acl",
  aclTags: readonly string[] = [],
): Promise<void> {
  await scopedQuery(
    scope,
    "update knowledge_documents set visibility = $2, acl_tags = $3 where id = $1",
    [documentId, visibility, [...aclTags]],
  );
}

export async function listDocuments(
  scope: OrgScope,
  projectId: string,
): Promise<readonly DocumentRow[]> {
  return scopedQuery<DocumentRow>(
    scope,
    "select * from knowledge_documents where project_id = $1 and deleted_at is null order by uri",
    [projectId],
  );
}
