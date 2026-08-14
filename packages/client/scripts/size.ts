import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/**
 * Bundle budget (doc 05 §E6): @keel/client plus the widget core stays under
 * 45 KB gzipped.
 *
 * Both halves are measured, because the budget the doc states is for what the
 * customer's page actually downloads. Measuring only the transport would let
 * the widget grow without limit while the number in CI stayed reassuring.
 *
 * React itself is external: the host page brings it, and charging the widget
 * for a dependency the customer already ships would make the number meaningless
 * in the other direction.
 *
 * Checked now, while it is easy to stay under. Widget weight is a tax on the
 * customer's Core Web Vitals and it is the first thing a serious frontend team
 * measures, so discovering the budget was blown after the widget ships means
 * rewriting rather than trimming.
 */
const BUDGET_BYTES = 45 * 1024;

async function measure(entry: string, external: readonly string[]): Promise<number> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: [...external],
    write: false,
  });

  const output = result.outputFiles[0];
  if (output === undefined) {
    process.stderr.write(`error: ${entry} produced no output\n`);
    process.exit(1);
  }

  return gzipSync(output.contents).byteLength;
}

const client = await measure("src/index.ts", []);
// The widget bundles @keel/client with it, so the pair is measured together
// rather than added up — counting the shared transport twice would report a
// number the browser never downloads.
const widget = await measure("../react/src/index.ts", ["react", "react-dom", "react/jsx-runtime"]);

const percent = ((widget / BUDGET_BYTES) * 100).toFixed(1);

process.stdout.write(`@keel/client:        ${client} B gzipped\n`);
process.stdout.write(
  `client + widget:     ${widget} B gzipped (${percent}% of the ${BUDGET_BYTES} B budget)\n`,
);

if (widget > BUDGET_BYTES) {
  process.stderr.write(
    `error: bundle exceeds the ${BUDGET_BYTES} B budget by ${widget - BUDGET_BYTES} B\n`,
  );
  process.exit(1);
}
