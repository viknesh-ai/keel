import { describe, expect, it, vi } from "vitest";
import { checkIpv4, checkIpv6, parseIpv4, parseIpv6 } from "../src/fetch/ip-rules.js";
import { type Resolver, safeFetch } from "../src/fetch/safe-fetch.js";

/**
 * The SSRF corpus from threat-model §T5.
 *
 * Every entry here is a real bypass that has worked against real systems. The
 * point of writing them down as tests is that the ones which look absurd —
 * `http://2130706433/`, `http://[::ffff:169.254.169.254]/` — are precisely the
 * ones a hand-rolled check misses, because they do not look like the thing they
 * resolve to.
 *
 * The prize behind all of them is the same: 169.254.169.254, the cloud
 * instance-metadata endpoint, which hands out credentials to anyone who asks
 * from inside the machine.
 */

/** A resolver that answers with whatever the test wants, so no DNS is used. */
const resolving =
  (map: Record<string, { address: string; family: 4 | 6 }[]>): Resolver =>
  async (hostname) => {
    const answer = map[hostname];
    if (answer === undefined) throw new Error(`no such host: ${hostname}`);
    return answer;
  };

const neverCalled = () => {
  throw new Error("fetch must not be reached for a denied address");
};

const denialOf = async (url: string, over: Parameters<typeof safeFetch>[1] = {}) => {
  const result = await safeFetch(url, { fetchImpl: neverCalled as never, ...over });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a denial");
  return result.denial;
};

describe("the scheme is checked first", () => {
  it("refuses http by default", async () => {
    expect((await denialOf("http://example.com/")).reason).toBe("scheme");
  });

  it("refuses file://, which is not a network fetch at all", async () => {
    expect((await denialOf("file:///etc/passwd")).reason).toBe("scheme");
  });

  it("refuses gopher://, the classic protocol-smuggling vector", async () => {
    expect((await denialOf("gopher://127.0.0.1:6379/_FLUSHALL")).reason).toBe("scheme");
  });
});

describe("literal addresses in the URL", () => {
  const cases: readonly [string, string][] = [
    ["https://127.0.0.1/", "loopback"],
    ["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["https://10.0.0.1/", "private"],
    ["https://172.16.0.1/", "private"],
    ["https://192.168.1.1/", "private"],
    ["https://100.64.0.1/", "CGNAT"],
    ["https://0.0.0.0/", "this host"],
    ["https://[::1]/", "v6 loopback"],
    ["https://[fe80::1]/", "v6 link-local"],
    ["https://[fc00::1]/", "v6 unique local"],
    ["https://[::ffff:169.254.169.254]/", "v4-mapped metadata"],
    ["https://[64:ff9b::a9fe:a9fe]/", "NAT64 to metadata"],
  ];

  for (const [url, what] of cases) {
    it(`refuses ${what} — ${url}`, async () => {
      expect((await denialOf(url)).reason).toBe("blocked_address");
    });
  }
});

describe("alternative encodings of 127.0.0.1", () => {
  // Every one of these reaches loopback through some resolver or another. A
  // parser that tries to understand them all will eventually understand one
  // differently from the network stack, so they are refused instead.
  const encodings = [
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "127.1",
    "0x7f.0.0.1",
    "127.000.000.001",
  ];

  for (const host of encodings) {
    it(`refuses https://${host}/`, async () => {
      const denial = await denialOf(`https://${host}/`, {
        resolver: resolving({ [host]: [{ address: "127.0.0.1", family: 4 }] }),
      });
      expect(denial.reason).toBe("blocked_address");
    });
  }

  it("parses only plain dotted-quad decimal", () => {
    expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.0.0.1")).toBeNull();
    expect(parseIpv4("2130706433")).toBeNull();
    expect(parseIpv4("999.1.1.1")).toBeNull();
  });
});

describe("DNS-based attacks", () => {
  it("refuses a hostname that resolves to metadata", async () => {
    // The straightforward version: an attacker's domain with an A record
    // pointing inside the network. Nothing about the URL looks wrong.
    const denial = await denialOf("https://totally-normal.example/", {
      resolver: resolving({
        "totally-normal.example": [{ address: "169.254.169.254", family: 4 }],
      }),
    });

    expect(denial.reason).toBe("blocked_address");
    expect(denial).toMatchObject({ range: "169.254.0.0/16" });
  });

  it("refuses when ANY answer is private, not just the first", async () => {
    // A host answering with one public and one private address is a rebinding
    // attempt wearing a disguise. Judging only the first answer makes the
    // outcome depend on resolver ordering.
    const denial = await denialOf("https://mixed.example/", {
      resolver: resolving({
        "mixed.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    });

    expect(denial.reason).toBe("blocked_address");
  });

  it("connects to the resolved address, not the hostname — defeating rebinding", async () => {
    // The property that makes the check real. If the hostname were handed to
    // fetch, a second lookup could answer 169.254.169.254 and every check above
    // would have been decoration.
    let connectedTo = "";
    let lookups = 0;

    const result = await safeFetch("https://rebind.example/data", {
      resolver: async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 }];
      },
      fetchImpl: (async (url: string) => {
        connectedTo = new URL(url).hostname;
        return new Response("{}", { status: 200 });
      }) as never,
    });

    expect(result.ok).toBe(true);
    expect(connectedTo).toBe("93.184.216.34");
    // Exactly one lookup: a second would be a second chance to lie.
    expect(lookups).toBe(1);
  });

  it("preserves the Host header so virtual hosting still works", async () => {
    // Pinning the address must not break the ordinary case, or nobody will use
    // the safe path.
    let sentHost: string | undefined;

    await safeFetch("https://docs.example/guide", {
      resolver: resolving({ "docs.example": [{ address: "93.184.216.34", family: 4 }] }),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentHost = (init.headers as Record<string, string>).host;
        return new Response("ok", { status: 200 });
      }) as never,
    });

    expect(sentHost).toBe("docs.example");
  });
});

