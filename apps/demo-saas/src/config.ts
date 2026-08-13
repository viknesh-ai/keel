/** Northwind's own configuration. Nothing here is shared with Keel. */
export const config = {
  port: Number(process.env.NORTHWIND_PORT ?? 4000),
  databaseUrl:
    process.env.NORTHWIND_DATABASE_URL ?? "postgres://keel:keel@localhost:5432/northwind",
  sessionTtlHours: 12,
  /** Trailing window used by the "inactive" filter and the analytics summary. */
  inactiveDays: 30,
} as const;
