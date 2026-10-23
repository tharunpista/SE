import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store.ts";
import type { Evidence, WriteGrant, WriteRequest } from "../../src/memory/types.ts";

function store(): { store: MemoryStore; root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "se-store-"));
  return {
    store: new MemoryStore({ memoryRoot: root, projectId: "proj-a" }),
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const EVIDENCE: Evidence[] = [
  { kind: "command", detail: "bun test", exit_code: 0, recorded_at: "2026-10-23T00:00:00.000Z" },
];

function grant(overrides: Partial<WriteGrant> = {}): WriteGrant {
  return {
    phase: "outcome-recording",
    write_targets: ["*"],
    scopes: ["project"],
    owner: "memory-systems-engineer",
    ...overrides,
  };
}

function req(overrides: Partial<WriteRequest> = {}): WriteRequest {
  return {
    record_id: "dec-1",
    scope: "project",
    type: "decision",
    status: "active",
    summary: "Chose the generation-file commit protocol.",
    owner: "memory-systems-engineer",
    evidence: EVIDENCE,
    expected_revision: 0,
    ...overrides,
  };
}

describe("the happy path", () => {
  test("a write is accepted, readable, and reported with its revision", () => {
    const h = store();
    try {
      const r = h.store.put(req(), grant());
      expect(r.accepted).toBe(true);
      if (!r.accepted) return;
      expect(r.revision).toBe(1);
      expect(r.generation).toBe(0);

      const read = h.store.get("dec-1")!;
      expect(read.summary).toBe("Chose the generation-file commit protocol.");
      expect(read.revision).toBe(1);
      expect(read.project_id).toBe("proj-a");
      expect(read.trust_tier).toBe("derived");
    } finally {
      h.dispose();
    }
  });

  test("a second revision supersedes the first without destroying it", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      const r = h.store.put(req({ summary: "Revised.", expected_revision: 1 }), grant());
      expect(r.accepted).toBe(true);

      // Part XX 71: versions are append-only. The old one is still readable.
      expect(h.store.getRevision("dec-1", 1)!.summary).toBe("Chose the generation-file commit protocol.");
      expect(h.store.get("dec-1")!.summary).toBe("Revised.");
      expect(h.store.get("dec-1")!.revision).toBe(2);
    } finally {
      h.dispose();
    }
  });

  test("created_at is preserved across revisions; written_at advances", () => {
    const h = store();
    try {
      let clock = new Date("2026-01-01T00:00:00.000Z");
      const s = new MemoryStore({ memoryRoot: h.root, projectId: "proj-a", now: () => clock });
      s.put(req(), grant());
      clock = new Date("2026-06-01T00:00:00.000Z");
      s.put(req({ summary: "Later.", expected_revision: 1 }), grant());

      const live = s.get("dec-1")!;
      expect(live.created_at).toBe("2026-01-01T00:00:00.000Z");
      expect(live.written_at).toBe("2026-06-01T00:00:00.000Z");
    } finally {
      h.dispose();
    }
  });

  test("the derived current mirror tracks the live revision", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      h.store.put(req({ summary: "Second.", expected_revision: 1 }), grant());
      const mirror = readFileSync(join(h.root, "proj-a", "records", "dec-1", "current"), "utf8");
      expect(mirror.trim()).toBe("2");
    } finally {
      h.dispose();
    }
  });
});

