import { agentsRepo, type OrgScope, runsRepo, toolsRepo } from "@keel/api";
import { describe, expect, it } from "vitest";

/**
 * The compile-time half of "no repository method can be called without an org
 * scope". The runtime half is in repositories.test.ts.
 *
 * These assertions are the `@ts-expect-error` comments, not the `expect` calls.
 * If any of the calls below ever *did* type-check, the `@ts-expect-error` would
 * itself become an error ("unused '@ts-expect-error' directive") and
 * `pnpm typecheck` would fail. So this file is a real assertion about the API's
 * shape, enforced by tsc rather than by review — which is the only way a
 * type-level guarantee can be tested at all.
 */

describe("an org scope cannot be bypassed", () => {
  it("rejects calling a repository with no scope at all", () => {
    // @ts-expect-error — listAgents requires an OrgScope as its first argument
    const _a = () => agentsRepo.listAgents("proj_1");
    // @ts-expect-error — getRun requires an OrgScope as its first argument
    const _b = () => runsRepo.getRun("run_1");
    // @ts-expect-error — listTools requires an OrgScope as its first argument
    const _c = () => toolsRepo.listTools("proj_1");

    expect([_a, _b, _c]).toHaveLength(3);
  });

  it("rejects a bare org id where a scope is required", () => {
    // @ts-expect-error — a string is not an OrgScope, however plausible it looks
    const _a = () => agentsRepo.listAgents("org_01JXQ4Z8K3M2P9ABCDEFGHJKMN", "proj_1");

    expect(_a).toBeTypeOf("function");
  });

  it("rejects a hand-rolled object shaped like a scope", () => {
    // The brand is a unique symbol that is not exported, so this object cannot
    // satisfy OrgScope no matter what a caller writes. That is what stops
    // someone from reaching the queries with a connection that never had
    // keel.org_id set on it.
    const impostor = { orgId: "org_1", client: {} };

    // @ts-expect-error — missing the unique brand, so it is not an OrgScope
    const _a = () => agentsRepo.listAgents(impostor, "proj_1");

    expect(_a).toBeTypeOf("function");
  });

  it("accepts a genuine scope", () => {
    // Compiles: this is the control for the three failures above. Without it,
    // the tests would pass even if every call were rejected for the wrong
    // reason — a typo in the function name, say.
    const use = (scope: OrgScope) => agentsRepo.listAgents(scope, "proj_1");

    expect(use).toBeTypeOf("function");
  });
});
