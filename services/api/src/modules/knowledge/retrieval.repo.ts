import { type OrgScope, scopedQuery } from "../../db/scope.js";

/**
 * Hybrid retrieval with the ACL predicate inside the query (doc 03 §A2).
 *
 * This is the single most important correctness property in the knowledge
 * system, and the reason is worth stating precisely rather than assumed.
 *
 * Post-filtering leaks even when it is bug-free. If unauthorized rows are read
 * and then dropped, their existence is still observable: result counts change,
 * score distributions shift, pagination skips, and latency varies with how much
 * was thrown away. An attacker who can ask questions and count answers can map
 * a document set they were never allowed to read. And that is the *working*
 * case — one mistake in the filter step returns the content itself.
 *
 * Putting the predicate in the scan means the rows are never materialised.
 * There is nothing to leak because nothing was read.
 *
 * The principal's tags come from verified identity claims only. Nothing here
 * accepts a tag the client asserted, which is why `acl_tags` is passed as a
 * parameter derived server-side rather than assembled from a request body.
 */

export type Principal = {
  readonly authenticated: boolean;
  readonly orgId: string;
  /** Group and role claims from the verified token. Never client-supplied. */
  readonly aclTags: readonly string[];
};

export type RetrievedChunk = {
  id: string;
  document_id: string;
  document_version_id: string;
  content: string;
  heading_path: string[];
  title: string | null;
  uri: string;
  keyword_rank: number;
  vector_score: number;
  fused_score: number;
};

export type RetrieveInput = {
  readonly projectId: string;
  readonly query: string;
  readonly embedding: readonly number[] | null;
  readonly principal: Principal;
  readonly limit?: number;
};

/**
 * The ACL clause, as SQL text.
 *
 * Extracted so it can be asserted on directly: a test that greps the query for
 * this clause fails the moment someone "simplifies" retrieval by moving the
 * check into TypeScript. That is a weaker test than the behavioural ones below
 * it, and it is here because this specific regression would otherwise pass
 * every behavioural test written against a correct filter.
 */
export function aclPredicate(orgParam: number, tagsParam: number): string {
  return `(
        d.visibility = 'public'
     or (d.visibility = 'org' and d.org_id = $${orgParam})
     or (d.visibility = 'acl' and d.acl_tags && $${tagsParam}::text[])
      )`;
}

/** The predicate as retrieval uses it. Parameter positions 4 and 5. */
export const ACL_PREDICATE = aclPredicate(4, 5);

/**
 * Reciprocal Rank Fusion of keyword and vector retrieval.
 *
 * Both, not either. Product knowledge is full of identifiers — plan names,
 * SKUs, error codes, endpoint names — that embeddings routinely miss and BM25
 * nails, and RRF avoids having to calibrate two incomparable score scales.
 */
export async function retrieve(
  scope: OrgScope,
  input: RetrieveInput,
): Promise<readonly RetrievedChunk[]> {
  const limit = input.limit ?? 10;
  // An anonymous principal gets public documents and nothing else. Passing its
  // org id would let `visibility = 'org'` match, which is the whole difference
  // between "logged out" and "logged in".
  const orgId = input.principal.authenticated ? input.principal.orgId : "";
  const tags = input.principal.authenticated ? [...input.principal.aclTags] : [];
  const embedding = input.embedding === null ? null : `[${input.embedding.join(",")}]`;

  return scopedQuery<RetrievedChunk>(
    scope,
    `with scored as (
       select c.id,
              c.document_id,
              c.document_version_id,
              c.content,
              c.heading_path,
              d.title,
              d.uri,
              ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) as keyword_rank,
              case when $2::vector is null then 0
                   else 1 - (c.embedding <=> $2::vector) end as vector_score
         from knowledge_chunks c
         join knowledge_documents d
           on d.id = c.document_id and d.org_id = c.org_id
        where d.project_id = $3
          and d.deleted_at is null
          -- Current version only. Without this a superseded version's chunks
          -- stay retrievable and the agent answers from text the customer
          -- believes they replaced.
          and d.current_version_id = c.document_version_id
          and ${ACL_PREDICATE}
     )
     select *,
            (coalesce(keyword_rank, 0) + coalesce(vector_score, 0)) as fused_score
       from scored
      where keyword_rank > 0 or vector_score > 0
      order by fused_score desc, id
      limit $6`,
    [input.query, embedding, input.projectId, orgId, tags, limit],
  );
}

/**
 * How many chunks the ACL excluded, for the retrieval playground (doc 03 §A4).
 *
 * A count, never content. A developer debugging retrieval needs to know that
 * eleven candidates were withheld; showing them *which* would turn the
 * debugging tool into the leak the predicate exists to prevent.
 */
export async function countExcludedByAcl(scope: OrgScope, input: RetrieveInput): Promise<number> {
  const orgId = input.principal.authenticated ? input.principal.orgId : "";
  const tags = input.principal.authenticated ? [...input.principal.aclTags] : [];

  // Built from the same generator as retrieval's, at its own parameter
  // positions. Two hand-written copies of this clause would drift, and the copy
  // that drifted would be the one nobody was testing.
  const rows = await scopedQuery<{ excluded: string }>(
    scope,
    `select count(*)::text as excluded
       from knowledge_chunks c
       join knowledge_documents d
         on d.id = c.document_id and d.org_id = c.org_id
      where d.project_id = $1
        and d.deleted_at is null
        and d.current_version_id = c.document_version_id
        and not ${aclPredicate(2, 3)}`,
    [input.projectId, orgId, tags],
  );

  return Number(rows[0]?.excluded ?? 0);
}
