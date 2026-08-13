/**
 * Trust levels and label propagation — docs/architecture/01 §4.4.
 *
 * Every value that moves through a run carries an integrity label. The Policy
 * Engine enforces two invariants over these labels:
 *
 *   I1 (control-flow integrity)  arguments to a tool with side_effect != "read"
 *                                may not derive from `external` data unless the
 *                                tool sets accepts_untrusted_args, or the call
 *                                is human-approved.
 *   I2 (data-flow confinement)   data retrieved under user U's ACL may not be
 *                                passed to a tool whose egress is not permitted
 *                                to receive it.
 *
 * These are architectural guarantees. They hold when the injection succeeds —
 * which is the point. They reduce blast radius; they do not eliminate the risk,
 * and the docs say so plainly rather than overclaiming.
 */

/** Ordered most-trusted to least. The order is load-bearing — see `meet`. */
export const INTEGRITY_LEVELS = ["system", "developer", "user", "tool", "external"] as const;

export type IntegrityLevel = (typeof INTEGRITY_LEVELS)[number];

const RANK: Record<IntegrityLevel, number> = {
  system: 0,
  developer: 1,
  user: 2,
  tool: 3,
  external: 4,
};

/** True when `a` is at least as trusted as `b`. */
export function atLeastAsTrustedAs(a: IntegrityLevel, b: IntegrityLevel): boolean {
  return RANK[a] <= RANK[b];
}

/**
 * The label of a value derived from several inputs: the *least* trusted of them.
 *
 * This is the whole propagation rule. Mixing one external string into an
 * otherwise trusted structure taints the result, because an attacker who
 * controls any input controls the output.
 *
 * With no inputs the result is `system`: a constant derived from nothing is
 * Keel's own, and there is no untrusted source to inherit from.
 */
export function meet(...levels: readonly IntegrityLevel[]): IntegrityLevel {
  let worst: IntegrityLevel = "system";
  for (const level of levels) {
    if (RANK[level] > RANK[worst]) worst = level;
  }
  return worst;
}

/** A value paired with the trust level of everything it was derived from. */
export type Labelled<T> = {
  readonly value: T;
  readonly integrity: IntegrityLevel;
  /**
   * Which ACL tags the value was retrieved under. Empty means unrestricted.
   * Carried for I2: an egress check needs to know what it would be releasing.
   */
  readonly acl_tags: readonly string[];
};

export function label<T>(
  value: T,
  integrity: IntegrityLevel,
  acl_tags: readonly string[] = [],
): Labelled<T> {
  return { value, integrity, acl_tags };
}

/**
 * Combine labels when deriving a new value. Integrity meets down to the least
 * trusted input; ACL tags *union*, because the result carries the access
 * restrictions of every source that contributed to it.
 */
export function combine<T>(value: T, ...sources: readonly Labelled<unknown>[]): Labelled<T> {
  const integrity = meet(...sources.map((source) => source.integrity));
  const tags = new Set<string>();
  for (const source of sources) {
    for (const tag of source.acl_tags) tags.add(tag);
  }
  return { value, integrity, acl_tags: [...tags].sort() };
}

/** Mapping a labelled value preserves its label — the derivation is unchanged. */
export function mapLabelled<T, U>(source: Labelled<T>, fn: (value: T) => U): Labelled<U> {
  return { value: fn(source.value), integrity: source.integrity, acl_tags: source.acl_tags };
}

export const isUntrusted = (level: IntegrityLevel): boolean => level === "external";

export type InvariantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly invariant: "I1" | "I2"; readonly reason: string };

/**
 * I1. A mutating tool may not take arguments derived from external data.
 *
 * Two escape hatches, both explicit and both recorded: the tool declares
 * `accepts_untrusted_args`, or a human approved this specific call. Nothing
 * else opens the gate — in particular, the model asserting that the data looks
 * fine is not an input to this decision.
 */
export function checkI1(input: {
  readonly sideEffect: "read" | "write" | "destructive";
  readonly argumentIntegrity: IntegrityLevel;
  readonly acceptsUntrustedArgs: boolean;
  readonly humanApproved: boolean;
}): InvariantCheck {
  if (input.sideEffect === "read") return { ok: true };
  if (!isUntrusted(input.argumentIntegrity)) return { ok: true };
  if (input.acceptsUntrustedArgs) return { ok: true };
  if (input.humanApproved) return { ok: true };

  return {
    ok: false,
    invariant: "I1",
    reason: `arguments to a ${input.sideEffect} tool derive from external data, and the tool neither accepts untrusted arguments nor was this call approved`,
  };
}

/**
 * I2. Data carrying ACL tags may not reach a destination not allowlisted for it.
 *
 * An empty `egressAllowlist` denies everything, which is the default-deny
 * posture from CLAUDE.md hard rule 6: a tool that has not declared where it may
 * send data may not send tagged data anywhere.
 */
export function checkI2(input: {
  readonly aclTags: readonly string[];
  readonly destination: string;
  readonly egressAllowlist: readonly string[];
}): InvariantCheck {
  if (input.aclTags.length === 0) return { ok: true };
  if (input.egressAllowlist.includes(input.destination)) return { ok: true };

  return {
    ok: false,
    invariant: "I2",
    reason: `data tagged [${input.aclTags.join(", ")}] would be sent to "${input.destination}", which is not in the egress allowlist`,
  };
}
