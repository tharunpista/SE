import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAIMS_FILE,
  describeClaim,
  readClaims,
  recordClaim,
  type RecordClaimOptions,
} from "../../src/memory/namespace.ts";

function roots(): { memoryRoot: string; dispose: () => void } {
  const memoryRoot = mkdtempSync(join(tmpdir(), "se-ns-"));
  return { memoryRoot, dispose: () => rmSync(memoryRoot, { recursive: true, force: true }) };
}

/**
 * `remote` is always passed explicitly so a test never shells out to git, and
 * so the test's own checkout cannot change its result.
 */
function claim(
  memoryRoot: string,
  repoRoot: string,
  overrides: Partial<RecordClaimOptions> = {},
): ReturnType<typeof recordClaim> {
  return recordClaim({
    memoryRoot,
    projectId: "app",
    repoRoot,
    identitySource: "package-name",
    origin: "package.json#name",
    remote: undefined,
    ...overrides,
  });
}

describe("recording who uses a namespace", () => {
  test("the first directory to claim a namespace is new, not shared", () => {
    const { memoryRoot, dispose } = roots();
    try {
      const report = claim(memoryRoot, "/w/projA");
      expect(report.status).toBe("new");
      expect(report.others).toEqual([]);
    } finally {
      dispose();
    }
  });

  test("the same directory claiming again is known, and does not duplicate itself", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA");
      const report = claim(memoryRoot, "/w/projA");
      expect(report.status).toBe("known");
      expect(readClaims(memoryRoot, "app")?.claims).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test("first_seen survives a later claim; last_seen advances", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA", { now: () => new Date("2026-01-01T00:00:00.000Z") });
      claim(memoryRoot, "/w/projA", { now: () => new Date("2026-06-01T00:00:00.000Z") });
      const stored = readClaims(memoryRoot, "app")?.claims[0];
      expect(stored?.first_seen).toBe("2026-01-01T00:00:00.000Z");
      expect(stored?.last_seen).toBe("2026-06-01T00:00:00.000Z");
    } finally {
      dispose();
    }
  });
});

/*
 * The case the ledger exists for. Identity resolution already stops a rename
 * from orphaning memory; nothing stopped two unrelated projects agreeing on a
 * package name and then sharing one store, which is the direction that reads
 * another project's decisions as if they were this project's.
 */
describe("two unrelated projects agreeing on an id", () => {
  test("a second directory with a name-derived id and no remote is ambiguous", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA");
      const report = claim(memoryRoot, "/w/projB");
      expect(report.status).toBe("ambiguous");
      expect(report.others.map((o) => o.path)).toEqual(["/w/projA"]);
    } finally {
      dispose();
    }
  });

  test("an ambiguous report names both directories and the command that fixes it", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA");
      const lines = describeClaim(claim(memoryRoot, "/w/projB"), "/w/projB").join("\n");
      expect(lines).toContain("/w/projA");
      expect(lines).toContain("/w/projB");
      expect(lines).toContain("se memory init --id");
    } finally {
      dispose();
    }
  });

  test("a report that is not ambiguous says nothing at all", () => {
    const { memoryRoot, dispose } = roots();
    try {
      expect(describeClaim(claim(memoryRoot, "/w/projA"), "/w/projA")).toEqual([]);
    } finally {
      dispose();
    }
  });
});

/*
 * The warning has to stay quiet for the legitimate shapes, or it becomes noise
 * that gets ignored on the one occasion it matters.
 */
describe("deliberate sharing is not a collision", () => {
  test("two checkouts of one repository share a namespace legitimately", () => {
    const { memoryRoot, dispose } = roots();
    try {
      const remote = "git@github.com:acme/shop.git";
      claim(memoryRoot, "/w/clone-1", { identitySource: "git-remote", remote });
      const report = claim(memoryRoot, "/w/clone-2", { identitySource: "git-remote", remote });
      expect(report.status).toBe("shared");
    } finally {
      dispose();
    }
  });

  test("clones with different remotes are still ambiguous", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/a", { identitySource: "git-remote", remote: "git@h:one/app.git" });
      const report = claim(memoryRoot, "/w/b", {
        identitySource: "git-remote",
        remote: "git@h:two/app.git",
      });
      expect(report.status).toBe("ambiguous");
    } finally {
      dispose();
    }
  });

  test("a committed id is a stated intention, so sharing it is deliberate", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/a", { identitySource: "config" });
      expect(claim(memoryRoot, "/w/b", { identitySource: "config" }).status).toBe("shared");
    } finally {
      dispose();
    }
  });

  test("an operator naming the project with --project is believed", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/a");
      expect(claim(memoryRoot, "/w/b", { identitySource: "flag" }).status).toBe("shared");
    } finally {
      dispose();
    }
  });
});

describe("the ledger never breaks a memory operation", () => {
  test("a corrupt ledger reads as absent rather than throwing", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA");
      writeFileSync(join(memoryRoot, "app", CLAIMS_FILE), "{ not json", "utf8");
      expect(readClaims(memoryRoot, "app")).toBeNull();
      // And a subsequent claim still classifies, treating the namespace as new.
      expect(claim(memoryRoot, "/w/projB").status).toBe("new");
    } finally {
      dispose();
    }
  });

  test("persist: false classifies without writing anything", () => {
    const { memoryRoot, dispose } = roots();
    try {
      const report = claim(memoryRoot, "/w/projA", { persist: false });
      expect(report.status).toBe("new");
      expect(readClaims(memoryRoot, "app")).toBeNull();
    } finally {
      dispose();
    }
  });

  test("the ledger is stored sorted and human-readable, like the rest of Tier 0", () => {
    const { memoryRoot, dispose } = roots();
    try {
      claim(memoryRoot, "/w/projA");
      const raw = readFileSync(join(memoryRoot, "app", CLAIMS_FILE), "utf8");
      expect(raw).toContain('"schema_version": 1');
      expect(raw.endsWith("\n")).toBe(true);
    } finally {
      dispose();
    }
  });
});
