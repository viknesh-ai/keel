import type { FastifyReply } from "fastify";

/**
 * RFC 9457 problem details. The demo app uses the same error shape the Keel API
 * does, so an agent consuming both does not need two error parsers.
 */
export type Problem = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
};

export function problem(reply: FastifyReply, status: number, title: string, detail?: string) {
  const body: Problem = {
    type: `https://northwind.example/problems/${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
  return reply.status(status).type("application/problem+json").send(body);
}

export const badRequest = (reply: FastifyReply, detail: string) =>
  problem(reply, 400, "Bad Request", detail);
export const unauthorized = (reply: FastifyReply) =>
  problem(reply, 401, "Unauthorized", "No valid session or bearer token was supplied.");
export const forbidden = (reply: FastifyReply, detail: string) =>
  problem(reply, 403, "Forbidden", detail);
export const notFound = (reply: FastifyReply, what: string) =>
  problem(reply, 404, "Not Found", `No such ${what}.`);
