import { describe, expect, it } from "vitest";
import { replay, verifyAgainst } from "../src/replay.js";
import { type RunInput, run } from "../src/runtime.js";
import { InvalidTransitionError, isTerminal, transition } from "../src/state.js";
import {
  FakeBudget,
  FakeKnowledge,
  FakeModel,
  FakePolicy,
  FakeTools,
  InMemoryStepLog,
  makePorts,
} from "./fakes.js";

const input = (over: Partial<RunInput> = {}): RunInput => ({
  run_id: "run_test",
  message: "Show me customers who haven't logged in for 30 days",
  environment: "development",
  identity_verified: true,
  ...over,
});

const live = () => new AbortController().signal;

describe("the state machine is a total, pure function", () => {
  it("moves through the read path", () => {
    expect(transition("Authenticating", { type: "identity_verified" })).toBe("AssemblingContext");
    expect(transition("AssemblingContext", { type: "context_assembled" })).toBe("ResolvingIntent");
    expect(transition("ResolvingIntent", { type: "intent_resolved", intent: "open" })).toBe(
      "Planning",
    );
    expect(transition("ResolvingIntent", { type: "intent_resolved", intent: "knowledge" })).toBe(
      "Retrieving",
    );
    expect(transition("Planning", { type: "planned", action: "call_tool" })).toBe("Selecting");
    expect(transition("Selecting", { type: "tool_selected" })).toBe("Authorizing");
    expect(transition("Authorizing", { type: "authorized" })).toBe("Executing");
    expect(transition("Executing", { type: "tool_executed" })).toBe("Observing");
    expect(transition("Observing", { type: "observation_ok" })).toBe("Verifying");
    expect(transition("Verifying", { type: "verified", complete: true })).toBe("Responding");
    expect(transition("Responding", { type: "responded" })).toBe("Completed");
  });

  it("loops back to Planning when there is more work", () => {
    expect(transition("Verifying", { type: "verified", complete: false })).toBe("Planning");
  });

  it("ends a denial in Denied, with the explanation composed from the decision", () => {
    // Doc 01 §4.3: the user always gets an explanation and it is generated from
    // the typed decision, never by asking the model to guess. That makes Denied
    // terminal — routing it through Responding would spend a model call to
    // explain, which is wrong when the denial was the budget running out.
    expect(transition("Authorizing", { type: "denied", rule_id: "r1" })).toBe("Denied");
    expect(isTerminal("Denied")).toBe(true);
  });

  it("accepts cancellation from every non-terminal state", () => {
    for (const state of [
      "Authenticating",
      "AssemblingContext",
      "ResolvingIntent",
      "Retrieving",
      "Planning",
      "Selecting",
      "Authorizing",
      "Executing",
      "Observing",
      "Verifying",
      "Responding",
    ] as const) {
      expect(transition(state, { type: "cancelled" })).toBe("Cancelled");
    }
  });

  it("refuses to move on from a terminal state", () => {
    for (const state of ["Completed", "Cancelled", "Failed", "Denied"] as const) {
      expect(() => transition(state, { type: "cancelled" })).toThrow(InvalidTransitionError);
    }
  });

  it("throws on an event that does not belong in the state, rather than ignoring it", () => {
    // A silently dropped transition produces a run whose log and state disagree,
    // and the log is what replay and evaluation are built on.
    expect(() => transition("Authenticating", { type: "responded" })).toThrow(
      InvalidTransitionError,
    );
    expect(() => transition("Executing", { type: "retrieved" })).toThrow(InvalidTransitionError);
  });

  it("is pure — the same input always gives the same output", () => {
    const once = transition("Planning", { type: "planned", action: "call_tool" });
    const twice = transition("Planning", { type: "planned", action: "call_tool" });
    expect(once).toBe(twice);
  });
});

