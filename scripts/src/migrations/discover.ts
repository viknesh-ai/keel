import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../result.js";
import type { MigrateError, MigrationFile } from "./types.js";

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFilename(
  filename: string,
): Result<{ version: string; name: string }, MigrateError> {
  const match = FILENAME.exec(filename);
  if (match === null) return err({ kind: "malformed_filename", filename });

  const [, version, name] = match;
  if (version === undefined || name === undefined) {
    return err({ kind: "malformed_filename", filename });
  }
  return ok({ version, name });
}

/** SHA-256 over the raw file bytes. Whitespace counts; that is the point. */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Reads every .sql file in `dir`, in version order. A .sql file that does not
 * match the naming convention is an error rather than a silent skip — a
 * migration nobody notices is worse than a build that stops.
 */
export async function discoverMigrations(
  dir: string,
): Promise<Result<readonly MigrationFile[], MigrateError>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: "directory_unreadable", dir, message });
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  const seen = new Map<string, string[]>();

  for (const filename of sqlFiles) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed.ok) return parsed;

    const { version, name } = parsed.value;
    const claimants = seen.get(version) ?? [];
    claimants.push(filename);
    seen.set(version, claimants);

    const sql = await readFile(join(dir, filename), "utf8");
    files.push({ version, name, filename, checksum: checksumOf(sql), sql });
  }

  for (const [version, filenames] of seen) {
    if (filenames.length > 1) return err({ kind: "duplicate_version", version, filenames });
  }

  return ok(files);
}
