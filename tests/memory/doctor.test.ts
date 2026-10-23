import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store.ts";
import { formatDoctorReport, runDoctor, type DoctorReport } from "../../src/memory/doctor.ts";
import { canonicalJson, generationPath, hashContent, manifestDir } from "../../src/memory/manifest.ts";
import type { WriteGrant, WriteRequest } from "../../src/memory/types.ts";

const PROJECT = "doc-proj";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "se-doctor-"));
  return {
    root,
    store: new MemoryStore({ memoryRoot: root, projectId: PROJECT }),
    doctor: (): DoctorReport => runDoctor({ memoryRoot: root, projectId: PROJECT, sourceRoot: root }),
    manifestPath: (generation: number) => generationPath(manifestDir(root, PROJECT), generation),
    versionPath: (id: string, rev: number) => join(root, PROJECT, "records", id, `v${rev}.json`),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const GRANT: WriteGrant = {
  phase: "outcome-recording",
  write_targets: ["*"],
  scopes: ["project"],
  owner: "doctor-test",
};

function req(overrides: Partial<WriteRequest> = {}): WriteRequest {
  return {
    record_id: "rec",
    scope: "project",
    type: "decision",
    status: "active",
    summary: "a decision",
    owner: "doctor-test",
    evidence: [{ kind: "command", detail: "t", exit_code: 0, recorded_at: "2026-10-23T00:00:00.000Z" }],
    expected_revision: 0,
    ...overrides,
  };
}

function invariant(report: DoctorReport, id: string) {
  const found = report.invariants.find((i) => i.id === id);
  if (!found) throw new Error(`no invariant ${id} in report`);
  return found;
}

describe("a healthy store", () => {
  test("an empty project passes every implemented invariant", () => {
    const h = harness();
    try {
      const report = h.doctor();
      expect(report.ok).toBe(true);
      expect(report.generation).toBe(-1);
      expect(report.record_count).toBe(0);
      expect(report.invariants.filter((i) => i.status === "fail")).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  test("a populated project passes", () => {
    const h = harness();
    try {
      h.store.put(req({ record_id: "a" }), GRANT);
      h.store.put(req({ record_id: "b" }), GRANT);
      h.store.put(req({ record_id: "a", summary: "revised", expected_revision: 1 }), GRANT);

      const report = h.doctor();
      expect(report.ok).toBe(true);
      expect(report.record_count).toBe(2);
      expect(report.generation).toBe(2);
    } finally {
      h.dispose();
    }
  });
});

describe("unchecked invariants are never reported as passing", () => {
  test("the three invariants with no implementation report not-implemented", () => {
    const h = harness();
    try {
      const report = h.doctor();
      for (const id of ["80.5", "80.6", "80.10"]) {
        const result = invariant(report, id);
        expect(result.status).toBe("not-implemented");
        expect(result.blocked_on).toBeTruthy();
      }
      expect(report.incomplete).toBe(3);
    } finally {
      h.dispose();
    }
  });

  test("the report says so in words, so a reader cannot mistake it for a clean bill", () => {
    const h = harness();
    try {
      const text = formatDoctorReport(h.doctor());
      expect(text).toContain("not checked");
      expect(text).toContain("never as passing");
    } finally {
      h.dispose();
    }
  });

  test("an unchecked invariant does not make the build fail", () => {
    const h = harness();
    try {
      // Gaps must be visible without being fatal, or the gate gets disabled.
      expect(h.doctor().ok).toBe(true);
      expect(h.doctor().incomplete).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });
});

/*
 * Each of these plants damage directly in Tier 0 -- bypassing the write path
 * entirely -- because the write path is what makes these states unreachable.
 * The doctor exists for the cases where something else produced them: an older
 * version, a bad merge, a hand edit, or a genuine bug.
 */
describe("planted corruption is caught", () => {
  test("a missing version file fails invariant 1", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      unlinkSync(h.versionPath("rec", 1));

      const report = h.doctor();
      expect(report.ok).toBe(false);
      const check = invariant(report, "80.1");
      expect(check.status).toBe("fail");
      expect(check.findings.join(" ")).toContain("missing");
    } finally {
      h.dispose();
    }
  });

  test("a version file edited in place fails invariant 1 via its hash", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);

      // Part XX 71: a published version is immutable. Rewriting history in place
      // is the single most dangerous thing anyone can do to this store, and the
      // manifest carries the hash precisely so it cannot pass unnoticed.
      const path = h.versionPath("rec", 1);
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.summary = "silently rewritten";
      writeFileSync(path, canonicalJson(record), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.1").findings.join(" ")).toContain("hash differs");
    } finally {
      h.dispose();
    }
  });

  test("a status disagreement between manifest and record fails invariant 1", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      const manifestFile = h.manifestPath(0);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.entries.rec.status = "archived";
      writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      const findings = invariant(report, "80.1").findings.join(" ");
      expect(findings).toMatch(/archived|hash differs/);
    } finally {
      h.dispose();
    }
  });

  test("a gap in record revisions fails invariant 2", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      h.store.put(req({ summary: "second", expected_revision: 1 }), GRANT);
      unlinkSync(h.versionPath("rec", 1));

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.2").findings.join(" ")).toContain("gapless");
    } finally {
      h.dispose();
    }
  });

  test("a supersession pointing at a nonexistent record fails invariant 4", () => {
    const h = harness();
    try {
      h.store.put(req({ record_id: "old" }), GRANT);
      h.store.put(req({ record_id: "new" }), GRANT);
      h.store.put(
        req({ record_id: "old", status: "superseded", superseded_by: "new", expected_revision: 1 }),
        GRANT,
      );
      expect(h.doctor().ok).toBe(true);

      // Remove the successor from the manifest, as a bad merge might.
      const manifestFile = h.manifestPath(h.doctor().generation);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      delete manifest.entries.new;
      writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.4").findings.join(" ")).toContain("does not exist");
    } finally {
      h.dispose();
    }
  });

  test("a supersession cycle planted in Tier 0 is caught by invariant 4", () => {
    const h = harness();
    try {
      h.store.put(req({ record_id: "a" }), GRANT);
      h.store.put(req({ record_id: "b" }), GRANT);
      h.store.put(req({ record_id: "a", status: "superseded", superseded_by: "b", expected_revision: 1 }), GRANT);

      // The write path forbids this (b's successor would not be active), so the
      // cycle has to be planted to prove the diagnostic catches it at all.
      const generation = h.doctor().generation;
      const manifestFile = h.manifestPath(generation);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.entries.b.status = "superseded";
      writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");

      const bPath = h.versionPath("b", 1);
      const bRecord = JSON.parse(readFileSync(bPath, "utf8"));
      bRecord.status = "superseded";
      bRecord.superseded_by = "a";
      writeFileSync(bPath, canonicalJson(bRecord), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      const findings = invariant(report, "80.4").findings.join(" ");
      expect(findings).toContain("cycle");
    } finally {
      h.dispose();
    }
  });

  test("a secret planted past the write path fails invariant 7", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      const path = h.versionPath("rec", 1);
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.body = "AKIAIOSFODNN7EXAMPLE";
      writeFileSync(path, canonicalJson(record), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.7").findings.join(" ")).toContain("aws-access-key-id");
      // The finding must not echo the credential.
      expect(invariant(report, "80.7").findings.join(" ")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      h.dispose();
    }
  });

  test("a project_id that disagrees with its namespace fails invariant 9", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      const path = h.versionPath("rec", 1);
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.project_id = "someone-elses-project";
      writeFileSync(path, canonicalJson(record), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      // Cross-project leakage is the failure this guards against.
      expect(invariant(report, "80.9").findings.join(" ")).toContain("someone-elses-project");
    } finally {
      h.dispose();
    }
  });

  test("a broken parent hash in the generation chain is caught", () => {
    const h = harness();
    try {
      h.store.put(req({ record_id: "a" }), GRANT);
      h.store.put(req({ record_id: "b" }), GRANT);

      const manifestFile = h.manifestPath(1);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.parent_hash = "0".repeat(64);
      writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.11").findings.join(" ")).toContain("parent_hash");
    } finally {
      h.dispose();
    }
  });

  test("a gap in the generation sequence is caught", () => {
    const h = harness();
    try {
      h.store.put(req({ record_id: "a" }), GRANT);
      h.store.put(req({ record_id: "b" }), GRANT);
      h.store.put(req({ record_id: "c" }), GRANT);
      unlinkSync(h.manifestPath(1));

      const report = h.doctor();
      expect(report.ok).toBe(false);
      expect(invariant(report, "80.11").findings.join(" ")).toContain("gap");
    } finally {
      h.dispose();
    }
  });
});