describe("the full read-path lifecycle, with no network", () => {
  it("completes a tool-calling run and records every transition", async () => {
    const stepLog = new InMemoryStepLog();
    const model = new FakeModel({
      intent: "open",
      plan: [
        { kind: "call_tool", tool: "list_customers", arguments: { inactive_days: 30 } },
        { kind: "respond", reason: "have the data" },
      ],
      answer: "43 customers have not logged in for 30 days.",
    });
    const tools = new FakeTools();
    const ports = makePorts({ stepLog, model, tool: tools });

    const snapshot = await run(ports, input(), live());

    expect(snapshot.state).toBe("Completed");
    expect(snapshot.answer).toBe("43 customers have not logged in for 30 days.");
    expect(tools.executed).toEqual(["list_customers"]);

    const types = stepLog.steps.map((s) => s.type);
    expect(types).toEqual([
      "context", // identity verified
      "context", // context assembled
      "route", // intent resolved
      "route", // planned: call_tool
      "model", // tool selected
      "policy", // authorized
      "tool", // executed
      "verify", // observation ok
      "verify", // verified
      "response", // responded
    ]);
  });

  it("retrieves first for a knowledge question", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({
      stepLog,
      model: new FakeModel({ intent: "knowledge", plan: { kind: "respond", reason: "answered" } }),
      knowledge: new FakeKnowledge([
        { source: "knowledge", text: "Refunds within 7 days.", integrity: "external" },
      ]),
    });

    const snapshot = await run(ports, input({ message: "How do refunds work?" }), live());

    expect(snapshot.state).toBe("Completed");
    expect(stepLog.steps.some((s) => s.type === "retrieval")).toBe(true);
  });

  it("labels a retrieval step external, so the taint travels with the trace", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({
      stepLog,
      model: new FakeModel({ intent: "knowledge", plan: { kind: "respond", reason: "answered" } }),
      knowledge: new FakeKnowledge([
        { source: "knowledge", text: "Anything at all.", integrity: "external" },
      ]),
    });

    await run(ports, input(), live());

    const retrieval = stepLog.steps.find((s) => s.type === "retrieval");
    expect(retrieval?.integrity).toBe("external");
  });

  it("fails closed when identity was not verified", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({ stepLog });

    const snapshot = await run(ports, input({ identity_verified: false }), live());

    expect(snapshot.state).toBe("Failed");
    expect(snapshot.error_class).toBe("AuthenticationError");
    // Explained from the typed error, not by a model call.
    expect(snapshot.answer).toContain("session could not be verified");
    // Nothing beyond authentication ran.
    expect(stepLog.steps).toHaveLength(1);
  });

  it("denies rather than executing when policy says no", async () => {
    const stepLog = new InMemoryStepLog();
    const tools = new FakeTools();
    const ports = makePorts({
      stepLog,
      model: new FakeModel({
        plan: { kind: "call_tool", tool: "cancel_subscription", arguments: {} },
      }),
      policy: new FakePolicy({ effect: "deny", rule_id: "no-mutations", reason: "read-only" }),
      tool: tools,
    });

    const snapshot = await run(ports, input(), live());

    expect(snapshot.state).toBe("Denied");
    expect(tools.executed).toEqual([]);
    expect(stepLog.steps.some((s) => s.error_class === "AuthorizationError")).toBe(true);
    // The explanation exists and names the reason, without a model call.
    expect(snapshot.answer).toContain("read-only");
  });

  it("treats require_approval as a denial on the read path rather than executing", async () => {
    // The approval manager lands in slice 2. Until then the safe reading is a
    // denial; quietly executing would be the unsafe one.
    const tools = new FakeTools();
    const ports = makePorts({
      model: new FakeModel({ plan: { kind: "call_tool", tool: "upgrade_plan", arguments: {} } }),
      policy: new FakePolicy({ effect: "require_approval", rule_id: "high-risk", mode: "confirm" }),
      tool: tools,
    });

    const snapshot = await run(ports, input(), live());

    expect(snapshot.state).toBe("Denied");
    expect(tools.executed).toEqual([]);
  });

  it("fails when the planner names a tool that does not exist", async () => {
    const ports = makePorts({
      model: new FakeModel({ plan: { kind: "call_tool", tool: "nope", arguments: {} } }),
      tool: new FakeTools({ resolve: undefined }),
    });

    const snapshot = await run(ports, input(), live());

    expect(snapshot.state).toBe("Failed");
    expect(snapshot.error_class).toBe("ToolUnavailableError");
  });
});

describe("budget", () => {
  it("stops on entry to Planning when the budget is already exhausted", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({
      stepLog,
      budget: new FakeBudget({
        class: "AgentLimitError",
        message: "spent",
        limit: "cost_usd",
        budget: 0.5,
        consumed: 0.6,
      }),
    });

    const snapshot = await run(ports, input(), live());

    expect(snapshot.state).toBe("Failed");
    expect(snapshot.error_class).toBe("AgentLimitError");
    // It got as far as Planning and stopped there — no plan call was made.
    expect(stepLog.steps.map((s) => s.type)).toEqual(["context", "context", "route", "recover"]);
  });

  it("records model and tool calls through the port", async () => {
    const budget = new FakeBudget();
    const ports = makePorts({
      budget,
      model: new FakeModel({
        plan: [
          { kind: "call_tool", tool: "list_customers", arguments: {} },
          { kind: "respond", reason: "done" },
        ],
      }),
    });

    await run(ports, input(), live());

    // classifyIntent + one plan + compose. The second plan never happens:
    // verification completes the run after the tool result.
    expect(budget.modelCalls).toBe(3);
    expect(budget.toolCalls).toBe(1);
  });
});

