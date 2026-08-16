import type { IncomingMessage, ServerResponse } from "node:http";

/** The three primitives every handler in this module needs. */

export function json(res: ServerResponse, status: number, body: unknown): Written {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
  return { status, body: payload };
}

/** What was actually sent, so an idempotent replay can send it again. */
export type Written = { readonly status: number; readonly body: string };

export function problem(res: ServerResponse, status: number, detail: string): Written {
  const payload = JSON.stringify({ type: "about:blank", title: "Error", status, detail });
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(payload);
  return { status, body: payload };
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
