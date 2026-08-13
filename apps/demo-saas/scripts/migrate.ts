import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, describeMigrateError, migrate } from "@keel/scripts";
import { Client } from "pg";
import { config } from "../src/config.js";

/**
 * Northwind's migrations, run by Keel's migration harness.
 *
 * Reusing the runner is deliberate: it proves the harness is not welded to
 * Keel's own schema, and Northwind gets checksum and ordering guarantees for
 * free. The database is separate — Northwind is the customer's product.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

async function ensureDatabase(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const name = url.pathname.slice(1);
  url.pathname = "/postgres";

  const admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) {
      await admin.query(`create database "${name}"`);
      process.stdout.write(`created database ${name}\n`);
    }
  } finally {
    await admin.end();
  }
}

await ensureDatabase();

const client = await connect(config.databaseUrl);
try {
  const result = await migrate(client, {
    dir,
    dryRun: false,
    onEvent: (event) => {
      if (event.kind === "applied") process.stdout.write(`applied ${event.migration.filename}\n`);
      if (event.kind === "up_to_date") process.stdout.write("already up to date\n");
    },
  });
  if (!result.ok) {
    process.stderr.write(`error: ${describeMigrateError(result.error)}\n`);
    process.exit(1);
  }
} finally {
  await client.end();
}
