export type MigrationFile = {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
};

export type AppliedMigration = {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
};

export type MigrationPlan = {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
};

/**
 * Closed union. Every failure the runner can produce is a member, and the CLI
 * maps each to an exit code — 1 for anything that means "the migrations on disk
 * disagree with the database", 2 for anything that means "we could not talk to
 * the database or a statement failed".
 */
export type MigrateError =
  | { readonly kind: "malformed_filename"; readonly filename: string }
  | {
      readonly kind: "duplicate_version";
      readonly version: string;
      readonly filenames: readonly string[];
    }
  | {
      readonly kind: "checksum_mismatch";
      readonly version: string;
      readonly filename: string;
      readonly appliedChecksum: string;
      readonly fileChecksum: string;
      readonly appliedAt: Date;
    }
  | { readonly kind: "applied_file_missing"; readonly version: string; readonly filename: string }
  | {
      readonly kind: "out_of_order";
      readonly version: string;
      readonly filename: string;
      readonly highestApplied: string;
    }
  | { readonly kind: "directory_unreadable"; readonly dir: string; readonly message: string }
  | { readonly kind: "lock_unavailable" }
  | {
      readonly kind: "apply_failed";
      readonly version: string;
      readonly filename: string;
      readonly pgCode: string | undefined;
      readonly message: string;
    };

/** Drift means the files and the database disagree. Exit code 1. */
export const isDriftError = (error: MigrateError): boolean =>
  error.kind === "malformed_filename" ||
  error.kind === "duplicate_version" ||
  error.kind === "checksum_mismatch" ||
  error.kind === "applied_file_missing" ||
  error.kind === "out_of_order";

export function describeMigrateError(error: MigrateError): string {
  switch (error.kind) {
    case "malformed_filename":
      return `${error.filename} is not a migration filename. Expected NNNN_name.sql, four digits and lowercase.`;
    case "duplicate_version":
      return `version ${error.version} is claimed by more than one file: ${error.filenames.join(", ")}`;
    case "checksum_mismatch":
      return [
        `${error.filename} has changed since it was applied on ${error.appliedAt.toISOString()}.`,
        `       applied checksum ${error.appliedChecksum}`,
        `       file checksum    ${error.fileChecksum}`,
        "       Migrations are forward-only. Write a new migration instead of editing",
        "       an applied one. Nothing was applied.",
      ].join("\n");
    case "applied_file_missing":
      return `${error.filename} is recorded as applied but is no longer on disk. Restore it; do not delete applied migrations.`;
    case "out_of_order":
      return `${error.filename} sorts below ${error.highestApplied}, which is already applied. Migrations are forward-only — renumber it above the highest applied version.`;
    case "directory_unreadable":
      return `could not read ${error.dir}: ${error.message}`;
    case "lock_unavailable":
      return "another migration run holds the advisory lock on this database. Nothing was applied.";
    case "apply_failed":
      return `${error.filename} failed${error.pgCode === undefined ? "" : ` (SQLSTATE ${error.pgCode})`}: ${error.message}\n       The transaction was rolled back and no row was written to schema_migrations.`;
  }
}
