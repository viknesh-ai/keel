import { err, ok, type Result } from "../result.js";
import type { AppliedMigration, MigrateError, MigrationFile, MigrationPlan } from "./types.js";

/**
 * Pure. No I/O, no database, no clock.
 *
 * Every check runs before the plan is returned, so a run that would fail on
 * migration 7 applies nothing at all rather than leaving the database halfway.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): Result<MigrationPlan, MigrateError> {
  const byVersion = new Map(files.map((file) => [file.version, file]));

  for (const record of applied) {
    const file = byVersion.get(record.version);
    if (file === undefined) {
      return err({
        kind: "applied_file_missing",
        version: record.version,
        filename: record.filename,
      });
    }
    if (file.checksum !== record.checksum) {
      return err({
        kind: "checksum_mismatch",
        version: record.version,
        filename: file.filename,
        appliedChecksum: record.checksum,
        fileChecksum: file.checksum,
        appliedAt: record.appliedAt,
      });
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const highestApplied = applied.reduce<string | undefined>(
    (highest, record) =>
      highest === undefined || record.version > highest ? record.version : highest,
    undefined,
  );

  const pending = files.filter((file) => !appliedVersions.has(file.version));

  if (highestApplied !== undefined) {
    for (const file of pending) {
      if (file.version < highestApplied) {
        return err({
          kind: "out_of_order",
          version: file.version,
          filename: file.filename,
          highestApplied,
        });
      }
    }
  }

  const sortedApplied = [...applied].sort((a, b) => a.version.localeCompare(b.version));
  return ok({ applied: sortedApplied, pending });
}