describe("phase gating (Part XX 75)", () => {
  test("a write during context assembly is rejected", () => {
    const h = store();
    try {
      const r = h.store.put(req(), grant({ phase: "context-assembly" }));
      expect(r.accepted).toBe(false);
      if (r.accepted) return;
      expect(r.code).toBe("phase-forbids-write");
      expect(h.store.get("dec-1")).toBeNull();
      // Nothing was committed, so no generation exists at all.
      expect(h.store.generation).toBe(-1);
    } finally {
      h.dispose();
    }
  });

  test("project resolution may not write either", () => {
    const h = store();
    try {
      const r = h.store.put(req(), grant({ phase: "project-resolution" }));
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("phase-forbids-write");
    } finally {
      h.dispose();
    }
  });

  test("execution may write session scope but not project scope", () => {
    const h = store();
    try {
      const ok = h.store.put(
        req({ record_id: "note-1", scope: "session" }),
        grant({ phase: "execution", scopes: ["session"] }),
      );
      expect(ok.accepted).toBe(true);

      const bad = h.store.put(req(), grant({ phase: "execution", scopes: ["project"] }));
      expect(bad.accepted).toBe(false);
      if (!bad.accepted) expect(bad.code).toBe("scope-not-granted");
    } finally {
      h.dispose();
    }
  });

  test("a grant narrower than its phase is honoured", () => {
    const h = store();
    try {
      // The phase would allow project scope; this particular grant does not.
      const r = h.store.put(req(), grant({ scopes: [] }));
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("scope-not-granted");
    } finally {
      h.dispose();
    }
  });

  test("a record outside the granted write targets is rejected", () => {
    const h = store();
    try {
      const r = h.store.put(req({ record_id: "other" }), grant({ write_targets: ["dec-1"] }));
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("target-not-granted");
    } finally {
      h.dispose();
    }
  });

  test("outcome recording without evidence is rejected", () => {
    const h = store();
    try {
      const r = h.store.put(req({ evidence: [] }), grant());
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("evidence-required");
    } finally {
      h.dispose();
    }
  });

  test("promotion requires an operator approval an agent cannot grant itself", () => {
    const h = store();
    try {
      const g = grant({ phase: "promotion", scopes: ["role"] });
      const r = h.store.put(req({ scope: "role" }), g);
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("approval-required");

      const approved = h.store.put(req({ scope: "role" }), { ...g, approved_by: "operator@example.com" });
      expect(approved.accepted).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("compaction may change status but not rewrite content", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      const g = grant({ phase: "compaction", scopes: ["project"] });

      const rewrite = h.store.put(
        req({ status: "archived", summary: "Rewritten history.", expected_revision: 1 }),
        g,
      );
      expect(rewrite.accepted).toBe(false);
      if (!rewrite.accepted) expect(rewrite.code).toBe("content-rewrite-forbidden");

      const statusOnly = h.store.put(req({ status: "archived", expected_revision: 1 }), g);
      expect(statusOnly.accepted).toBe(true);
      expect(h.store.get("dec-1")!.status).toBe("archived");
    } finally {
      h.dispose();
    }
  });
});

describe("compare-and-swap (Part XX 72 step 3)", () => {
  test("a stale expected revision is refused and names the live one", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      const r = h.store.put(req({ summary: "Blind overwrite.", expected_revision: 0 }), grant());
      expect(r.accepted).toBe(false);
      if (r.accepted) return;
      expect(r.code).toBe("revision-conflict");
      expect(r.conflicting_revision).toBe(1);
      // The live record is untouched.
      expect(h.store.get("dec-1")!.summary).toBe("Chose the generation-file commit protocol.");
    } finally {
      h.dispose();
    }
  });

  test("claiming a record exists when it does not is refused", () => {
    const h = store();
    try {
      const r = h.store.put(req({ expected_revision: 3 }), grant());
      expect(r.accepted).toBe(false);
      if (!r.accepted) {
        expect(r.code).toBe("revision-conflict");
        expect(r.message).toContain("does not exist");
      }
    } finally {
      h.dispose();
    }
  });

  test("two racing writers produce exactly one success and one named conflict", () => {
    const h = store();
    try {
      h.store.put(req(), grant());

      // Two stores sharing one Tier 0, both having read revision 1.
      const a = new MemoryStore({ memoryRoot: h.root, projectId: "proj-a" });
      const b = new MemoryStore({ memoryRoot: h.root, projectId: "proj-a" });

      const first = a.put(req({ summary: "From A.", expected_revision: 1 }), grant());
      const second = b.put(req({ summary: "From B.", expected_revision: 1 }), grant());

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      if (!second.accepted) {
        expect(second.code).toBe("revision-conflict");
        expect(second.record_id).toBe("dec-1");
      }
      expect(h.store.get("dec-1")!.summary).toBe("From A.");
    } finally {
      h.dispose();
    }
  });
});

