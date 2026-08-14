import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { generateIdentityKeypair, jwksFor, type Keypair, mintIdentityToken } from "@keel/identity";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type JWK, jwtVerify } from "jose";
import { config } from "./config.js";
import { query, queryOne } from "./db.js";
import { unauthorized } from "./problem.js";

/**
 * Northwind's own authentication. Two modes, deliberately not blurred:
 *
 *   session cookie  the Northwind web UI, for a human at a browser
 *   bearer JWT      machine callers, including Keel
 *
 * The JWT is EdDSA-signed and verified against a public JWKS this service
 * publishes. That asymmetry is the point: a verifier — including Keel — can
 * check a token but cannot mint one, so a compromised control plane still
 * cannot fabricate a staff identity. A shared secret would give away exactly
 * that property.
 */

const scrypt = promisify(scryptCallback);

export type StaffRow = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "support" | "finance" | "readonly";
};

/* --------------------------------------------------------------- passwords -- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, expectedHex] = stored.split("$");
  if (scheme !== "scrypt" || saltHex === undefined || expectedHex === undefined) return false;

  const derived = (await scrypt(password, Buffer.from(saltHex, "hex"), 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and that throw would itself be an oracle.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/* ---------------------------------------------------------------- sessions -- */

export const SESSION_COOKIE = "northwind_session";

export async function createSession(staffId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionTtlHours * 3_600_000);
  await query("insert into sessions (token, staff_id, expires_at) values ($1, $2, $3)", [
    token,
    staffId,
    expires,
  ]);
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await query("delete from sessions where token = $1", [token]);
}

async function staffForSession(token: string): Promise<StaffRow | undefined> {
  return queryOne<StaffRow>(
    `select s.id, s.email, s.name, s.role
       from sessions sess
       join staff s on s.id = sess.staff_id
      where sess.token = $1 and sess.expires_at > now()`,
    [token],
  );
}

/* -------------------------------------------------------------- identity JWT -- */

/**
 * Generated per process. A real deployment would load a persisted key; for a
 * demo, an ephemeral key is *better* — it makes it impossible to accidentally
 * ship a signing key that someone treats as trustworthy.
 */
let keyPair: Keypair | null = null;
const KEY_ID = "northwind-demo-1";

async function keys(): Promise<Keypair> {
  if (keyPair === null) keyPair = await generateIdentityKeypair(KEY_ID);
  return keyPair;
}

export async function publicJwks(): Promise<{ keys: JWK[] }> {
  return jwksFor(await keys());
}

/**
 * Minted through @keel/identity rather than by hand.
 *
 * That is the point of shipping a helper: the customer's integration and the
 * platform's verifier agree by construction, so a five-minute integration stays
 * five minutes and nobody reaches for a shared secret because the correct path
 * was fiddly. The helper enforces the same 10-minute ceiling the verifier does.
 */
export async function issueIdentityToken(staff: StaffRow, audience: string): Promise<string> {
  const { token } = await mintIdentityToken(await keys(), {
    subject: staff.id,
    issuer: "https://northwind.example",
    audience,
    claims: {
      email: staff.email,
      name: staff.name,
      role: staff.role,
      // Northwind's staff roles map onto the permissions Keel's policy engine
      // reads. Sent as claims because the platform must never infer them.
      permissions:
        staff.role === "owner" || staff.role === "support"
          ? ["customers.read", "subscriptions.write"]
          : ["customers.read"],
      groups: ["kb:public"],
    },
  });
  return token;
}

async function staffForBearer(token: string): Promise<StaffRow | undefined> {
  try {
    const { publicKey } = await keys();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "https://northwind.example",
    });
    if (typeof payload.sub !== "string") return undefined;
    return queryOne<StaffRow>("select id, email, name, role from staff where id = $1", [
      payload.sub,
    ]);
  } catch {
    // A malformed or expired token is simply not authenticated. The reason is
    // not reported: distinguishing "expired" from "bad signature" tells an
    // attacker which half of their guess was right.
    return undefined;
  }
}

/* ------------------------------------------------------------------ plumbing -- */

declare module "fastify" {
  interface FastifyRequest {
    staff?: StaffRow;
  }
}

export async function authenticate(request: FastifyRequest): Promise<StaffRow | undefined> {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ") === true) {
    return staffForBearer(header.slice("Bearer ".length));
  }

  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie !== undefined) return staffForSession(cookie);

  return undefined;
}

/** Route guard. Every /api/v1 route uses it; nothing is public by default. */
export async function requireStaff(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<StaffRow | undefined> {
  const staff = await authenticate(request);
  if (staff === undefined) {
    await unauthorized(reply);
    return undefined;
  }
  request.staff = staff;
  return staff;
}

/** Mutations are not available to every role. `readonly` never writes. */
export function canMutate(staff: StaffRow): boolean {
  return staff.role === "owner" || staff.role === "support";
}
