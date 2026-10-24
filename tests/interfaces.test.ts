import { describe, expect, test } from "bun:test";
import { hasCode, roleFile, tempRepo } from "./harness.ts";
import { resolveRoles } from "../src/roles/resolve.ts";
import { checkIntegrity } from "../src/roles/integrity.ts";
import { findRepoRoot } from "../src/util/paths.ts";

describe("interface ownership", () => {
  test("two accountable owners of one interface is an error", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_interfaces: ["frontend-backend"] }));
      repo.builtin("orchestration/b.md", roleFile("b", { owns_interfaces: ["frontend-backend"] }));
      // Two accountable owners means neither can classify a breaking change,
      // which is the one decision a contract owner exists to make.
      expect(hasCode(repo.check().diagnostics, "catalogue/interface-ownership-collision")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("one owner plus participants is the correct shape", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_interfaces: ["frontend-backend"] }));
      repo.builtin("orchestration/b.md", roleFile("b", { participates_interfaces: ["frontend-backend"] }));
      repo.builtin("orchestration/c.md", roleFile("c", { participates_interfaces: ["frontend-backend"] }));
      const { registry, diagnostics } = repo.check();
      expect(diagnostics.some((d) => d.code.startsWith("catalogue/interface"))).toBe(false);

      const row = checkIntegrity(registry).interfaces.find((r) => r.interface === "frontend-backend");
      expect(row?.owner).toBe("a");
      expect(row?.participants).toEqual(["b", "c"]);
    } finally {
      repo.dispose();
    }
  });

  test("participants with no owner have nobody to escalate to", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/b.md", roleFile("b", { participates_interfaces: ["frontend-backend"] }));
      expect(hasCode(repo.check().diagnostics, "catalogue/interface-without-owner")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("owning and participating in the same interface is rejected", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        owns_interfaces: ["frontend-backend"],
        participates_interfaces: ["frontend-backend"],
      }));
      expect(hasCode(repo.check().diagnostics, "role/owns-and-participates")).toBe(true);
    } finally {
      repo.dispose();
    }
  });
});

describe("the shipped starter roster", () => {
  test("the mandatory frontend-backend boundary has one owner and both sides as participants", () => {
    // Specification 32.1: the boundary names an owner, a producer and a
    // consumer. This is the single most-cited integration failure in the
    // whole specification, so it is asserted against the real catalogue
    // rather than a fixture.
    const root = findRepoRoot(import.meta.dir)!;
    const row = checkIntegrity(resolveRoles(root)).interfaces
      .find((r) => r.interface === "frontend-backend");

    expect(row).toBeDefined();
    expect(row!.owner).toBe("api-contract-owner");
    expect(row!.participants).toContain("frontend-lead");
    expect(row!.participants).toContain("backend-lead");
  });

  test("no shipped interface is left without an accountable owner", () => {
    const root = findRepoRoot(import.meta.dir)!;
    const orphans = checkIntegrity(resolveRoles(root)).interfaces.filter((r) => r.owner === null);
    expect(orphans.map((o) => o.interface)).toEqual([]);
  });

  test("native mobile implementers own distinct implementation artifacts", () => {
    const root = findRepoRoot(import.meta.dir)!;
    const integrity = checkIntegrity(resolveRoles(root));
    const matrix = integrity.ownership;

    expect(hasCode(integrity.diagnostics.items, "catalogue/ownership-collision")).toBe(false);
    expect(matrix.find((row) => row.artifact === "android-application")?.owner)
      .toBe("android-application-engineer");
    expect(matrix.find((row) => row.artifact === "ios-application")?.owner)
      .toBe("ios-application-engineer");
    expect(matrix.find((row) => row.artifact === "cross-platform-mobile-implementation")?.owner)
      .toBe("cross-platform-mobile-engineer");
  });
});
