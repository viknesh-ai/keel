import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../src/features/runs/redact.ts";
import type { RunDetail, RunStep } from "../src/features/runs/types.ts";
import { filterSteps, policyDecisionOf } from "../src/features/runs/types.ts";
import { RunDetailView } from "../src/routes/RunDetail.tsx";

const step = (over: Partial<RunStep> = {}): RunStep => ({
  id: "step_1",
  seq: 1,
  type: "context",
  status: "ok",
  integrity: "system",
  payload: {},
  error_class: null,
  tool_version_id: null,
  model: null,
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: 0,
  latency_ms: 5,
  started_at: "2026-08-14T10:00:00Z",
  ...over,
});

const run = (steps: RunStep[]): RunDetail => ({
  id: "run_01JX",
  state: "Completed",
  agent_version_id: "av_01JX",
  environment: "production",
  model: "claude-sonnet-4-5",
  tool_versions: ["tv_01"],
  knowledge_snapshot_id: null,
  started_at: "2026-08-14T10:00:00Z",
  ended_at: "2026-08-14T10:00:02Z",
  total_latency_ms: 2000,
  total_cost_usd: 0.0123,
  tokens_in: 150,
  tokens_out: 25,
  steps,
});

const view = (detail: RunDetail) =>
  render(
    <MemoryRouter>
      <RunDetailView run={detail} />
    </MemoryRouter>,
  );

describe("redaction", () => {
  it.each([
    "authorization",
    "cookie",
    "x-api-key",
    "api_key",
    "secret",
    "password",
    "token",
    "access_token",
    "client_secret",
    "private_key",
  ])("redacts a %s field by key", (key) => {
    const { value, redactions } = redact({ [key]: "whatever" });

    expect((value as Record<string, unknown>)[key]).toBe(REDACTED);
    expect(redactions).toHaveLength(1);
  });

  it.each([
    ["bearer token", "Bearer abcdef123456"],
    ["openai key", "sk-abcdefghijklmnopqrstuvwx"],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz12"],
    ["a jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("redacts %s wherever it appears", (_label, credential) => {
    const { value, redactions } = redact({ nested: { harmless_name: credential } });

    expect(JSON.stringify(value)).not.toContain(credential);
    expect(redactions[0]?.reason).toBe("value");
  });

  it("marks what it redacted rather than silently dropping it", () => {
    // Deleting the key would make the trace lie by omission: an operator needs
    // to know an authorization header was present.
    const { value, redactions } = redact({ headers: { authorization: "Bearer x" } });

    expect(redactions.map((r) => r.path)).toEqual(["headers.authorization"]);
    expect((value as { headers: Record<string, unknown> }).headers).toHaveProperty("authorization");
  });

  it("leaves ordinary values alone", () => {
    const { value, redactions } = redact({ customer_id: "cus_1", count: 43, ok: true });

    expect(value).toEqual({ customer_id: "cus_1", count: 43, ok: true });
    expect(redactions).toEqual([]);
  });

  it("survives a deeply nested payload without blowing the stack", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i += 1) deep = { next: deep };

    expect(() => redact(deep)).not.toThrow();
  });
});

describe("policy decisions", () => {
  it("extracts the rule id from a policy step", () => {
    const decision = policyDecisionOf(
      step({
        type: "policy",
        payload: { rule_id: "reads-for-authenticated", event: { type: "authorized" } },
      }),
    );

    expect(decision).toEqual({ effect: "allow", rule_id: "reads-for-authenticated" });
  });

  it("reports a denial with its reason", () => {
    const decision = policyDecisionOf(
      step({
        type: "policy",
        payload: { rule_id: "no-mutations", reason: "read-only", event: { type: "denied" } },
      }),
    );

    expect(decision?.effect).toBe("deny");
    expect(decision?.reason).toBe("read-only");
  });

  it("returns null for a non-policy step", () => {
    expect(policyDecisionOf(step({ type: "tool" }))).toBeNull();
  });
});

