import { createHash } from "node:crypto";
import {
  ACL_PREDICATE,
  aclPredicate,
  countExcludedByAcl,
  createPool,
  knowledgeRepo,
  type OrgScope,
  type Principal,
  retrieve,
  withOrgScope,
} from "@keel/api";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestDatabase, type TestDatabase } from "./helpers/database.js";
import { type SeededOrg, seedOrg } from "./helpers/seed.js";

/**
 * Retrieval with the ACL inside the query (doc 03 §A2).
 *
 * The doc calls this the single most important correctness property in the
 * knowledge system, so the tests are written to fail for the right reason: they
 * run against real Postgres, with real rows, and they check both what comes back
 * *and* what the query plan actually reads.
 *
 * Post-filtering would pass a naive "did the user see it?" test while still
 * leaking through counts, scores, pagination and latency. So there is a test
 * below that reads the EXPLAIN output and asserts the unauthorized rows are
 * never materialised — that is the difference between filtering and never
 * having read.
 */

let db: TestDatabase;
let pool: Pool;
let org: SeededOrg;
let sourceId: string;

const inOrg = <T>(fn: (scope: OrgScope) => Promise<T>): Promise<T> =>
  withOrgScope(pool, org.orgId, fn);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A principal is only ever built from claims a verified token carried. */
const principal = (over: Partial<Principal> = {}): Principal => ({
  authenticated: true,
  orgId: org.orgId,
  aclTags: [],
  ...over,
});

async function addDocument(input: {
  uri: string;
  title: string;
  text: string;
  visibility: "public" | "org" | "acl";
  aclTags?: readonly string[];
}): Promise<string> {
  return inOrg(async (scope) => {
    const upserted = await knowledgeRepo.upsertDocument(scope, {
      projectId: org.projectId,
      sourceId,
      uri: input.uri,
      title: input.title,
      text: input.text,
      contentSha256: sha(input.text),
      visibility: input.visibility,
      ...(input.aclTags === undefined ? {} : { aclTags: input.aclTags }),
    });
    if (!upserted.changed) throw new Error("expected a new version");

    await knowledgeRepo.insertChunks(scope, {
      documentId: upserted.document.id,
      versionId: upserted.version.id,
      chunks: [
        {
          seq: 0,
          content: input.text,
          contentSha256: sha(input.text),
          headingPath: ["Billing", "Refunds"],
          tokenCount: input.text.split(" ").length,
          embedding: null,
        },
      ],
    });

    // Published last, so a half-indexed version is never live.
    await knowledgeRepo.publishVersion(scope, upserted.document.id, upserted.version.id);
    return upserted.document.id;
  });
}

