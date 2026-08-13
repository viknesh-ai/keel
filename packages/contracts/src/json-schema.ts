import { z } from "zod";

/**
 * Zod → JSON Schema (ADR-008).
 *
 * Developers author in Zod because it has the best TS ergonomics and it is what
 * the tool-definition API exposes. Models and storage need JSON Schema. Emitting
 * one from the other — rather than maintaining both — is what keeps them from
 * drifting, and the round-trip is tested.
 */

export type JsonSchema = Record<string, unknown>;

export type EmitTarget =
  /** For persistence and for our own validation. Keeps everything Zod expressed. */
  | "storage"
  /**
   * For model tool definitions. Providers reject or silently mangle some
   * constructs, so this is the conservative dialect.
   */
  | "model";

export type EmitOptions = {
  readonly target?: EmitTarget;
  /** Sets `$id` and `title`, which providers surface in error messages. */
  readonly name?: string;
};

/**
 * Emit JSON Schema for a Zod schema.
 *
 * `io: "output"` matters: it emits the schema of what Zod *produces*, so a field
 * with a default is required in the output shape rather than optional. That is
 * the correct contract for a stored record, and the wrong one for input
 * validation — hence the distinction being explicit rather than assumed.
 */
export function toJsonSchema(schema: z.ZodType, options: EmitOptions = {}): JsonSchema {
  const target = options.target ?? "storage";

  const emitted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    // Providers vary in cycle support; inlining keeps the model dialect flat.
    reused: target === "model" ? "inline" : "ref",
    unrepresentable: "any",
  }) as JsonSchema;

  if (options.name !== undefined) {
    return { $id: options.name, title: options.name, ...emitted };
  }
  return emitted;
}

/**
 * The input-side schema: fields with defaults are optional, because the caller
 * legitimately may omit them. This is what validates a tool author's hand-written
 * contract before it is parsed.
 */
export function toInputJsonSchema(schema: z.ZodType, options: EmitOptions = {}): JsonSchema {
  const emitted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    reused: (options.target ?? "storage") === "model" ? "inline" : "ref",
    unrepresentable: "any",
  }) as JsonSchema;

  if (options.name !== undefined) {
    return { $id: options.name, title: options.name, ...emitted };
  }
  return emitted;
}
