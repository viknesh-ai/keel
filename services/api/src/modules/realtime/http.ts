import type { IncomingMessage, ServerResponse } from "node:http";

/** The three primitives every handler in this module needs. */

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function problem(res: ServerResponse, status: number, detail: string): void {
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(JSON.stringify({ type: "about:blank", title: "Error", status, detail }));
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
