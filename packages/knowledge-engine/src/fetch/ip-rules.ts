/**
 * IP-level denial for SafeFetch (threat-model §T5).
 *
 * The rule is deliberately expressed over *addresses*, not hostnames. A
 * hostname allowlist is defeated by a DNS record pointing at 169.254.169.254,
 * and a string check on the URL is defeated by `0x7f.1`, `2130706433`,
 * `[::ffff:127.0.0.1]`, or a CNAME. Only the resolved address tells the truth,
 * so resolution happens first and the decision is made on the bytes.
 *
 * Everything here is pure and total: given an address it returns a verdict, and
 * there is no branch that returns "probably fine".
 */

export type IpVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly range: string };

const ALLOW: IpVerdict = { allowed: true };

const deny = (reason: string, range: string): IpVerdict => ({ allowed: false, reason, range });

/**
 * Parses an IPv4 address into its four octets.
 *
 * Only dotted-quad decimal is accepted. `0x7f.0.0.1`, `2130706433` and
 * `0177.0.0.1` are all valid inputs to most resolvers and all mean localhost,
 * so they are rejected here rather than normalised — a parser that tries to
 * understand every encoding is a parser that will eventually understand one
 * differently from the network stack does.
 */
export function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // A leading zero is octal to some resolvers and decimal to others. Refusing
    // is the only reading that cannot disagree with the network stack.
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

export function checkIpv4(address: string): IpVerdict {
  const octets = parseIpv4(address);
  if (octets === null) return deny("not a plain dotted-quad IPv4 address", address);

  const [a = 0, b = 0] = octets;

  if (a === 0) return deny("this host / unspecified", "0.0.0.0/8");
  if (a === 127) return deny("loopback", "127.0.0.0/8");
  if (a === 10) return deny("private", "10.0.0.0/8");
  if (a === 172 && b >= 16 && b <= 31) return deny("private", "172.16.0.0/12");
  if (a === 192 && b === 168) return deny("private", "192.168.0.0/16");
  // The one that matters most in a cloud: the instance metadata endpoint.
  if (a === 169 && b === 254) return deny("link-local / cloud metadata", "169.254.0.0/16");
  if (a === 100 && b >= 64 && b <= 127) return deny("carrier-grade NAT", "100.64.0.0/10");
  if (a === 192 && b === 0) return deny("IETF protocol assignments", "192.0.0.0/24");
  if (a === 198 && (b === 18 || b === 19)) return deny("benchmarking", "198.18.0.0/15");
  if (a >= 224) return deny("multicast / reserved", "224.0.0.0/4");

  return ALLOW;
}

/** Expands an IPv6 address to its sixteen bytes, or null if unparseable. */
export function parseIpv6(value: string): readonly number[] | null {
  let text = value.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text.includes(":")) return null;

  // An IPv4-mapped tail (::ffff:127.0.0.1) is the classic bypass: it looks like
  // v6 to a naive check and routes to v4 loopback.
  let tail: readonly number[] | null = null;
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    tail = parseIpv4(maybeV4);
    if (tail === null) return null;
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;

  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;

  const groups = halves.length === 2 ? [...head, ...Array<number>(missing).fill(0), ...rest] : head;
  if (groups.length !== 8) return null;

  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail !== null) {
    bytes[12] = tail[0] ?? 0;
    bytes[13] = tail[1] ?? 0;
    bytes[14] = tail[2] ?? 0;
    bytes[15] = tail[3] ?? 0;
  }
  return bytes;
}

export function checkIpv6(address: string): IpVerdict {
  const bytes = parseIpv6(address);
  if (bytes === null) return deny("not a parseable IPv6 address", address);

  const [b0 = 0, b1 = 0] = bytes;

  // ::ffff:a.b.c.d — v4-mapped. Judged by the v4 rules, because that is where
  // the packet actually goes.
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    return checkIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  if (bytes.every((b) => b === 0)) return deny("unspecified", "::/128");
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) {
    return deny("loopback", "::1/128");
  }
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return deny("link-local", "fe80::/10");
  if ((b0 & 0xfe) === 0xfc) return deny("unique local", "fc00::/7");
  if (b0 === 0xff) return deny("multicast", "ff00::/8");
  // 64:ff9b::/96 — NAT64, which translates straight back to v4 space.
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return deny("NAT64 translation prefix", "64:ff9b::/96");
  }

  return ALLOW;
}

export function checkAddress(address: string, family: 4 | 6): IpVerdict {
  return family === 4 ? checkIpv4(address) : checkIpv6(address);
}