describe("staleness is surfaced, not treated as corruption", () => {
  test("a changed source file is flagged stale and retained", () => {
    const h = harness();
    try {
      const sourcePath = join(h.root, "tracked.ts");
      writeFileSync(sourcePath, "export const a = 1;\n", "utf8");
      const hash = hashContent(readFileSync(sourcePath, "utf8"));

      h.store.put(req({ source_refs: [{ path: "tracked.ts", hash }] }), GRANT);
      expect(h.doctor().ok).toBe(true);
      expect(invariant(h.doctor(), "80.8").status).toBe("pass");

      writeFileSync(sourcePath, "export const a = 2;\n", "utf8");

      const report = h.doctor();
      // Live source supersedes a memory summary about it, so this is a fact to
      // report -- not a build failure, and never a reason to delete the record.
      expect(report.ok).toBe(true);
      const check = invariant(report, "80.8");
      expect(check.status).toBe("repairable");
      expect(check.findings.join(" ")).toContain("changed since");
      expect(h.store.get("rec")).not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  test("a deleted source file is flagged stale, and the record survives", () => {
    const h = harness();
    try {
      const sourcePath = join(h.root, "gone.ts");
      writeFileSync(sourcePath, "x\n", "utf8");
      h.store.put(req({ source_refs: [{ path: "gone.ts", hash: hashContent("x\n") }] }), GRANT);
      unlinkSync(sourcePath);

      const report = h.doctor();
      expect(report.ok).toBe(true);
      expect(invariant(report, "80.8").findings.join(" ")).toContain("no longer exists");
      expect(h.store.get("rec")!.summary).toBe("a decision");
    } finally {
      h.dispose();
    }
  });
});

describe("corruption that cannot be reasoned past is refused loudly", () => {
  test("an unparseable live manifest raises rather than reporting a clean store", () => {
    const h = harness();
    try {
      h.store.put(req(), GRANT);
      writeFileSync(h.manifestPath(0), "{ truncated", "utf8");

      // Reporting "0 records, all invariants pass" here would be the worst
      // possible outcome: a corrupt store that looks healthy.
      expect(() => h.doctor()).toThrow();
    } finally {
      h.dispose();
    }
  });

  test("an unknown manifest schema version raises rather than guessing", () => {
    const h = harness();
    try {
      const dir = manifestDir(h.root, PROJECT);
      mkdirSync(dir, { recursive: true });
      writeFileSync(generationPath(dir, 0), JSON.stringify({ schema_version: 99, generation: 0, entries: {} }), "utf8");
      expect(() => h.doctor()).toThrow(/schema_version/);
    } finally {
      h.dispose();
    }
  });
});
