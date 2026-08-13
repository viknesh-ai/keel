import { describe, expect, it } from "vitest";
import {
  atLeastAsTrustedAs,
  checkI1,
  checkI2,
  combine,
  INTEGRITY_LEVELS,
  isUntrusted,
  label,
  mapLabelled,
  meet,
} from "../src/integrity.js";

describe("meet — the propagation rule", () => {
  it("returns the least trusted input", () => {
    expect(meet("system", "external")).toBe("external");
    expect(meet("system", "developer")).toBe("developer");
    expect(meet("user", "tool")).toBe("tool");
    expect(meet("developer", "user", "system")).toBe("user");
  });

  it("taints a whole structure when any one input is external", () => {
    expect(meet("system", "developer", "user", "external")).toBe("external");
  });

  it("is system for no inputs — a constant derived from nothing is ours", () => {
    expect(meet()).toBe("system");
  });

  it("is order-independent", () => {
    expect(meet("external", "system")).toBe(meet("system", "external"));
  });

  it("is idempotent for every level", () => {
    for (const level of INTEGRITY_LEVELS) expect(meet(level, level)).toBe(level);
  });
});

describe("atLeastAsTrustedAs", () => {
  it("orders the levels as documented", () => {
    expect(atLeastAsTrustedAs("system", "external")).toBe(true);
    expect(atLeastAsTrustedAs("external", "system")).toBe(false);
    expect(atLeastAsTrustedAs("user", "user")).toBe(true);
    expect(atLeastAsTrustedAs("developer", "user")).toBe(true);
    expect(atLeastAsTrustedAs("tool", "user")).toBe(false);
  });
});

describe("combine", () => {
  it("meets integrity down and unions ACL tags", () => {
    const a = label("a", "user", ["finance"]);
    const b = label("b", "external", ["hr"]);

    const result = combine("derived", a, b);

    expect(result.integrity).toBe("external");
    expect(result.acl_tags).toEqual(["finance", "hr"]);
  });

  it("deduplicates tags", () => {
    const result = combine("x", label(1, "user", ["a"]), label(2, "user", ["a"]));

    expect(result.acl_tags).toEqual(["a"]);
  });

  it("keeps a value derived from nothing at system with no tags", () => {
    expect(combine("constant")).toEqual({ value: "constant", integrity: "system", acl_tags: [] });
  });
});

describe("mapLabelled", () => {
  it("preserves the label — transforming does not launder taint", () => {
    const tainted = label("<script>", "external", ["internal"]);

    const mapped = mapLabelled(tainted, (v) => v.toUpperCase());

    expect(mapped.value).toBe("<SCRIPT>");
    expect(mapped.integrity).toBe("external");
    expect(mapped.acl_tags).toEqual(["internal"]);
  });
});

describe("isUntrusted", () => {
  it("is true only for external", () => {
    expect(isUntrusted("external")).toBe(true);
    for (const level of ["system", "developer", "user", "tool"] as const) {
      expect(isUntrusted(level)).toBe(false);
    }
  });
});

describe("I1 — control-flow integrity", () => {
  const mutatingWithExternalArgs = {
    sideEffect: "write",
    argumentIntegrity: "external",
    acceptsUntrustedArgs: false,
    humanApproved: false,
  } as const;

  it("blocks a mutation whose arguments derive from external data", () => {
    const result = checkI1(mutatingWithExternalArgs);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invariant).toBe("I1");
  });

  it("blocks a destructive call on the same basis", () => {
    expect(checkI1({ ...mutatingWithExternalArgs, sideEffect: "destructive" }).ok).toBe(false);
  });

  it("permits a read, whatever the argument taint", () => {
    expect(checkI1({ ...mutatingWithExternalArgs, sideEffect: "read" }).ok).toBe(true);
  });

  it("permits a mutation whose arguments are user-derived", () => {
    expect(checkI1({ ...mutatingWithExternalArgs, argumentIntegrity: "user" }).ok).toBe(true);
  });

  it("permits it when the tool explicitly accepts untrusted arguments", () => {
    expect(checkI1({ ...mutatingWithExternalArgs, acceptsUntrustedArgs: true }).ok).toBe(true);
  });

  it("permits it when a human approved this specific call", () => {
    expect(checkI1({ ...mutatingWithExternalArgs, humanApproved: true }).ok).toBe(true);
  });
});

describe("I2 — data-flow confinement", () => {
  it("blocks tagged data reaching a destination that is not allowlisted", () => {
    const result = checkI2({
      aclTags: ["internal"],
      destination: "evil.example",
      egressAllowlist: ["api.northwind.example"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invariant).toBe("I2");
  });

  it("permits tagged data reaching an allowlisted destination", () => {
    expect(
      checkI2({
        aclTags: ["internal"],
        destination: "api.northwind.example",
        egressAllowlist: ["api.northwind.example"],
      }).ok,
    ).toBe(true);
  });

  it("permits untagged data anywhere", () => {
    expect(checkI2({ aclTags: [], destination: "anywhere", egressAllowlist: [] }).ok).toBe(true);
  });

  it("denies by default — an empty allowlist releases nothing tagged", () => {
    expect(
      checkI2({ aclTags: ["internal"], destination: "anywhere", egressAllowlist: [] }).ok,
    ).toBe(false);
  });
});
