import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitTokensCss } from "../src/emit-css.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tokens.css");
writeFileSync(out, emitTokensCss(), "utf8");
process.stdout.write(`wrote ${out}\n`);
