import { describe, expect, it, vi } from "vitest";
import { ModelRouter, type RouterConfig, UnknownProviderError } from "../src/router.js";
import type { ModelProvider } from "../src/types.js";

const stub = (id: string): ModelProvider =>
  ({
    id,
    capabilities: new Set(["streaming"]),
    generate: () => {
      throw new Error("not used");
    },
    structured: () => {
      throw new Error("not used");
    },
    embed: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
  }) as unknown as ModelProvider;

const providers = new Map<string, ModelProvider>([
  ["anthropic", stub("anthropic")],
  ["local", stub("local")],
  ["backup", stub("backup")],
]);

const baseConfig: RouterConfig = {
  routes: {
    default: { provider: "anthropic", model: "claude-sonnet-4-5" },
    "intent.classify": { provider: "local", model: "qwen2.5:0.5b" },
    "extract.untrusted": { provider: "local", model: "qwen2.5:0.5b" },
    "plan.complex": { provider: "anthropic", model: "claude-opus-4-1" },
  },
};

describe("routing decisions", () => {
  it("uses the explicit route for a declared task class", () => {
    const router = new ModelRouter(providers, baseConfig);

    expect(router.route("plan.complex")).toEqual({
      task_class: "plan.complex",
      chosen: { provider: "anthropic", model: "claude-opus-4-1" },
      reason: "explicit_route",
    });
  });

  it("falls back to the default route and says so", () => {
    const router = new ModelRouter(providers, baseConfig);

    expect(router.route("respond.compose")).toEqual({
      task_class: "respond.compose",
      chosen: { provider: "anthropic", model: "claude-sonnet-4-5" },
      reason: "default_route",
    });
  });

  it("sends extract.untrusted to the small local model — capability restriction is the point", () => {
    const router = new ModelRouter(providers, baseConfig);

    expect(router.route("extract.untrusted").chosen).toEqual({
      provider: "local",
      model: "qwen2.5:0.5b",
    });
  });

  it("rejects a route naming a provider that is not registered", () => {
    const router = new ModelRouter(providers, {
      routes: { default: { provider: "nope", model: "x" } },
    });

    expect(() => router.providerFor({ provider: "nope", model: "x" })).toThrow(
      UnknownProviderError,
    );
  });
});

describe("failover", () => {
  const failing = () =>
    Promise.reject(Object.assign(new Error("down"), { class: "ModelProviderError" }));

  it("is off by default — a failure propagates rather than silently switching models", async () => {
    const router = new ModelRouter(providers, baseConfig);

    await expect(router.run("plan.complex", new AbortController().signal, failing)).rejects.toThrow(
      "down",
    );
  });

  it("is off when a chain is configured but not enabled", async () => {
    const router = new ModelRouter(providers, {
      ...baseConfig,
      failover: { enabled: false, chain: [{ provider: "backup", model: "b" }] },
    });

    await expect(router.run("plan.complex", new AbortController().signal, failing)).rejects.toThrow(
      "down",
    );
  });

  it("switches only when explicitly enabled, and records what it tried", async () => {
    const router = new ModelRouter(providers, {
      ...baseConfig,
      failover: { enabled: true, chain: [{ provider: "backup", model: "b" }] },
    });

    const call = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("down"), { class: "ModelProviderError" }))
      .mockResolvedValueOnce("recovered");

    const result = await router.run("plan.complex", new AbortController().signal, call);

    expect(result.result).toBe("recovered");
    expect(result.decision.reason).toBe("failover");
    expect(result.decision.chosen).toEqual({ provider: "backup", model: "b" });
    expect(result.decision.attempted).toEqual([
      {
        target: { provider: "anthropic", model: "claude-opus-4-1" },
        error_class: "ModelProviderError",
      },
    ]);
  });

  it("does not fail over a cancelled call — the user asked for it to stop", async () => {
    const router = new ModelRouter(providers, {
      ...baseConfig,
      failover: { enabled: true, chain: [{ provider: "backup", model: "b" }] },
    });

    const controller = new AbortController();
    const call = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });

    await expect(router.run("plan.complex", controller.signal, call)).rejects.toThrow("aborted");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("propagates the original failure when the whole chain fails", async () => {
    const router = new ModelRouter(providers, {
      ...baseConfig,
      failover: { enabled: true, chain: [{ provider: "backup", model: "b" }] },
    });

    await expect(router.run("plan.complex", new AbortController().signal, failing)).rejects.toThrow(
      "down",
    );
  });
});
