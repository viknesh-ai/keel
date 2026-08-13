import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { parse } from "yaml";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { customerRoutes } from "./routes/customers.js";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "..", "openapi.yaml");

export async function build() {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  // The spec is served from the same file that is checked in, so "the API
  // serves the spec" cannot drift from "the spec in the repo".
  const specText = readFileSync(specPath, "utf8");
  const specJson = parse(specText) as unknown;

  app.get("/openapi.yaml", async (_request, reply) =>
    reply.type("application/yaml").send(specText),
  );
  app.get("/openapi.json", async (_request, reply) => reply.send(specJson));
  app.get("/health", async (_request, reply) => reply.send({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(customerRoutes);
  await app.register(billingRoutes);

  return app;
}

// Compare the resolved entry path, not this module's own URL: import.meta.url
// always ends with server.ts, so the naive check starts a listening server
// whenever anything imports build() — which hangs every script that does.
const entry = process.argv[1];
const isEntrypoint =
  entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const app = await build();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  process.stdout.write(`Northwind Cloud API on http://localhost:${config.port}\n`);
  process.stdout.write(`  spec        http://localhost:${config.port}/openapi.yaml\n`);
  process.stdout.write(`  jwks        http://localhost:${config.port}/.well-known/jwks.json\n`);
}
