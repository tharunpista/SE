import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalJson,
  commitGeneration,
  GenerationTakenError,
  generationPath,
  listGenerations,
  manifestHash,
  readLiveManifest,
  Tier0CorruptionError,
  type Manifest,
  type ManifestEntry,
} from "../../src/memory/manifest.ts";

function tempDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "se-manifest-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    revision: 1,
    hash: "a".repeat(64),
    status: "active",
    scope: "project",
    type: "decision",
    idempotency_key: "k1",
    ...overrides,
  };
}

describe("canonical json", () => {
  test("key order never changes the serialisation", () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("undefined members are omitted rather than serialised as null", () => {
    // Idempotency keys are hashes of this output. If an absent optional field
    // and an explicitly-undefined one hashed differently, a replay would be
    // treated as new work and would inflate history.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("arrays keep their order, because order is content", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("generation chain", () => {
  test("an empty project has no live manifest", () => {
    const { dir, dispose } = tempDir();
    try {
      expect(readLiveManifest(dir)).toBeNull();
      expect(listGenerations(dir)).toEqual([]);
    } finally {
      dispose();
    }
  });

  test("the live manifest is the highest generation", () => {
    const { dir, dispose } = tempDir();
    try {
      const g0 = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      const g1 = commitGeneration(dir, "p", g0, { r1: entry({ revision: 2 }) }, "cs-1");
      expect(g0.generation).toBe(0);
      expect(g1.generation).toBe(1);
      expect(readLiveManifest(dir)!.generation).toBe(1);
      expect(readLiveManifest(dir)!.entries.r1!.revision).toBe(2);
    } finally {
      dispose();
    }
  });

  test("each generation records its parent, so the chain is verifiable", () => {
    const { dir, dispose } = tempDir();
    try {
      const g0 = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      const g1 = commitGeneration(dir, "p", g0, { r1: entry({ revision: 2 }) }, "cs-1");
      expect(g0.parent_hash).toBeNull();
      expect(g1.parent_hash).toBe(manifestHash(g0));
    } finally {
      dispose();
    }
  });

  test("a published generation file is never modified afterwards", () => {
    const { dir, dispose } = tempDir();
    try {
      const g0 = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      const before = Bun.file(generationPath(dir, 0)).size;
      commitGeneration(dir, "p", g0, { r1: entry({ revision: 2 }) }, "cs-1");
      expect(Bun.file(generationPath(dir, 0)).size).toBe(before);
      expect(readLiveManifest(dir)!.generation).toBe(1);
    } finally {
      dispose();
    }
  });

  test("staging files are cleaned up and never counted as generations", () => {
    const { dir, dispose } = tempDir();
    try {
      commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      const leftovers = readdirSync(dir).filter((f) => f.startsWith(".tmp."));
      expect(leftovers).toEqual([]);
      expect(listGenerations(dir)).toEqual([0]);
    } finally {
      dispose();
    }
  });
});

describe("lost update prevention", () => {
  test("two writers building the same generation: one commits, one is told", () => {
    const { dir, dispose } = tempDir();
    try {
      const base = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");

      // Both writers read the same base and build generation 1 from it.
      const winner = commitGeneration(dir, "p", base, { r1: entry({ revision: 2, idempotency_key: "winner" }) }, "cs-a");
      expect(winner.generation).toBe(1);

      expect(() =>
        commitGeneration(dir, "p", base, { r1: entry({ revision: 2, idempotency_key: "loser" }) }, "cs-b"),
      ).toThrow(GenerationTakenError);

      // The winner's content survived; the loser overwrote nothing.
      expect(readLiveManifest(dir)!.entries.r1!.idempotency_key).toBe("winner");
      expect(listGenerations(dir)).toEqual([0, 1]);
    } finally {
      dispose();
    }
  });
});

describe("corruption is refused, never guessed at", () => {
  test("an unparseable live generation raises rather than falling back", () => {
    const { dir, dispose } = tempDir();
    try {
      const g0 = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      commitGeneration(dir, "p", g0, { r1: entry({ revision: 2 }) }, "cs-1");
      writeFileSync(generationPath(dir, 1), "{not json", "utf8");

      // Falling back to generation 0 would silently roll memory backwards and
      // present a superseded revision as live.
      expect(() => readLiveManifest(dir)).toThrow(Tier0CorruptionError);
    } finally {
      dispose();
    }
  });

  test("an unknown schema_version is refused", () => {
    const { dir, dispose } = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        generationPath(dir, 0),
        JSON.stringify({ schema_version: 99, generation: 0, entries: {} }),
        "utf8",
      );
      expect(() => readLiveManifest(dir)).toThrow(/schema_version/);
    } finally {
      dispose();
    }
  });

  test("a generation whose declared number disagrees with its filename is refused", () => {
    const { dir, dispose } = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        generationPath(dir, 0),
        JSON.stringify({ schema_version: 1, generation: 7, entries: {}, project_id: "p", committed_at: "", parent_hash: null, changeset_id: "x" }),
        "utf8",
      );
      expect(() => readLiveManifest(dir)).toThrow(Tier0CorruptionError);
    } finally {
      dispose();
    }
  });
});

describe("multi-record changesets are atomic", () => {
  test("every record in a changeset becomes visible in the same generation", () => {
    const { dir, dispose } = tempDir();
    try {
      // A real update: a new decision, the supersession of the old one, and a
      // task status change -- applied independently these could leave memory in
      // a state no agent intended.
      commitGeneration(
        dir,
        "p",
        null,
        {
          "decision-new": entry({ revision: 1, status: "active" }),
          "decision-old": entry({ revision: 2, status: "superseded" }),
          "task-7": entry({ revision: 3, status: "archived" }),
        },
        "cs-multi",
      );

      const live = readLiveManifest(dir)!;
      expect(Object.keys(live.entries).sort()).toEqual(["decision-new", "decision-old", "task-7"]);
      expect(live.changeset_id).toBe("cs-multi");
      // One generation file, so there is no instant at which a reader could see
      // some of these and not the others.
      expect(listGenerations(dir)).toEqual([0]);
    } finally {
      dispose();
    }
  });

  test("a failed commit publishes nothing at all", () => {
    const { dir, dispose } = tempDir();
    try {
      const base = commitGeneration(dir, "p", null, { r1: entry() }, "cs-0");
      commitGeneration(dir, "p", base, { r1: entry({ revision: 2 }) }, "cs-winner");

      try {
        commitGeneration(dir, "p", base, { r1: entry({ revision: 2 }), r2: entry(), r3: entry() }, "cs-loser");
      } catch {
        /* expected */
      }

      const live = readLiveManifest(dir)!;
      expect(live.changeset_id).toBe("cs-winner");
      expect(live.entries.r2).toBeUndefined();
      expect(live.entries.r3).toBeUndefined();
      expect(readdirSync(dir).filter((f) => f.startsWith(".tmp."))).toEqual([]);
    } finally {
      dispose();
    }
  });
});
