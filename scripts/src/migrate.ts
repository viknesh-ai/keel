import { parseArgs } from "node:util";
import { connect, redactDatabaseUrl, resolveDatabaseUrl } from "./db/connect.js";
import { ensureSchemaMigrationsTable, migrate, readAppliedMigrations } from "./migrations/apply.js";
import { discoverMigrations } from "./migrations/discover.js";
import { planMigrations } from "./migrations/plan.js";
import { describeMigrateError, isDriftError, type MigrateError } from "./migrations/types.js";

const USAGE = `Usage:  pnpm migrate [status] [options]

  (no command)    apply every pending migration, in filename order
  status          print applied and pending migrations, verify checksums, exit

Options:
  --url <dsn>                override DATABASE_URL
  --dir <path>               migrations directory (default: ./migrations)
  --dry-run                  print the plan, apply nothing
  --statement-timeout <ms>   per-statement timeout (default: 300000)
  --help

Exit codes:
  0   success, or nothing to do
  1   drift or validation failure
  2   could not connect, could not take the lock, or a migration failed
`;

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_FAILURE = 2;

function fail(error: MigrateError): never {
  process.stderr.write(`error: ${describeMigrateError(error)}\n`);
  process.exit(isDriftError(error) ? EXIT_DRIFT : EXIT_FAILURE);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "statement-timeout": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  const command = positionals[0] ?? "up";
  if (command !== "up" && command !== "status") {
    process.stderr.write(`error: unknown command "${command}".\n\n${USAGE}`);
    return EXIT_FAILURE;
  }

  const dir = values.dir ?? "migrations";
  const url = resolveDatabaseUrl(values.url);
  const timeout = values["statement-timeout"];

  process.stdout.write(`keel migrate → ${redactDatabaseUrl(url)}\n`);

  const client = await connect(
    url,
    timeout === undefined ? {} : { statementTimeoutMs: Number.parseInt(timeout, 10) },
  );

  try {
    if (command === "status") {
      await ensureSchemaMigrationsTable(client);
      const files = await discoverMigrations(dir);
      if (!files.ok) fail(files.error);

      const applied = await readAppliedMigrations(client);
      const planned = planMigrations(files.value, applied);
      if (!planned.ok) fail(planned.error);

      for (const record of planned.value.applied) {
        process.stdout.write(`  ok       ${record.filename}\n`);
      }
      for (const file of planned.value.pending) {
        process.stdout.write(`  pending  ${file.filename}\n`);
      }
      process.stdout.write(
        `${planned.value.applied.length} applied, ${planned.value.pending.length} pending.\n`,
      );
      return EXIT_OK;
    }

    let appliedCount = 0;
    const result = await migrate(client, {
      dir,
      dryRun: values["dry-run"] === true,
      onEvent: (event) => {
        switch (event.kind) {
          case "up_to_date":
            process.stdout.write("  nothing to do — already up to date.\n");
            break;
          case "would_apply":
            process.stdout.write(`  would apply  ${event.filename}\n`);
            break;
          case "applying":
            process.stdout.write(`applying ${event.filename} … `);
            break;
          case "applied":
            appliedCount += 1;
            process.stdout.write(`done (${event.migration.durationMs}ms)\n`);
            break;
        }
      },
    });

    if (!result.ok) {
      process.stdout.write("\n");
      fail(result.error);
    }

    if (appliedCount > 0) {
      process.stdout.write(`${appliedCount} applied, 0 pending.\n`);
    }
    return EXIT_OK;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
