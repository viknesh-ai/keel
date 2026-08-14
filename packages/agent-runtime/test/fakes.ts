import type { KeelError } from "@keel/contracts";
import type {
  BudgetPort,
  ClockPort,
  ContextBlock,
  IdPort,
  KnowledgePort,
  ModelPort,
  ModelUsage,
  NewStep,
  PersistedStep,
  PlannedAction,
  PolicyDecision,
  PolicyPort,
  Ports,
  ResolvedTool,
  StepLogPort,
  ToolPort,
  ToolResult,
} from "../src/ports.js";

/**
 * In-memory port fakes. The whole lifecycle is exercised with these and no
 * network, which is the point of the port design — and the reason a replay test
 * can be deterministic at all.
 *
 * These are test doubles in a test directory, which is where CLAUDE.md permits
 * fabricated data. Nothing here ships.
 */

export class FakeClock implements ClockPort {
  #now: number;
  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

export class FakeIds implements IdPort {
  #n = 0;
  newId(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${String(this.#n).padStart(26, "0")}`;
  }
}

export class InMemoryStepLog implements StepLogPort {
  readonly steps: PersistedStep[] = [];
  #seq = 0;

  constructor(private readonly clock: ClockPort = new FakeClock()) {}

  async append(step: NewStep): Promise<PersistedStep> {
    this.#seq += 1;
    const persisted: PersistedStep = {
      ...step,
      id: `step_${String(this.#seq).padStart(26, "0")}`,
      seq: this.#seq,
      started_at: this.clock.now(),
    };
    this.steps.push(persisted);
    return persisted;
  }

  async list(runId: string): Promise<readonly PersistedStep[]> {
    return this.steps.filter((s) => s.run_id === runId);
  }
}

const usage = (model = "fake-model"): ModelUsage => ({
  tokens_in: 10,
  tokens_out: 5,
  cost_usd: 0.0001,
  model,
  latency_ms: 3,
});

export class FakeModel implements ModelPort {
  calls: string[] = [];

  constructor(
    private readonly script: {
      intent?: "knowledge" | "open";
      plan?: PlannedAction | PlannedAction[];
      answer?: string;
    } = {},
  ) {}

  async classifyIntent(): Promise<{
    intent: { kind: "knowledge" | "open"; confidence: number };
    usage: ModelUsage;
  }> {
    this.calls.push("classifyIntent");
    return { intent: { kind: this.script.intent ?? "open", confidence: 0.9 }, usage: usage() };
  }

  async plan(): Promise<{ action: PlannedAction; usage: ModelUsage }> {
    this.calls.push("plan");
    const planned = this.script.plan ?? { kind: "respond", reason: "nothing to do" };
    const action = Array.isArray(planned)
      ? (planned[Math.min(this.calls.filter((c) => c === "plan").length - 1, planned.length - 1)] ??
        planned[planned.length - 1])
      : planned;
    if (action === undefined) throw new Error("no planned action");
    return { action, usage: usage() };
  }

  async compose(): Promise<{ text: string; usage: ModelUsage }> {
    this.calls.push("compose");
    return { text: this.script.answer ?? "Here is the answer.", usage: usage() };
  }
}

export class FakePolicy implements PolicyPort {
  constructor(
    private readonly decision: PolicyDecision = { effect: "allow", rule_id: "allow-read" },
  ) {}
  async decide(): Promise<PolicyDecision> {
    return this.decision;
  }
}

export class FakeTools implements ToolPort {
  executed: string[] = [];

  constructor(
    private readonly options: {
      resolve?: ResolvedTool | undefined;
      result?: ToolResult;
    } = {},
  ) {}

  async resolve(name: string): Promise<ResolvedTool | undefined> {
    if ("resolve" in this.options) return this.options.resolve;
    return { name, tool_version_id: "tv_1", side_effect: "read", risk: "read" };
  }

  async execute(call: { tool: ResolvedTool }): Promise<ToolResult> {
    this.executed.push(call.tool.name);
    return (
      this.options.result ?? {
        ok: true,
        output: { customers: 3 },
        integrity: "tool",
        latency_ms: 7,
      }
    );
  }
}

export class FakeKnowledge implements KnowledgePort {
  constructor(private readonly blocks: readonly ContextBlock[] = []) {}
  async retrieve(): Promise<readonly ContextBlock[]> {
    return this.blocks;
  }
}

export class FakeBudget implements BudgetPort {
  modelCalls = 0;
  toolCalls = 0;
  constructor(private readonly error?: KeelError) {}
  check(): KeelError | undefined {
    return this.error;
  }
  recordModelCall(): void {
    this.modelCalls += 1;
  }
  recordToolCall(): void {
    this.toolCalls += 1;
  }
}

export function makePorts(over: Partial<Ports> = {}): Ports {
  const clock = over.clock ?? new FakeClock();
  return {
    clock,
    id: over.id ?? new FakeIds(),
    stepLog: over.stepLog ?? new InMemoryStepLog(clock),
    model: over.model ?? new FakeModel(),
    policy: over.policy ?? new FakePolicy(),
    tool: over.tool ?? new FakeTools(),
    knowledge: over.knowledge ?? new FakeKnowledge(),
    budget: over.budget ?? new FakeBudget(),
  };
}
