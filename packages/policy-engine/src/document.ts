import { z } from "zod";

/**
 * The policy document from docs/architecture/03 §C2.
 *
 * Policy is data, versioned in git and diffable in review, so a policy change
 * and a code change land in the same pull request. That is only true if the
 * document has a schema strict enough to reject a typo — a rule silently
 * ignored because its key was misspelled is worse than no rule, because the
 * author believes it is in force.
 *
 * Hence `.strict()` throughout: an unknown key is an error, not a comment.
 */

export const RISK_LEVELS = ["read", "low", "high", "critical"] as const;
export const SIDE_EFFECTS = ["read", "write", "destructive"] as const;
export const INTEGRITY_LEVELS = ["system", "developer", "user", "tool", "external"] as const;
export const EFFECTS = ["allow", "deny"] as const;

/**
 * Comparison operators for argument matching. Deliberately small: every operator
 * here is total over its inputs and has one obvious meaning. A regex operator
 * would let a policy author write a ReDoS into the authorization path.
 */
export const comparisonSchema = z
  .object({
    eq: z.unknown().optional(),
    ne: z.unknown().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    in: z.array(z.unknown()).optional(),
    contains: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Present and non-null. */
    exists: z.boolean().optional(),
  })
  .strict();

export type Comparison = z.infer<typeof comparisonSchema>;

/** A leaf is either a literal (exact match) or a comparison object. */
export const matcherSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  comparisonSchema,
]);

export const toolMatchSchema = z.union([
  /** A name, or a list of names. */
  z.string(),
  z.array(z.string()),
  z
    .object({
      name: z.union([z.string(), z.array(z.string())]).optional(),
      risk: z.union([z.enum(RISK_LEVELS), z.array(z.enum(RISK_LEVELS))]).optional(),
      side_effect: z.union([z.enum(SIDE_EFFECTS), z.array(z.enum(SIDE_EFFECTS))]).optional(),
      target: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict(),
]);

export const matchSchema = z
  .object({
    tool: toolMatchSchema.optional(),
    /** Matched against the call's arguments, by path. */
    args: z.record(z.string(), matcherSchema).optional(),
  })
  .strict();

export const whenSchema = z
  .object({
    principal: z
      .object({
        authenticated: z.boolean().optional(),
        id: matcherSchema.optional(),
        role: matcherSchema.optional(),
        org_id: matcherSchema.optional(),
        permissions: comparisonSchema.optional(),
        attributes: z.record(z.string(), matcherSchema).optional(),
      })
      .strict()
      .optional(),
    resource: z.record(z.string(), matcherSchema).optional(),
    args: z
      .object({
        /** The taint of the arguments — invariant I1. */
        integrity: z
          .union([z.enum(INTEGRITY_LEVELS), z.array(z.enum(INTEGRITY_LEVELS))])
          .optional(),
      })
      .strict()
      .optional(),
    environment: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

export const approvalSchema = z
  .object({
    mode: z.enum(["confirm", "approve"]),
    by: z.object({ role: z.string() }).strict().optional(),
    expires_in: z
      .string()
      .regex(/^\d+[smhd]$/, "expires_in must look like 30m, 2h or 1d")
      .optional(),
  })
  .strict();

export const ruleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "rule ids are lowercase kebab-case"),
    match: matchSchema,
    when: whenSchema.optional(),
    effect: z.enum(EFFECTS),
    /** Present on an allow, this makes the decision require_approval. */
    approval: approvalSchema.optional(),
    /** Surfaced to the user in plain language on a deny. */
    message: z.string().max(500).optional(),
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;

export const policyDocumentSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        // Default-deny, always. The field exists so the document states it out
        // loud rather than relying on the reader knowing, but `allow` is not a
        // permitted value: a policy file that opens by default is not a policy.
        effect: z.literal("deny"),
      })
      .strict()
      .default({ effect: "deny" }),
    rules: z.array(ruleSchema).max(500),
  })
  .strict();

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

export type PolicyParseIssue = { readonly path: string; readonly message: string };

export type PolicyParseResult =
  | { readonly ok: true; readonly document: PolicyDocument }
  | { readonly ok: false; readonly issues: readonly PolicyParseIssue[] };

/**
 * Parses a policy document from already-decoded data.
 *
 * YAML decoding is the caller's job — this package does no I/O and takes no
 * dependency on a YAML parser, so the same evaluator runs unchanged in a
 * browser, in the CLI and in the runtime.
 */
export function parsePolicyDocument(candidate: unknown): PolicyParseResult {
  const parsed = policyDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  // Duplicate rule ids would make "why was this denied?" ambiguous, which is
  // the one question the whole design exists to answer.
  const seen = new Set<string>();
  const duplicates: PolicyParseIssue[] = [];
  for (const [index, rule] of parsed.data.rules.entries()) {
    if (seen.has(rule.id)) {
      duplicates.push({ path: `rules.${index}.id`, message: `duplicate rule id "${rule.id}"` });
    }
    seen.add(rule.id);
  }

  return duplicates.length === 0
    ? { ok: true, document: parsed.data }
    : { ok: false, issues: duplicates };
}