describe("step filtering", () => {
  const steps = [
    step({ seq: 1, type: "context", status: "ok" }),
    step({ id: "s2", seq: 2, type: "tool", status: "error" }),
    step({ id: "s3", seq: 3, type: "tool", status: "ok" }),
  ];

  it("returns everything when no filter is set", () => {
    expect(filterSteps(steps, {})).toHaveLength(3);
  });

  it("filters by type", () => {
    expect(filterSteps(steps, { type: "tool" }).map((s) => s.seq)).toEqual([2, 3]);
  });

  it("filters by status", () => {
    expect(filterSteps(steps, { status: "error" }).map((s) => s.seq)).toEqual([2]);
  });

  it("combines both filters", () => {
    expect(filterSteps(steps, { type: "tool", status: "ok" }).map((s) => s.seq)).toEqual([3]);
  });

  it("returns nothing when the combination matches nothing", () => {
    expect(filterSteps(steps, { type: "context", status: "error" })).toEqual([]);
  });
});

describe("the trace screen", () => {
  it("shows the header a reviewer needs to reproduce the run", () => {
    view(run([step()]));

    expect(screen.getByText("av_01JX")).toBeDefined();
    expect(screen.getByText("claude-sonnet-4-5")).toBeDefined();
    expect(screen.getByText("production")).toBeDefined();
    expect(screen.getByText("$0.0123")).toBeDefined();
  });

  it("lists every step with its duration and cost", () => {
    view(
      run([
        step({ seq: 1, type: "context" }),
        step({ id: "s2", seq: 2, type: "model", latency_ms: 420, cost_usd: 0.002 }),
      ]),
    );

    const timeline = screen.getByRole("list", { name: "Step timeline" });
    expect(within(timeline).getByText("model")).toBeDefined();
    expect(within(timeline).getByText(/420ms/)).toBeDefined();
  });

  it("shows the policy decision with the rule that produced it", () => {
    // The exit criterion for 1.11: the rule id must be visible, so "why was this
    // denied?" is a lookup rather than an investigation.
    view(
      run([
        step({
          seq: 1,
          type: "policy",
          payload: {
            rule_id: "never-delete-customers",
            reason: "not available",
            event: { type: "denied" },
          },
        }),
      ]),
    );

    expect(screen.getByText("Policy decision")).toBeDefined();
    expect(screen.getByText("never-delete-customers")).toBeDefined();
    expect(screen.getByText("deny")).toBeDefined();
  });

  it("redacts a credential in a rendered payload and says how many", () => {
    view(run([step({ payload: { headers: { authorization: "Bearer secret-value" } } })]));

    expect(screen.getByText(/1 field redacted/)).toBeDefined();
    expect(screen.queryByText(/secret-value/)).toBeNull();
  });

  it("renders every step when nothing is filtered", () => {
    view(run([step({ seq: 1, type: "context" }), step({ id: "s2", seq: 2, type: "tool" })]));

    const timeline = screen.getByRole("list", { name: "Step timeline" });
    expect(within(timeline).getAllByRole("button")).toHaveLength(2);
  });

  it("selects a step from the keyboard", async () => {
    view(run([step({ seq: 1 }), step({ id: "s2", seq: 2, type: "tool" })]));

    const timeline = screen.getByRole("list", { name: "Step timeline" });
    const second = within(timeline).getAllByRole("button")[1];
    second?.focus();
    await userEvent.keyboard("{Enter}");

    expect(second).toHaveAttribute("aria-current", "true");
  });

  it("shows an error class when a step failed", () => {
    view(run([step({ status: "error", error_class: "ToolExecutionError" })]));

    expect(screen.getByText("ToolExecutionError")).toBeDefined();
  });

  it("renders no reasoning field, because none is ever recorded", () => {
    // ADR-018. There is no code path that could surface chain-of-thought: the
    // screen reads run_steps and the runtime never writes reasoning into them.
    const { container } = view(run([step({ payload: { event: { type: "planned" } } })]));

    expect(container.textContent?.toLowerCase()).not.toContain("thinking");
    expect(container.textContent?.toLowerCase()).not.toContain("reasoning");
  });
});
