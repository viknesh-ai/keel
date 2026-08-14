import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/**
 * Bundle budget (doc 05 §E6): @keel/client plus the widget core stays under
 * 45 KB gzipped.
 *
 * Checked now, while it is easy to stay under. Widget weight is a tax on the
 * customer's Core Web Vitals and it is the first thing a serious frontend team
 * measures, so discovering the budget was blown after the widget ships means
 * rewriting rather than trimming.
 */
const BUDGET_BYTES = 45 * 1024;

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});

const output = result.outputFiles[0];
if (output === undefined) {
  process.stderr.write("error: bundle produced no output\n");
  process.exit(1);
}

const gzipped = gzipSync(output.contents).byteLength;
const percent = ((gzipped / BUDGET_BYTES) * 100).toFixed(1);

process.stdout.write(
  `@keel/client: ${gzipped} B gzipped (${percent}% of the ${BUDGET_BYTES} B budget)\n`,
);

if (gzipped > BUDGET_BYTES) {
  process.stderr.write(
    `error: bundle exceeds the ${BUDGET_BYTES} B budget by ${gzipped - BUDGET_BYTES} B\n`,
  );
  process.exit(1);
}
