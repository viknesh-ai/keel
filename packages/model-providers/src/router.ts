import type { ModelProvider, TaskClass } from "./types.js";

/**
 * Task-class routing (doc 01 §5.1).
 *
 * Routing is by task class *declared by the runtime*, never guessed from the
 * prompt. "This looks like a hard question, use the big model" is a heuristic
 * that drifts silently; "this is a plan.complex call" is a fact the caller
 * knows.
 *
 * Every decision is returned as a structured object the runtime persists to the
 * step log. That table is what makes routing tunable instead of superstitious —
 * and it feeds the eval report, so a change that saves 40% cost but drops tool
 * accuracy 6% is visible before merge rather than after.
 */

export type RouteTarget = {
  /** Key into the providers map. */
  readonly provider: string;
  readonly model: string;
};

export type RouterConfig = {
  readonly routes: Readonly<Partial<Record<TaskClass, RouteTarget>>> & {
    readonly default: RouteTarget;
  };
  /**
   * Off unless explicitly enabled (doc 01 §5).
   *
   * Silently switching models changes behaviour, and a run that quietly used a
   * different model is a run whose trace lies. When enabled, every fallback is
   * recorded on the decision.
   */
  readonly failover?: {
    readonly enabled: boolean;
    readonly chain?: readonly RouteTarget[];
  };
};

export type RoutingDecision = {
  readonly task_class: TaskClass;
  readonly chosen: RouteTarget;
  readonly reason: "explicit_route" | "default_route" | "failover" | "capability_required";
  /** Populated on a failover so the trace shows what was tried and why it moved. */
  readonly attempted?: readonly {
    readonly target: RouteTarget;
    readonly error_class: string;
  }[];
};

export type RoutedCall<T> = {
  readonly decision: RoutingDecision;
  readonly result: T;
  readonly latency_ms: number;
};

export class UnknownProviderError extends Error {
  constructor(readonly provider: string) {
    super(`no provider registered under "${provider}"`);
    this.name = "UnknownProviderError";
  }
}

export class ModelRouter {
  constructor(
    private readonly providers: ReadonlyMap<string, ModelProvider>,
    private readonly config: RouterConfig,
  ) {}

  /** The decision alone, without making a call. Used by the policy explain view. */
  route(taskClass: TaskClass): RoutingDecision {
    const explicit = this.config.routes[taskClass];
    return explicit === undefined
      ? { task_class: taskClass, chosen: this.config.routes.default, reason: "default_route" }
      : { task_class: taskClass, chosen: explicit, reason: "explicit_route" };
  }

  providerFor(target: RouteTarget): ModelProvider {
    const provider = this.providers.get(target.provider);
    if (provider === undefined) throw new UnknownProviderError(target.provider);
    return provider;
  }

  /**
   * Runs `call` against the routed provider, applying the failover chain only
   * when it is explicitly enabled.
   *
   * `signal` is threaded through rather than swallowed: a cancelled call must
   * not trigger a failover, because the user asked for it to stop — retrying it
   * on another provider is the opposite of what they wanted.
   */
  async run<T>(
    taskClass: TaskClass,
    signal: AbortSignal,
    call: (provider: ModelProvider, target: RouteTarget) => Promise<T>,
  ): Promise<RoutedCall<T>> {
    const primary = this.route(taskClass);
    const startedAt = Date.now();

    try {
      const result = await call(this.providerFor(primary.chosen), primary.chosen);
      return { decision: primary, result, latency_ms: Date.now() - startedAt };
    } catch (cause) {
      if (signal.aborted) throw cause;

      const failover = this.config.failover;
      if (failover?.enabled !== true || failover.chain === undefined) throw cause;

      const attempted: { target: RouteTarget; error_class: string }[] = [
        { target: primary.chosen, error_class: errorClassOf(cause) },
      ];

      for (const target of failover.chain) {
        if (signal.aborted) throw cause;
        try {
          const result = await call(this.providerFor(target), target);
          return {
            decision: {
              task_class: taskClass,
              chosen: target,
              reason: "failover",
              attempted,
            },
            result,
            latency_ms: Date.now() - startedAt,
          };
        } catch (next) {
          attempted.push({ target, error_class: errorClassOf(next) });
        }
      }

      throw cause;
    }
  }
}

function errorClassOf(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "class" in cause) {
    const { class: errorClass } = cause as { class: unknown };
    if (typeof errorClass === "string") return errorClass;
  }
  return cause instanceof Error ? cause.name : "UnknownError";
}
