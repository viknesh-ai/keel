import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checksumOf,
  discoverMigrations,
  parseMigrationFilename,
} from "../src/migrations/discover.js";

describe("parseMigrationFilename", () => {
  it("accepts NNNN_name.sql", () => {
    const result = parseMigrationFilename("0001_init.sql");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ version: "0001", name: "init" });
  });

  it.each([
    "1_init.sql",
    "00001_init.sql",
    "0001-init.sql",
    "0001_Init.sql",
    "0001_init.SQL",
    "init.sql",
    "0001_.sql",
  ])("rejects %s", (filename) => {
    const result = parseMigrationFilename(filename);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "malformed_filename", filename });
  });
});

describe("checksumOf", () => {
  it("changes when a single byte of whitespace changes", () => {
    expect(checksumOf("select 1;")).not.toBe(checksumOf("select 1; "));
  });
});

describe("discoverMigrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns files in version order and ignores non-sql entries", async () => {
    await writeFile(join(dir, "0002_second.sql"), "select 2;");
    await writeFile(join(dir, "0001_first.sql"), "select 1;");
    await writeFile(join(dir, "README.md"), "# not a migration");

    const result = await discoverMigrations(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.filename)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(result.value[0]?.checksum).toBe(checksumOf("select 1;"));
  });

  it("rejects a stray .sql file rather than skipping it silently", async () => {
    await writeFile(join(dir, "0001_first.sql"), "select 1;");
    await writeFile(join(dir, "scratch.sql"), "select 99;");

    const result = await discoverMigrations(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "malformed_filename", filename: "scratch.sql" });
  });

  it("rejects two files claiming the same version", async () => {
    await writeFile(join(dir, "0001_first.sql"), "select 1;");
    await writeFile(join(dir, "0001_also_first.sql"), "select 2;");

    const result = await discoverMigrations(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "duplicate_version", version: "0001" });
  });

  it("reports an unreadable directory as a value, not an exception", async () => {
    const result = await discoverMigrations(join(dir, "does-not-exist"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("directory_unreadable");
  });
});
