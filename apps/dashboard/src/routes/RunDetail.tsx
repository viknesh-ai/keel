import {
  Badge,
  Button,
  CodeBlock,
  Duration,
  EmptyState,
  KeyValue,
  Select,
  StatusDot,
} from "@keel/ui";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { redact } from "../features/runs/redact.ts";
import {
  filterSteps,
  policyDecisionOf,
  type RunDetail,
  type RunStep,
  type StepStatus,
  type StepType,
} from "../features/runs/types.ts";

/**
 * The run-detail trace screen (doc 05 §E5).
 *
 * "This is the screen that convinces an engineer we are serious", which means
 * it answers one question: *why did it do that?* Every step shows what it cost
 * and how long it took, and every policy step shows the rule id that produced
 * the decision — so "why was this denied?" is a lookup rather than an
 * investigation.
 *
 * Typed execution events only. There is no chain-of-thought here and there is
 * no code path that could render one: the screen reads `run_steps`, and the
 * runtime never writes reasoning into them (ADR-018).
 */

const STATUS_TONE: Record<StepStatus, "success" | "danger" | "neutral" | "warning"> = {
  ok: "success",
  error: "danger",
  skipped: "neutral",
  pending: "warning",
};

const STATUS_DOT: Record<StepStatus, "success" | "failed" | "idle" | "running"> = {
  ok: "success",
  error: "failed",
  skipped: "idle",
  pending: "running",
};

const STEP_TYPES: readonly StepType[] = [
  "context",
  "retrieval",
  "model",
  "tool",
  "policy",
  "approval",
  "verify",
  "recover",
  "route",
  "response",
];

