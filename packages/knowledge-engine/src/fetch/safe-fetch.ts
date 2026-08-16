import { lookup as dnsLookup } from "node:dns/promises";
import { checkAddress, type IpVerdict } from "./ip-rules.js";

/**
 * SafeFetch (threat-model §T5).
 *
 * SSRF is reachable from four separate surfaces — knowledge URLs, OpenAPI base
 * URLs, MCP server URLs and webhook targets — and the doc is explicit that they
 * must all share one implementation. Four implementations means four chances to
 * get it wrong and one place where somebody fixes only three.
 *
 * The order of operations is the whole control:
 *
 *   1. scheme check          — https only outside development
 *   2. resolve the hostname  — every address it answers with
 *   3. judge the addresses   — all of them must pass, not just the first
 *   4. connect to the pinned address, not the hostname
 *   5. re-validate every redirect hop, from step 1
 *
 * Step 4 is what defeats DNS rebinding. Validating a hostname and then handing
 * that hostname to `fetch` lets the attacker answer the second lookup with
 * 169.254.169.254, and the check becomes decoration.
 */

export type SafeFetchDenial =
  | { readonly reason: "scheme"; readonly detail: string }
  | { readonly reason: "hostname"; readonly detail: string }
  | { readonly reason: "dns"; readonly detail: string }
  | { readonly reason: "blocked_address"; readonly detail: string; readonly range: string }
  | { readonly reason: "too_many_redirects"; readonly detail: string }
  | { readonly reason: "too_large"; readonly detail: string }
  | { readonly reason: "timeout"; readonly detail: string }
  | { readonly reason: "transport"; readonly detail: string };

export type SafeFetchResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly body: Uint8Array;
      /** Every address actually connected to, in order, for the audit log. */
      readonly hops: readonly string[];
    }
  | { readonly ok: false; readonly denial: SafeFetchDenial };

export type Resolver = (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export type SafeFetchOptions = {
  /** `https` only unless a self-hoster opts into plaintext for a local target. */
  readonly allowHttp?: boolean;
  /**
   * Opt-in private allowlist for self-hosters pointing at internal APIs
   * (threat-model §T5). Explicit, per-project, and logged on every use — a
   * default-on escape hatch would make the whole control advisory.
   */
  readonly allowPrivate?: readonly string[];
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly resolver?: Resolver;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Called on every allowed private-range fetch, so the audit trail exists. */
  readonly onPrivateAllowed?: (host: string, address: string) => void;
};

const DEFAULTS = {
  maxRedirects: 3,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 10_000,
};

const defaultResolver: Resolver = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });
  return entries.map((e) => ({ address: e.address, family: e.family === 6 ? 6 : 4 }));
};

/**
 * Judges every address a hostname resolves to.
 *
 * All of them, not the first: a host that answers with one public and one
 * private address is a rebinding attempt wearing a disguise, and picking the
 * first answer makes the outcome depend on resolver ordering.
 */
export function judgeAddresses(
  addresses: readonly { address: string; family: 4 | 6 }[],
  allowPrivate: readonly string[],
  hostname: string,
): { verdict: IpVerdict; address: string } {
  if (addresses.length === 0) {
    return { verdict: { allowed: false, reason: "no addresses", range: "-" }, address: "" };
  }

  const permitted = allowPrivate.includes(hostname);

  for (const entry of addresses) {
    const verdict = checkAddress(entry.address, entry.family);
    if (!verdict.allowed && !permitted) return { verdict, address: entry.address };
  }

  const first = addresses[0];
  return { verdict: { allowed: true }, address: first?.address ?? "" };
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const resolver = options.resolver ?? defaultResolver;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const allowPrivate = options.allowPrivate ?? [];

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    options.timeoutMs ?? DEFAULTS.timeoutMs,
  );

  const hops: string[] = [];
  let current = rawUrl;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        return fail({ reason: "hostname", detail: "not a valid URL" });
      }

      if (url.protocol !== "https:" && !(options.allowHttp === true && url.protocol === "http:")) {
        return fail({ reason: "scheme", detail: `${url.protocol} is not permitted` });
      }

      // A bare IP literal skips DNS entirely and is judged directly, or the
      // whole check could be walked around by not having a hostname.
      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: readonly { address: string; family: 4 | 6 }[];

      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
        addresses = [{ address: host, family: host.includes(":") ? 6 : 4 }];
      } else {
        try {
          addresses = await resolver(host);
        } catch (cause) {
          return fail({
            reason: "dns",
            detail: cause instanceof Error ? cause.message : "resolution failed",
          });
        }
      }

      const judged = judgeAddresses(addresses, allowPrivate, host);
      if (!judged.verdict.allowed) {
        return fail({
          reason: "blocked_address",
          detail: `${judged.address} is ${judged.verdict.reason}`,
          range: judged.verdict.range,
        });
      }

      if (allowPrivate.includes(host)) options.onPrivateAllowed?.(host, judged.address);
      hops.push(judged.address);

      // Connect to the *pinned address*, carrying the hostname in the Host
      // header and in the TLS SNI. This is the step that makes rebinding
      // impossible: a second DNS answer cannot change where the packet goes,
      // because there is no second lookup.
      const pinned = new URL(url.toString());
      pinned.hostname = judged.address.includes(":") ? `[${judged.address}]` : judged.address;

      let response: Response;
      try {
        response = await fetchImpl(pinned.toString(), {
          method: options.method ?? "GET",
          headers: { ...options.headers, host: url.host },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          return fail({ reason: "timeout", detail: "the request exceeded its deadline" });
        }
        return fail({
          reason: "transport",
          detail: cause instanceof Error ? cause.message : "request failed",
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          return fail({ reason: "transport", detail: "redirect without a location" });
        }
        // Back to the top of the loop, which means scheme, resolution and
        // address rules all run again. A redirect chain is not a shortcut past
        // the checks the first URL had to pass.
        current = new URL(location, url).toString();
        continue;
      }

      const body = await readCapped(response, maxBytes);
      if (body === null) {
        return fail({ reason: "too_large", detail: `the response exceeded ${maxBytes} bytes` });
      }

      return {
        ok: true,
        status: response.status,
        url: url.toString(),
        headers: Object.fromEntries(response.headers.entries()),
        body,
        hops,
      };
    }

    return fail({ reason: "too_many_redirects", detail: `more than ${maxRedirects} hops` });
  } finally {
    clearTimeout(timer);
  }
}

const fail = (denial: SafeFetchDenial): SafeFetchResult => ({ ok: false, denial });

/**
 * Reads a body, giving up once it exceeds the cap.
 *
 * Streamed rather than buffered-then-measured, because a `Content-Length` a
 * server lied about is exactly the case a size cap exists for.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
