import { describe, expect, it } from "vitest";
import { planMigrations } from "../src/migrations/plan.js";
import type { AppliedMigration, MigrationFile } from "../src/migrations/types.js";

const file = (version: string, checksum: string): MigrationFile => ({
  version,
  name: "test",
  filename: `${version}_test.sql`,
  checksum,
  sql: "select 1",
});

const applied = (version: string, checksum: string): AppliedMigration => ({
  version,
  name: "test",
  filename: `${version}_test.sql`,
  checksum,
  appliedAt: new Date("2026-08-13T09:14:02Z"),
  durationMs: 12,
});

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("planMigrations", () => {
  it("treats every file as pending against an empty database", () => {
    const result = planMigrations([file("0001", A), file("0002", B)], []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending.map((f) => f.version)).toEqual(["0001", "0002"]);
    expect(result.value.applied).toEqual([]);
  });

  it("is a no-op when every migration is already applied", () => {
    const result = planMigrations([file("0001", A)], [applied("0001", A)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toEqual([]);
  });

  it("rejects a file whose checksum changed after it was applied", () => {
    const result = planMigrations([file("0001", B)], [applied("0001", A)]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "checksum_mismatch",
      version: "0001",
      appliedChecksum: A,
      fileChecksum: B,
    });
  });

  it("rejects a tampered file even when later migrations are valid", () => {
    const result = planMigrations([file("0001", B), file("0002", B)], [applied("0001", A)]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Nothing is planned, so nothing downstream can be applied either.
    expect(result.error.kind).toBe("checksum_mismatch");
  });

  it("rejects an applied migration whose file has been deleted", () => {
    const result = planMigrations([file("0002", B)], [applied("0001", A)]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "applied_file_missing", version: "0001" });
  });

  it("rejects a pending migration that sorts below the highest applied one", () => {
    const result = planMigrations(
      [file("0001", A), file("0002", B), file("0003", A)],
      [applied("0001", A), applied("0003", A)],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "out_of_order",
      version: "0002",
      highestApplied: "0003",
    });
  });

  it("allows a pending migration above the highest applied one", () => {
    const result = planMigrations([file("0001", A), file("0002", B)], [applied("0001", A)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending.map((f) => f.version)).toEqual(["0002"]);
  });
});