describe("cancellation is a transition, not an exception", () => {
  it("stops at the next boundary and records a terminal Cancelled state", async () => {
    const stepLog = new InMemoryStepLog();
    const controller = new AbortController();
    controller.abort();

    const snapshot = await run(makePorts({ stepLog }), input(), controller.signal);

    expect(snapshot.state).toBe("Cancelled");
    expect(isTerminal(snapshot.state)).toBe(true);
    expect(stepLog.steps).toHaveLength(1);
    expect(stepLog.steps[0]?.status).toBe("skipped");
  });

  it("cancels mid-run without throwing", async () => {
    const stepLog = new InMemoryStepLog();
    const controller = new AbortController();

    // Abort once the tool has run, so cancellation lands mid-lifecycle.
    const tools = new FakeTools();
    const originalExecute = tools.execute.bind(tools);
    tools.execute = async (call) => {
      const result = await originalExecute(call);
      controller.abort();
      return result;
    };

    const ports = makePorts({
      stepLog,
      tool: tools,
      model: new FakeModel({ plan: { kind: "call_tool", tool: "list_customers", arguments: {} } }),
    });

    const snapshot = await run(ports, input(), controller.signal);

    expect(snapshot.state).toBe("Cancelled");
    expect(stepLog.steps.at(-1)?.payload.event).toEqual({ type: "cancelled" });
  });
});

describe("replay re-derives state from the log", () => {
  it("reproduces the identical state of a completed run", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({
      stepLog,
      model: new FakeModel({
        plan: [
          { kind: "call_tool", tool: "list_customers", arguments: { inactive_days: 30 } },
          { kind: "respond", reason: "done" },
        ],
      }),
    });

    const live_ = await run(ports, input(), live());
    const replayed = replay("run_test", stepLog.steps);

    expect(replayed.state).toBe(live_.state);
    expect(replayed.seq).toBe(live_.seq);
    expect(verifyAgainst("run_test", stepLog.steps, live_)).toBe(true);
  });

  it.each([
    ["a denial", { effect: "deny", rule_id: "r", reason: "no" } as const],
    ["an allow", { effect: "allow", rule_id: "r" } as const],
  ])("reproduces %s", async (_label, decision) => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({
      stepLog,
      policy: new FakePolicy(decision),
      model: new FakeModel({
        plan: [
          { kind: "call_tool", tool: "list_customers", arguments: {} },
          { kind: "respond", reason: "done" },
        ],
      }),
    });

    const original = await run(ports, input(), live());

    expect(replay("run_test", stepLog.steps).state).toBe(original.state);
  });

  it("reproduces a cancelled run", async () => {
    const stepLog = new InMemoryStepLog();
    const controller = new AbortController();
    controller.abort();

    const original = await run(makePorts({ stepLog }), input(), controller.signal);

    expect(replay("run_test", stepLog.steps).state).toBe("Cancelled");
    expect(replay("run_test", stepLog.steps).state).toBe(original.state);
  });

  it("is order-independent — sorting by seq is what defines the history", async () => {
    const stepLog = new InMemoryStepLog();
    const ports = makePorts({ stepLog });
    const original = await run(ports, input(), live());

    const shuffled = [...stepLog.steps].reverse();

    expect(replay("run_test", shuffled).state).toBe(original.state);
  });

  it("is deterministic across repeated replays", async () => {
    const stepLog = new InMemoryStepLog();
    await run(makePorts({ stepLog }), input(), live());

    const first = replay("run_test", stepLog.steps);
    const second = replay("run_test", stepLog.steps);

    expect(first).toEqual(second);
  });

  it("rejects a log whose step carries no event rather than inventing a state", async () => {
    const stepLog = new InMemoryStepLog();
    await run(makePorts({ stepLog }), input(), live());

    const corrupt = stepLog.steps.map((s, i) => (i === 1 ? { ...s, payload: {} } : s));

    expect(() => replay("run_test", corrupt)).toThrow(/carries no event/);
  });

  it("notices when the claimed state disagrees with the log", async () => {
    const stepLog = new InMemoryStepLog();
    const original = await run(makePorts({ stepLog }), input(), live());

    expect(verifyAgainst("run_test", stepLog.steps, { ...original, state: "Failed" })).toBe(false);
  });
});
