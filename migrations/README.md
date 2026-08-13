# Migrations

Forward-only SQL. No ORM, no down-migrations, no editing a file that has been
applied anywhere.

## Naming

```
NNNN_name.sql        ^\d{4}_[a-z0-9_]+\.sql$
```

Applied in numeric order. Anything else ending in `.sql` in this directory is a
hard error, not a silent skip.

## Rules the runner enforces

| Rule | Failure |
|---|---|
| A file's checksum must match what was recorded when it was applied | `checksum_mismatch`, nothing is applied |
| A file recorded in `schema_migrations` must still exist | `applied_file_missing` |
| A pending version must sort above every applied version | `out_of_order` |
| Two files must not share a version number | `duplicate_version` |

The checksum is SHA-256 over the raw file bytes — whitespace counts. To change
applied schema, write a new migration.

`out_of_order` is the rule that stops a rebase from quietly slipping `0003` into
a database that is already at `0005`.

## Transactions

The runner wraps each file in a single transaction and writes the
`schema_migrations` row inside it, so a failed migration leaves no partial
record. **Do not put `BEGIN`/`COMMIT` in a migration file.**

Statements that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`,
`ALTER TYPE ... ADD VALUE` on older servers) are deliberately not supported.
Raise it when a migration actually needs one rather than adding an escape hatch
ahead of time.

## Writing tenant data from a migration

`0001` turns on `FORCE ROW LEVEL SECURITY`, which subjects the table owner to
row-level security as well. A migration that inserts or updates rows in a
tenant-scoped table must set the session organization first:

```sql
select set_config('keel.org_id', 'org_01J...', false);
update projects set settings = settings || '{"x": 1}' where org_id = 'org_01J...';
```

A migration that touches every org must loop, or temporarily
`alter table ... no force row level security` and restore it in the same file.

## Running

```bash
pnpm migrate                  # apply pending
pnpm migrate status           # show applied and pending, verify checksums
pnpm migrate --dry-run        # print the plan, change nothing
```

`DATABASE_URL` selects the target; `--url` overrides it. The resolved target is
always printed with the password redacted, so the compose default is never
applied invisibly.