export function RunDetailView({ run }: { readonly run: RunDetail }) {
  const [params, setParams] = useSearchParams();
  const [typeFilter, setTypeFilter] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<string>();

  // Deep-linkable: ?step=3 selects a step, so a trace can be shared in a ticket
  // and land on the exact step being discussed.
  const selectedSeq = Number(params.get("step") ?? "");

  const visible = useMemo(
    () =>
      filterSteps(run.steps, {
        ...(typeFilter === undefined ? {} : { type: typeFilter }),
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
      }),
    [run.steps, typeFilter, statusFilter],
  );

  const selected = run.steps.find((step) => step.seq === selectedSeq) ?? visible[0] ?? run.steps[0];

  const select = (seq: number) => {
    const next = new URLSearchParams(params);
    next.set("step", String(seq));
    setParams(next, { replace: true });
  };

  return (
    <>
      <h1 className="d-title">Run {run.id}</h1>

      <section className="d-run__header">
        <KeyValue
          items={[
            {
              key: "State",
              value: (
                <Badge tone={run.state === "Completed" ? "success" : "danger"}>{run.state}</Badge>
              ),
              mono: false,
            },
            { key: "Agent version", value: run.agent_version_id },
            { key: "Environment", value: run.environment },
            { key: "Model", value: run.model ?? "—" },
            { key: "Tool versions", value: run.tool_versions.join(", ") || "—" },
            { key: "Knowledge snapshot", value: run.knowledge_snapshot_id ?? "—" },
            { key: "Total latency", value: <Duration ms={run.total_latency_ms} />, mono: false },
            { key: "Total cost", value: `$${run.total_cost_usd.toFixed(4)}` },
            { key: "Tokens", value: `${run.tokens_in} in / ${run.tokens_out} out` },
          ]}
        />
      </section>

      <div className="d-run__filters">
        <Select
          label="Step type"
          placeholder="All types"
          value={typeFilter}
          onValueChange={setTypeFilter}
          options={STEP_TYPES.map((t) => ({ value: t, label: t }))}
        />
        <Select
          label="Status"
          placeholder="All statuses"
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={(["ok", "error", "skipped", "pending"] as const).map((s) => ({
            value: s,
            label: s,
          }))}
        />
        {typeFilter !== undefined || statusFilter !== undefined ? (
          <Button
            size="sm"
            onClick={() => {
              setTypeFilter(undefined);
              setStatusFilter(undefined);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="d-run__body">
        <ol className="d-run__timeline" aria-label="Step timeline">
          {visible.length === 0 ? (
            <li>
              <EmptyState title="No steps match" description="Try clearing a filter." />
            </li>
          ) : null}

          {visible.map((step) => (
            <li key={step.id}>
              <button
                type="button"
                className={
                  step.seq === selected?.seq
                    ? "d-run__step d-run__step--selected k-focus"
                    : "d-run__step k-focus"
                }
                aria-current={step.seq === selected?.seq ? "true" : undefined}
                onClick={() => select(step.seq)}
              >
                <span className="d-run__step-seq k-mono">{step.seq}</span>
                <StatusDot status={STATUS_DOT[step.status]} />
                <span className="d-run__step-type">{step.type}</span>
                <span className="d-run__step-meta k-mono">
                  {step.latency_ms === null ? "—" : `${step.latency_ms}ms`}
                  {step.cost_usd > 0 ? ` · $${step.cost_usd.toFixed(4)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <section className="d-run__detail" aria-label="Step detail">
          {selected === undefined ? (
            <EmptyState title="No step selected" description="Choose a step from the timeline." />
          ) : (
            <StepDetail step={selected} />
          )}
        </section>
      </div>
    </>
  );
}

function StepDetail({ step }: { readonly step: RunStep }) {
  const { value, redactions } = useMemo(() => redact(step.payload), [step.payload]);
  const decision = policyDecisionOf(step);

  return (
    <>
      <h2 className="d-run__detail-title">
        Step {step.seq} · {step.type} <Badge tone={STATUS_TONE[step.status]}>{step.status}</Badge>
      </h2>

      <KeyValue
        items={[
          { key: "Integrity", value: step.integrity },
          { key: "Latency", value: step.latency_ms === null ? "—" : `${step.latency_ms}ms` },
          { key: "Cost", value: `$${step.cost_usd.toFixed(4)}` },
          { key: "Tokens", value: `${step.tokens_in} / ${step.tokens_out}` },
          ...(step.model === null ? [] : [{ key: "Model", value: step.model }]),
          ...(step.tool_version_id === null
            ? []
            : [{ key: "Tool version", value: step.tool_version_id }]),
          ...(step.error_class === null
            ? []
            : [
                {
                  key: "Error class",
                  value: <Badge tone="danger">{step.error_class}</Badge>,
                  mono: false,
                },
              ]),
        ]}
      />

      {decision === null ? null : (
        <>
          <h3 className="d-run__detail-heading">Policy decision</h3>
          <KeyValue
            items={[
              {
                key: "Effect",
                value: (
                  <Badge tone={decision.effect === "allow" ? "success" : "danger"}>
                    {decision.effect}
                  </Badge>
                ),
                mono: false,
              },
              // The rule id is the whole point: it turns "why was this denied?"
              // into a lookup rather than an investigation.
              { key: "Rule", value: decision.rule_id },
              ...(decision.reason === undefined
                ? []
                : [{ key: "Reason", value: decision.reason, mono: false }]),
            ]}
          />
        </>
      )}

      <h3 className="d-run__detail-heading">Payload</h3>
      {redactions.length > 0 ? (
        <p className="d-run__redacted">
          {redactions.length} field{redactions.length === 1 ? "" : "s"} redacted:{" "}
          <span className="k-mono">{redactions.map((r) => r.path).join(", ")}</span>
        </p>
      ) : null}
      <CodeBlock language="json" code={JSON.stringify(value, null, 2)} />
    </>
  );
}

export default function RunDetailRoute() {
  return (
    <EmptyState
      title="Open a run from Activity"
      description="The run-detail trace screen renders a run's full step timeline, its policy decisions and its cost."
    />
  );
}