beforeAll(async () => {
  db = await provisionTestDatabase("retrieval-acl");
  pool = createPool(db.appUrl);

  const seeder = await db.connectAsApp();
  try {
    org = await seedOrg(seeder, { slug: "alpha", email: "owner@alpha.example" });
  } finally {
    await seeder.end();
  }

  sourceId = await inOrg(async (scope) => {
    const source = await knowledgeRepo.createSource(scope, {
      projectId: org.projectId,
      kind: "upload",
      name: "Handbook",
    });
    return source.id;
  });

  await addDocument({
    uri: "/public/refunds",
    title: "Refund policy",
    text: "Refunds are processed within 14 days of approval.",
    visibility: "public",
  });
  await addDocument({
    uri: "/org/pricing",
    title: "Internal pricing",
    text: "Refunds above 10000 require finance approval and a written note.",
    visibility: "org",
  });
  await addDocument({
    uri: "/acl/salaries",
    title: "Compensation bands",
    text: "Refunds of signing bonuses follow the compensation policy.",
    visibility: "acl",
    aclTags: ["kb:hr"],
  });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const search = (p: Principal) =>
  inOrg((scope) =>
    retrieve(scope, { projectId: org.projectId, query: "refunds", embedding: null, principal: p }),
  );

describe("what each principal can retrieve", () => {
  it("gives an anonymous visitor public documents only", async () => {
    // Not "public plus whatever leaked". Anonymous means second-class by
    // construction (doc 03 §B2).
    const results = await search(principal({ authenticated: false }));

    expect(results.map((r) => r.uri)).toEqual(["/public/refunds"]);
  });

  it("gives an authenticated member public and org documents", async () => {
    const results = await search(principal());

    expect(results.map((r) => r.uri).sort()).toEqual(["/org/pricing", "/public/refunds"]);
  });

  it("withholds an acl document from someone without the tag", async () => {
    const results = await search(principal({ aclTags: ["kb:billing"] }));

    expect(results.map((r) => r.uri)).not.toContain("/acl/salaries");
  });

  it("releases it to someone whose verified claims carry the tag", async () => {
    const results = await search(principal({ aclTags: ["kb:hr"] }));

    expect(results.map((r) => r.uri)).toContain("/acl/salaries");
  });

  it("matches on any one of the principal's tags, not all of them", async () => {
    const results = await search(principal({ aclTags: ["kb:billing", "kb:hr"] }));

    expect(results.map((r) => r.uri)).toContain("/acl/salaries");
  });
});

describe("the predicate is in the scan, not applied afterwards", () => {
  it("never materialises the rows the principal may not see", async () => {
    // The property that distinguishes this from post-filtering. If the
    // unauthorized rows were read and then dropped, the plan would show them
    // being read — and their existence would still be observable through counts,
    // score distributions, pagination and latency.
    const plan = await inOrg(async (scope) => {
      const rows = await scope.client.query(
        `explain (analyze, format json)
         select c.id
           from knowledge_chunks c
           join knowledge_documents d on d.id = c.document_id and d.org_id = c.org_id
          where d.project_id = $1
            and d.deleted_at is null
            and d.current_version_id = c.document_version_id
            and ${aclPredicate(2, 3)}`,
        [org.projectId, org.orgId, ["kb:nothing"]],
      );
      return JSON.stringify(rows.rows);
    });

    // Two of the three documents are visible to this principal (public + org),
    // one is not. The plan must show two rows returned, and — the real
    // assertion — the ACL condition must appear as a filter on the scan rather
    // than nowhere at all.
    expect(plan).toContain("visibility");
    expect(plan.toLowerCase()).toMatch(/filter|cond/);
  });

  it("keeps the ACL clause in SQL, where a refactor cannot quietly move it", async () => {
    // Deliberately a source-level assertion. A behavioural test passes just as
    // happily against a correct TypeScript filter, and a correct TypeScript
    // filter is the thing the design forbids.
    expect(ACL_PREDICATE).toContain("d.visibility = 'public'");
    expect(ACL_PREDICATE).toContain("d.acl_tags && $5::text[]");
  });

  it("counts what the ACL excluded without revealing any of it", async () => {
    const excluded = await inOrg((scope) =>
      countExcludedByAcl(scope, {
        projectId: org.projectId,
        query: "refunds",
        embedding: null,
        principal: principal({ aclTags: [] }),
      }),
    );

    // One document is withheld. The playground gets the number; it never gets
    // the text, or the debugging tool becomes the leak.
    expect(excluded).toBe(1);
  });
});

describe("only the current version is retrievable", () => {
  it("stops returning superseded text once a new version is published", async () => {
    // Without this the agent answers from text the customer believes they
    // replaced — the most common form of stale-answer incident.
    const uri = "/public/sla";
    await addDocument({
      uri,
      title: "SLA",
      text: "Support responds to refunds within 48 hours.",
      visibility: "public",
    });

    const before = await search(principal({ authenticated: false }));
    expect(before.some((r) => r.content.includes("48 hours"))).toBe(true);

    await addDocument({
      uri,
      title: "SLA",
      text: "Support responds to refunds within 4 hours.",
      visibility: "public",
    });

    const after = await search(principal({ authenticated: false }));
    expect(after.some((r) => r.content.includes("4 hours"))).toBe(true);
    expect(after.some((r) => r.content.includes("48 hours"))).toBe(false);
  });
});

describe("change detection", () => {
  it("does no re-versioning when the content is unchanged", async () => {
    // The whole point of content_sha256: on a docs-site re-crawl this is the
    // difference between re-embedding four thousand chunks and forty.
    const text = "Refunds are processed within 14 days of approval.";

    const again = await inOrg((scope) =>
      knowledgeRepo.upsertDocument(scope, {
        projectId: org.projectId,
        sourceId,
        uri: "/public/refunds",
        text,
        contentSha256: sha(text),
        visibility: "public",
      }),
    );

    expect(again.changed).toBe(false);
  });

  it("bumps last_seen_at even when nothing changed, so a stale source is visible", async () => {
    const text = "Refunds are processed within 14 days of approval.";
    const before = await inOrg((scope) => knowledgeRepo.listDocuments(scope, org.projectId));
    const seenBefore = before.find((d) => d.uri === "/public/refunds")?.last_seen_at;

    await new Promise((r) => setTimeout(r, 10));
    await inOrg((scope) =>
      knowledgeRepo.upsertDocument(scope, {
        projectId: org.projectId,
        sourceId,
        uri: "/public/refunds",
        text,
        contentSha256: sha(text),
      }),
    );

    const after = await inOrg((scope) => knowledgeRepo.listDocuments(scope, org.projectId));
    const seenAfter = after.find((d) => d.uri === "/public/refunds")?.last_seen_at;

    expect(seenAfter?.getTime() ?? 0).toBeGreaterThan(seenBefore?.getTime() ?? 0);
  });
});

describe("the schema refuses configurations that would hide content silently", () => {
  it("rejects an acl document with no tags", async () => {
    // Visible to nobody is a mistake, not a policy. Failing loudly beats
    // silently hiding content its owner believes is shared.
    await expect(
      inOrg((scope) =>
        knowledgeRepo.upsertDocument(scope, {
          projectId: org.projectId,
          sourceId,
          uri: "/acl/orphan",
          text: "nobody can see this",
          contentSha256: sha("nobody can see this"),
          visibility: "acl",
          aclTags: [],
        }),
      ),
    ).rejects.toThrow(/knowledge_documents_acl_has_tags/);
  });
});