describe("the record state machine (Part XX 74)", () => {
  test("an illegal transition is a rejected write, not a warning", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      h.store.put(req({ status: "archived", expected_revision: 1 }), grant());

      // archived is terminal.
      const r = h.store.put(req({ status: "active", expected_revision: 2 }), grant());
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("illegal-transition");
      expect(h.store.get("dec-1")!.status).toBe("archived");
    } finally {
      h.dispose();
    }
  });

  test("a new record cannot be born superseded", () => {
    const h = store();
    try {
      const r = h.store.put(req({ status: "superseded", superseded_by: "dec-2" }), grant());
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("illegal-transition");
    } finally {
      h.dispose();
    }
  });

  test("marking a record disputed is permitted and does not require authority", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      const r = h.store.put(req({ status: "disputed", expected_revision: 1 }), grant());
      expect(r.accepted).toBe(true);
      expect(h.store.get("dec-1")!.status).toBe("disputed");
    } finally {
      h.dispose();
    }
  });

  test("a superseded record must name an existing active successor", () => {
    const h = store();
    try {
      h.store.put(req(), grant());

      const noName = h.store.put(req({ status: "superseded", expected_revision: 1 }), grant());
      expect(noName.accepted).toBe(false);
      if (!noName.accepted) expect(noName.code).toBe("supersession-missing");

      const ghost = h.store.put(
        req({ status: "superseded", superseded_by: "nope", expected_revision: 1 }),
        grant(),
      );
      expect(ghost.accepted).toBe(false);
      if (!ghost.accepted) expect(ghost.code).toBe("supersession-missing");
    } finally {
      h.dispose();
    }
  });

  /*
   * Closing a supersession loop is refused, but by the active-successor rule
   * rather than by the cycle walk. That is not an accident worth papering over:
   * because every link must point at an *active* record, and an active record
   * has no successor, a chain always terminates. A cycle is therefore
   * unreachable through the write path, and the cycle check exists for Tier 0
   * that was corrupted or written by an older version -- which is why
   * `se memory doctor` checks it independently (invariant 4).
   */
  test("closing a supersession loop is rejected", () => {
    const h = store();
    try {
      h.store.put(req({ record_id: "a" }), grant());
      h.store.put(req({ record_id: "b" }), grant());

      // a -> b is fine: b is active.
      expect(
        h.store.put(req({ record_id: "a", status: "superseded", superseded_by: "b", expected_revision: 1 }), grant())
          .accepted,
      ).toBe(true);

      // b -> a would close the loop, and a is no longer active.
      const cycle = h.store.put(
        req({ record_id: "b", status: "superseded", superseded_by: "a", expected_revision: 1 }),
        grant(),
      );
      expect(cycle.accepted).toBe(false);
      if (!cycle.accepted) {
        expect(["supersession-cycle", "supersession-missing"]).toContain(cycle.code);
        expect(cycle.message).toContain("a");
      }
      // Whichever rule fired, the loop does not exist on disk.
      expect(h.store.get("b")!.status).toBe("active");
    } finally {
      h.dispose();
    }
  });

  test("a chain of supersessions stays walkable and terminates", () => {
    const h = store();
    try {
      for (const id of ["v1", "v2", "v3"]) h.store.put(req({ record_id: id }), grant());
      h.store.put(req({ record_id: "v1", status: "superseded", superseded_by: "v2", expected_revision: 1 }), grant());
      // v2 -> v3 requires v2's successor to be active, which v3 is.
      const r = h.store.put(
        req({ record_id: "v2", status: "superseded", superseded_by: "v3", expected_revision: 1 }),
        grant(),
      );
      expect(r.accepted).toBe(true);
      expect(h.store.get("v1")!.superseded_by).toBe("v2");
      expect(h.store.get("v2")!.superseded_by).toBe("v3");
      expect(h.store.get("v3")!.status).toBe("active");
    } finally {
      h.dispose();
    }
  });

  test("a record cannot supersede itself", () => {
    const h = store();
    try {
      h.store.put(req(), grant());
      const r = h.store.put(
        req({ status: "superseded", superseded_by: "dec-1", expected_revision: 1 }),
        grant(),
      );
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.code).toBe("supersession-cycle");
    } finally {
      h.dispose();
    }
  });
});

