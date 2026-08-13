/**
 * Errors are values in the domain layer (CLAUDE.md § Style). Only the CLI
 * boundary in migrate.ts turns one into a process exit.
 *
 * This is deliberately local. Session 0.3 builds the canonical error taxonomy
 * in packages/contracts/src/errors.ts, and this type folds into it then.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
