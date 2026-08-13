import type { FastifyInstance } from "fastify";
import {
  authenticate,
  createSession,
  destroySession,
  issueIdentityToken,
  publicJwks,
  SESSION_COOKIE,
  verifyPassword,
} from "../auth.js";
import { config } from "../config.js";
import { queryOne } from "../db.js";
import { badRequest, unauthorized } from "../problem.js";

type StaffWithHash = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "support" | "finance" | "readonly";
  password_hash: string;
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string } | undefined;
    if (typeof body?.email !== "string" || typeof body.password !== "string") {
      return badRequest(reply, "email and password are required");
    }

    const staff = await queryOne<StaffWithHash>(
      "select id, email, name, role, password_hash from staff where lower(email) = lower($1)",
      [body.email],
    );

    // Same response whether the account is unknown or the password is wrong.
    // Distinguishing them turns this endpoint into an account enumerator.
    if (staff === undefined || !(await verifyPassword(body.password, staff.password_hash))) {
      return unauthorized(reply);
    }

    const token = await createSession(staff.id);
    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: config.sessionTtlHours * 3600,
      })
      .send({ id: staff.id, email: staff.email, name: staff.name, role: staff.role });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined) return unauthorized(reply);

    // Server-side invalidation, not just clearing the cookie: a cookie the
    // client discards is still a valid credential if it leaked.
    await destroySession(token);
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).status(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const staff = await authenticate(request);
    if (staff === undefined) return unauthorized(reply);
    return reply.send(staff);
  });

  /**
   * The identity token Keel verifies. Issued only to an already-authenticated
   * staff member, bound to an audience, and short-lived.
   */
  app.post("/api/auth/identity-token", async (request, reply) => {
    const staff = await authenticate(request);
    if (staff === undefined) return unauthorized(reply);

    const body = request.body as { audience?: string } | undefined;
    const audience = body?.audience ?? "keel:northwind";
    return reply.send({ token: await issueIdentityToken(staff, audience), expires_in: 600 });
  });

  /** Public. A verifier needs this and it contains no secret. */
  app.get("/.well-known/jwks.json", async (_request, reply) => {
    return reply.send(await publicJwks());
  });
}
