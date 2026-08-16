import { keelFastifyVerifier } from "@keel/node";
import type { FastifyInstance } from "fastify";

/**
 * Northwind's integration with Keel's action tokens.
 *
 * This is the whole thing. Doc 02 §2.1 sets an adoption budget of 40 lines of
 * user-facing code, because a fiddly integration is one people skip in favour of
 * a shared service key — and the service key is the vulnerability the design
 * exists to remove.
 *
 * What Northwind gets in return: a request carrying this token is provably on
 * behalf of the user in the Keel-Identity header, for this exact operation, with
 * these exact arguments, once.
 */
const KEEL_JWKS_URL = process.env.KEEL_JWKS_URL ?? "http://localhost:3001/.well-known/jwks.json";
const AUDIENCE = process.env.NORTHWIND_AUDIENCE ?? "https://api.northwind.example";

export async function registerKeelVerifier(app: FastifyInstance): Promise<void> {
  const jwks = (await (await fetch(KEEL_JWKS_URL)).json()) as { keys: never[] };
  const verify = keelFastifyVerifier({ jwks, audience: AUDIENCE });

  // Agent-initiated mutations only. A staff member using the web UI is
  // authenticated by their session; this guards the path the agent takes.
  app.addHook("preHandler", async (request, reply) => {
    if (request.headers["keel-identity"] === undefined) return;
    await verify(request as never, reply as never);
  });
}