describe("redirect chains", () => {
  it("re-validates every hop, so a redirect cannot reach metadata", async () => {
    // The most common real-world bypass: a perfectly innocent first URL that
    // 302s straight to the metadata endpoint.
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).hostname === "93.184.216.34") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error("must never connect to the second hop");
    });

    const result = await safeFetch("https://innocent.example/start", {
      resolver: resolving({ "innocent.example": [{ address: "93.184.216.34", family: 4 }] }),
      fetchImpl: fetchImpl as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("blocked_address");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps the chain rather than following it forever", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 302, headers: { location: "https://loop.example/" } });

    const result = await safeFetch("https://loop.example/", {
      resolver: resolving({ "loop.example": [{ address: "93.184.216.34", family: 4 }] }),
      fetchImpl: fetchImpl as never,
      maxRedirects: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("too_many_redirects");
  });

  it("refuses a redirect that downgrades to http", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 301, headers: { location: "http://elsewhere.example/" } });

    const result = await safeFetch("https://start.example/", {
      resolver: resolving({ "start.example": [{ address: "93.184.216.34", family: 4 }] }),
      fetchImpl: fetchImpl as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("scheme");
  });
});

describe("size and time caps", () => {
  it("gives up on a body larger than the cap, without buffering it all", async () => {
    // Streamed rather than buffered-then-measured, because a Content-Length the
    // server lied about is exactly what a size cap is for.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });

    const result = await safeFetch("https://big.example/", {
      resolver: resolving({ "big.example": [{ address: "93.184.216.34", family: 4 }] }),
      fetchImpl: (async () => new Response(body)) as never,
      maxBytes: 2048,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("too_large");
  });

  it("aborts a request that outlives its deadline", async () => {
    const result = await safeFetch("https://slow.example/", {
      resolver: resolving({ "slow.example": [{ address: "93.184.216.34", family: 4 }] }),
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial.reason).toBe("timeout");
  });
});

describe("the private allowlist is opt-in and audited", () => {
  it("still refuses a private address when the host is not on the list", async () => {
    const denial = await denialOf("https://internal.corp/", {
      resolver: resolving({ "internal.corp": [{ address: "10.1.2.3", family: 4 }] }),
      allowPrivate: ["other.corp"],
    });

    expect(denial.reason).toBe("blocked_address");
  });

  it("permits a listed host and records every use", async () => {
    // A self-hoster pointing at an internal API is a real need. Silence about
    // it is not: the exception is the thing an auditor will ask about.
    const audited: string[] = [];

    const result = await safeFetch("https://internal.corp/api", {
      resolver: resolving({ "internal.corp": [{ address: "10.1.2.3", family: 4 }] }),
      allowPrivate: ["internal.corp"],
      onPrivateAllowed: (host, address) => audited.push(`${host} -> ${address}`),
      fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
    });

    expect(result.ok).toBe(true);
    expect(audited).toEqual(["internal.corp -> 10.1.2.3"]);
  });
});

describe("the address rules themselves", () => {
  it("allows ordinary public addresses", () => {
    expect(checkIpv4("93.184.216.34").allowed).toBe(true);
    expect(checkIpv4("8.8.8.8").allowed).toBe(true);
    expect(checkIpv6("2606:2800:220:1:248:1893:25c8:1946").allowed).toBe(true);
  });

  it("expands compressed IPv6 correctly", () => {
    expect(parseIpv6("::1")?.slice(-2)).toEqual([0, 1]);
    expect(parseIpv6("fe80::1")?.[0]).toBe(0xfe);
    expect(parseIpv6("not:an:address")).toBeNull();
  });

  it("judges a v4-mapped v6 address by the v4 rules", () => {
    // Because that is where the packet actually goes.
    expect(checkIpv6("::ffff:127.0.0.1").allowed).toBe(false);
    expect(checkIpv6("::ffff:93.184.216.34").allowed).toBe(true);
  });
});