describe("secrets never enter the store (Part XI)", () => {
  const planted: Array<[string, string]> = [
    ["aws", "Deploy used AKIAIOSFODNN7EXAMPLE for the upload."],
    ["github", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
    ["assignment", 'config has password = "s3cret-hunter2-value"'],
    ["url creds", "cloned https://user:supersecretpw@example.com/repo.git"],
    ["anthropic", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
  ];

  for (const [label, content] of planted) {
    test(`a planted ${label} secret is rejected on write`, () => {
      const h = store();
      try {
        const r = h.store.put(req({ body: content }), grant());
        expect(r.accepted).toBe(false);
        if (!r.accepted) {
          expect(r.code).toBe("secret-detected");
          // The refusal must not echo the credential back.
          expect(r.message).not.toContain("supersecretpw");
          expect(r.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
        }
        expect(h.store.get("dec-1")).toBeNull();
      } finally {
        h.dispose();
      }
    });
  }

  test("a placeholder is not mistaken for a secret", () => {
    const h = store();
    try {
      const r = h.store.put(req({ body: 'set password = "<your-password>" in .env' }), grant());
      expect(r.accepted).toBe(true);
    } finally {
      h.dispose();
    }
  });

  test("a source hash is not mistaken for a secret", () => {
    const h = store();
    try {
      // Every record carries hashes; an entropy-only detector would reject all of them.
      const r = h.store.put(
        req({ source_refs: [{ path: "src/memory/store.ts", hash: "a3f1".repeat(16) }] }),
        grant(),
      );
      expect(r.accepted).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("idempotency (Part XX 78)", () => {
  test("replaying an identical write creates no revision and no generation", () => {
    const h = store();
    try {
      const first = h.store.put(req({ task_id: "task-9" }), grant());
      expect(first.accepted).toBe(true);
      const generationAfterFirst = h.store.generation;

      const replay = h.store.put(req({ task_id: "task-9" }), grant());
      expect(replay.accepted).toBe(true);
      if (!replay.accepted) return;
      expect(replay.deduplicated).toBe(true);
      expect(replay.revision).toBe(1);
      expect(h.store.generation).toBe(generationAfterFirst);
      expect(h.store.get("dec-1")!.revision).toBe(1);
    } finally {
      h.dispose();
    }
  });

  test("replaying a whole completed run creates zero new revisions", () => {
    const h = store();
    try {
      const run: WriteRequest[] = [
        req({ record_id: "r1", task_id: "t1" }),
        req({ record_id: "r2", task_id: "t1" }),
        req({ record_id: "r3", task_id: "t1" }),
      ];
      const first = h.store.putChangeset(run, grant());
      expect(first.accepted).toBe(true);
      const generation = h.store.generation;

      const replay = h.store.putChangeset(run, grant());
      expect(replay.accepted).toBe(true);
      expect(replay.results.every((r) => r.accepted && r.deduplicated)).toBe(true);
      expect(h.store.generation).toBe(generation);
      for (const id of ["r1", "r2", "r3"]) expect(h.store.get(id)!.revision).toBe(1);
    } finally {
      h.dispose();
    }
  });

  test("a genuine edit is not mistaken for a replay", () => {
    const h = store();
    try {
      h.store.put(req({ task_id: "t1" }), grant());
      const edit = h.store.put(req({ task_id: "t1", summary: "Actually different.", expected_revision: 1 }), grant());
      expect(edit.accepted).toBe(true);
      if (edit.accepted) {
        expect(edit.deduplicated).toBe(false);
        expect(edit.revision).toBe(2);
      }
    } finally {
      h.dispose();
    }
  });
});

describe("changesets are atomic (Part XX 73)", () => {
  test("all members become visible in one generation", () => {
    const h = store();
    try {
      const r = h.store.putChangeset(
        [req({ record_id: "new-decision" }), req({ record_id: "task-7" })],
        grant(),
      );
      expect(r.accepted).toBe(true);
      expect(r.generation).toBe(0);
      expect(h.store.listRecordIds()).toEqual(["new-decision", "task-7"]);
    } finally {
      h.dispose();
    }
  });

  test("one failing member publishes nothing, and every member is reported", () => {
    const h = store();
    try {
      const r = h.store.putChangeset(
        [
          req({ record_id: "good-1" }),
          req({ record_id: "good-2" }),
          req({ record_id: "bad", body: "AKIAIOSFODNN7EXAMPLE" }),
        ],
        grant(),
      );

      expect(r.accepted).toBe(false);
      expect(r.generation).toBeUndefined();
      expect(r.results).toHaveLength(3);
      expect(r.results.every((x) => !x.accepted)).toBe(true);

      // Nothing at all was published -- not even the valid members.
      expect(h.store.generation).toBe(-1);
      expect(h.store.get("good-1")).toBeNull();
      expect(h.store.get("good-2")).toBeNull();
    } finally {
      h.dispose();
    }
  });

  test("a refused member hands its content back so no work is lost", () => {
    const h = store();
    try {
      const r = h.store.putChangeset([req({ record_id: "kept", summary: "Valuable analysis." })], {
        ...grant(),
        phase: "context-assembly",
      });
      const refusal = r.results[0]!;
      expect(refusal.accepted).toBe(false);
      if (!refusal.accepted) {
        expect(refusal.surfaced.summary).toBe("Valuable analysis.");
      }
    } finally {
      h.dispose();
    }
  });

  test("a supersession and its successor can land in the same changeset", () => {
    const h = store();
    try {
      h.store.put(req({ record_id: "old" }), grant());
      const r = h.store.putChangeset(
        [
          req({ record_id: "new" }),
          req({ record_id: "old", status: "superseded", superseded_by: "new", expected_revision: 1 }),
        ],
        grant(),
      );
      expect(r.accepted).toBe(true);
      expect(h.store.get("old")!.status).toBe("superseded");
      expect(h.store.get("new")!.status).toBe("active");
    } finally {
      h.dispose();
    }
  });
});

describe("project isolation (Part XX 76)", () => {
  test("two projects with similar names never cross-retrieve", () => {
    const root = mkdtempSync(join(tmpdir(), "se-iso-"));
    try {
      const a = new MemoryStore({ memoryRoot: root, projectId: "acme-web" });
      const b = new MemoryStore({ memoryRoot: root, projectId: "acme-web-2" });

      a.put(req({ record_id: "shared-id", summary: "Belongs to A." }), grant());
      b.put(req({ record_id: "shared-id", summary: "Belongs to B." }), grant());

      expect(a.get("shared-id")!.summary).toBe("Belongs to A.");
      expect(b.get("shared-id")!.summary).toBe("Belongs to B.");
      expect(a.get("shared-id")!.project_id).toBe("acme-web");
      expect(b.get("shared-id")!.project_id).toBe("acme-web-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a record id that escapes its namespace is refused", () => {
    const h = store();
    try {
      for (const bad of ["../escape", "a/b", "..", "nested\\path"]) {
        const r = h.store.put(req({ record_id: bad }), grant());
        expect(r.accepted).toBe(false);
        if (!r.accepted) expect(r.code).toBe("schema-invalid");
      }
    } finally {
      h.dispose();
    }
  });
});
