import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { emitToolsYaml } from "../src/openapi/emit.js";
import { generateFromSpec } from "../src/openapi/generate.js";

/**
 * Generates the demo app's tool contracts and writes them into the repo, where
 * they are reviewed like code. Running this twice must produce an identical
 * file; CI asserts it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const specPath = join(root, "apps", "demo-saas", "openapi.yaml");
const outPath = join(root, "apps", "demo-saas", "keel", "tools", "northwind.yaml");

const result = generateFromSpec(parse(readFileSync(specPath, "utf8")));

if (!result.ok) {
  for (const issue of result.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  process.stderr.write(`\n${result.issues.length} problem(s) in the specification\n`);
  process.exit(1);
}

writeFileSync(outPath, emitToolsYaml("apps/demo-saas/openapi.yaml", result.tools), "utf8");
process.stdout.write(`wrote ${result.tools.length} operations to ${outPath}\n`);
process.stdout.write(`  enabled: ${result.tools.filter((t) => t.enabled).length}\n`);
