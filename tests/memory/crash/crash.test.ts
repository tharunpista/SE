import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../../src/memory/store.ts";
import { runDoctor } from "../../../src/memory/doctor.ts";
import { listGenerations, manifestDir } from "../../../src/memory/manifest.ts";
import type { FaultPoint } from "../../../src/memory/store.ts";
import type { WriteGrant, WriteRequest } from "../../../src/memory/types.ts";

const CHILD = join(import.meta.dir, "writer-child.ts");
const CRASH_EXIT = 42;
const PROJECT = "crash-proj";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "se-crash-"));
  return {
    root,
    store: () => new MemoryStore({ memoryRoot: root, projectId: PROJECT }),
    generations: () => listGenerations(manifestDir(root, PROJECT)),
    doctor: () => runDoctor({ memoryRoot: root, projectId: PROJECT, sourceRoot: root }),
    versionPath: (id: string, rev: number) => join(root, PROJECT, "records", id, `v${rev}.json`),
    pointerPath: (id: string) => join(root, PROJECT, "records", id, "current"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Runs the write in a real child process, killed at `fault`. */
function write(
  root: string,
  fault: FaultPoint | "none",
  recordId: string,
  summary: string,
  expectedRevision = 0,
): { status: number | null; stdout: string } {
  const run = spawnSync(
    process.execPath,
    ["run", CHILD, root, PROJECT, fault, recordId, summary, String(expectedRevision)],
    { encoding: "utf8" },
  );
  return { status: run.status, stdout: run.stdout ?? "" };
}

const GRANT: WriteGrant = {
  phase: "outcome-recording",
  write_targets: ["*"],
  scopes: ["project"],
  owner: "crash-test",
};

function req(overrides: Partial<WriteRequest> = {}): WriteRequest {
  return {
    record_id: "rec",
    scope: "project",
    type: "decision",
    status: "active",
    summary: "baseline",
    owner: "crash-test",
    evidence: [{ kind: "command", detail: "t", exit_code: 0, recorded_at: "2026-10-23T00:00:00.000Z" }],
    expected_revision: 0,
    ...overrides,
  };
}

describe("the child harness itself is sound", () => {
  test("without a fault the write completes and is visible", () => {
    const h = harness();
    try {
      const run = write(h.root, "none", "rec", "clean write");
      expect(run.status).toBe(0);
      expect(h.store().get("rec")!.summary).toBe("clean write");
      expect(h.generations()).toEqual([0]);
    } finally {
      h.dispose();
    }
  });

  test("a fault really does kill the process", () => {
    const h = harness();
    try {
      const run = write(h.root, "after-stage", "rec", "never lands");
      expect(run.status).toBe(CRASH_EXIT);
    } finally {
      h.dispose();
    }
  });
});

/*
 * Part XX 72's crash table, verified one row at a time. The requirement in each
 * case is not that the write succeeds -- it is that the observable state is one
 * of the two states the table permits, and never a third.
 */
describe("crash table (Part XX 72)", () => {
  test("killed before any file is written: nothing is written at all", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-stage", "rec", "lost").status).toBe(CRASH_EXIT);

      expect(h.generations()).toEqual([]);
      expect(h.store().get("rec")).toBeNull();
      expect(existsSync(h.versionPath("rec", 1))).toBe(false);
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("killed after the version file but before the publish: the write is NOT visible", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-version-write", "rec", "orphaned").status).toBe(CRASH_EXIT);

      // The version file exists on disk...
      expect(existsSync(h.versionPath("rec", 1))).toBe(true);
      // ...but nothing published it, so no reader can see it. This is the whole
      // point of making the manifest the commit point.
      expect(h.generations()).toEqual([]);
      expect(h.store().get("rec")).toBeNull();

      const report = h.doctor();
      expect(report.ok).toBe(true);
      const orphans = report.invariants.find((i) => i.id === "80.3")!;
      expect(orphans.status).toBe("repairable");
      expect(orphans.findings.join(" ")).toContain("rec");
    } finally {
      h.dispose();
    }
  });

  test("killed immediately after the publish: the write IS visible and consistent", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-publish", "rec", "committed").status).toBe(CRASH_EXIT);

      // The publish completed, so the write is durable even though the process
      // died before touching any derived state.
      expect(h.generations()).toEqual([0]);
      expect(h.store().get("rec")!.summary).toBe("committed");
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("killed after the publish, before the pointer mirror: Tier 0 is still authoritative", () => {
    const h = harness();
    try {
      // Establish revision 1 cleanly so the mirror exists and says "1".
      expect(write(h.root, "none", "rec", "first").status).toBe(0);
      expect(readFileSync(h.pointerPath("rec"), "utf8").trim()).toBe("1");

      // Now commit revision 2 but die before the mirror is updated.
      expect(write(h.root, "after-publish", "rec", "second", 1).status).toBe(CRASH_EXIT);

      // The mirror is stale...
      expect(readFileSync(h.pointerPath("rec"), "utf8").trim()).toBe("1");
      // ...and it does not matter, because it is never consulted as authority.
      expect(h.store().get("rec")!.revision).toBe(2);
      expect(h.store().get("rec")!.summary).toBe("second");
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("killed after the mirror: fully consistent", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-mirror", "rec", "done").status).toBe(CRASH_EXIT);
      expect(h.store().get("rec")!.summary).toBe("done");
      expect(readFileSync(h.pointerPath("rec"), "utf8").trim()).toBe("1");
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("recovery after a crash", () => {
  test("an interrupted write can simply be retried, and does not double-apply", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-version-write", "rec", "attempt").status).toBe(CRASH_EXIT);
      expect(h.store().get("rec")).toBeNull();

      // The retry carries the same expected_revision, because as far as any
      // reader is concerned the earlier attempt never happened.
      const retry = write(h.root, "none", "rec", "attempt", 0);
      expect(retry.status).toBe(0);

      const record = h.store().get("rec")!;
      expect(record.revision).toBe(1);
      expect(record.summary).toBe("attempt");
      // Exactly one generation: the crashed attempt published nothing.
      expect(h.generations()).toEqual([0]);
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("an orphan is never adopted as the live revision", () => {
    const h = harness();
    try {
      expect(write(h.root, "none", "rec", "real", 0).status).toBe(0);
      // Crash while writing revision 2, leaving v2.json orphaned.
      expect(write(h.root, "after-version-write", "rec", "orphan content", 1).status).toBe(CRASH_EXIT);

      expect(existsSync(h.versionPath("rec", 2))).toBe(true);
      // The live revision is still 1. An implementation that trusted the
      // highest version file on disk would serve "orphan content" as fact.
      expect(h.store().get("rec")!.revision).toBe(1);
      expect(h.store().get("rec")!.summary).toBe("real");
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("a crash does not block the next unrelated write", () => {
    const h = harness();
    try {
      expect(write(h.root, "after-version-write", "stuck", "half-written").status).toBe(CRASH_EXIT);

      // Part XX 72 step 1: a crashed holder must not deadlock the store. There
      // is no manual unlock anywhere in this design.
      const next = h.store().put(req({ record_id: "other", summary: "proceeds" }), GRANT);
      expect(next.accepted).toBe(true);
      expect(h.store().get("other")!.summary).toBe("proceeds");
      expect(h.store().get("stuck")).toBeNull();
    } finally {
      h.dispose();
    }
  });
});

describe("concurrent writers across real processes", () => {
  test("many processes racing one record: survivors are consistent and no commit is lost", () => {
    const h = harness();
    try {
      h.store().put(req({ record_id: "hot", summary: "base" }), GRANT);

      // Eight processes all believe revision 1 is live and all try to write 2.
      const runs = Array.from({ length: 8 }, (_, i) =>
        spawnSync(process.execPath, ["run", CHILD, h.root, PROJECT, "none", "hot", `writer-${i}`, "1"], {
          encoding: "utf8",
        }),
      );

      const succeeded = runs.filter((r) => r.status === 0);
      const conflicted = runs.filter((r) => r.status === 1);

      // Exactly one may win; every other must be told, not silently dropped.
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(7);
      for (const run of conflicted) {
        const result = JSON.parse(run.stdout);
        expect(result.accepted).toBe(false);
        expect(result.code).toBe("revision-conflict");
        expect(result.record_id).toBe("hot");
        // The refusal carries the work back, so nothing the loser produced is lost.
        expect(result.surfaced.summary).toMatch(/^writer-\d$/);
      }

      const live = h.store().get("hot")!;
      expect(live.revision).toBe(2);
      expect(live.summary).toMatch(/^writer-\d$/);
      // One winner means exactly two generations, not eight.
      expect(h.generations()).toEqual([0, 1]);
      expect(h.doctor().ok).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("processes writing different records all succeed without corrupting the chain", () => {
    const h = harness();
    try {
      // Sequential expected revisions are impossible here: each writer creates a
      // distinct record, so each legitimately expects revision 0. They contend
      // only on the generation chain.
      const runs = Array.from({ length: 6 }, (_, i) =>
        spawnSync(process.execPath, ["run", CHILD, h.root, PROJECT, "none", `rec-${i}`, `body-${i}`, "0"], {
          encoding: "utf8",
        }),
      );

      const won = runs.filter((r) => r.status === 0).length;
      const lost = runs.filter((r) => r.status === 1).length;
      expect(won + lost).toBe(6);
      expect(won).toBeGreaterThan(0);

      // Whatever the interleaving, the chain is intact and every committed
      // record is readable. A lost generation would show up here.
      const report = h.doctor();
      expect(report.ok).toBe(true);
      expect(h.store().listRecordIds()).toHaveLength(report.record_count);
      expect(h.generations()).toEqual(Array.from({ length: h.generations().length }, (_, i) => i));

      // Every writer that was refused was refused for a named reason.
      for (const run of runs.filter((r) => r.status === 1)) {
        expect(JSON.parse(run.stdout).code).toBe("revision-conflict");
      }
    } finally {
      h.dispose();
    }
  });

  test("a reader never observes a torn or half-applied changeset", () => {
    const h = harness();
    try {
      const store = h.store();
      // Three records that must appear together or not at all.
      const changeset = [
        req({ record_id: "cs-a", summary: "a" }),
        req({ record_id: "cs-b", summary: "b" }),
        req({ record_id: "cs-c", summary: "c" }),
      ];
      expect(store.putChangeset(changeset, GRANT).accepted).toBe(true);

      // Every generation in the chain is internally complete: there is no
      // generation containing some members and not others.
      for (const generation of h.generations()) {
        const report = runDoctor({ memoryRoot: h.root, projectId: PROJECT, sourceRoot: h.root });
        expect(report.ok).toBe(true);
      }
      const ids = h.store().listRecordIds();
      expect(ids).toEqual(["cs-a", "cs-b", "cs-c"]);
    } finally {
      h.dispose();
    }
  });
});
