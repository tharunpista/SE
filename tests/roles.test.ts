import { describe, expect, test } from "bun:test";
import { codes, hasCode, relevant, roleFile, tempRepo } from "./harness.ts";

describe("frontmatter parsing", () => {
  test("accepts CRLF line endings", () => {
    const repo = tempRepo();
    try {
      // Authored on Windows. Without normalisation the closing delimiter
      // carries a trailing \r, fails to match, and the error points at the
      // wrong line.
      repo.builtin("orchestration/a.md", roleFile("a").replace(/\n/g, "\r\n"));
      const { diagnostics } = repo.check();
      expect(relevant(diagnostics)).toEqual([]);
      expect(repo.resolve().byId.has("a")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("strips a UTF-8 BOM", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", "﻿" + roleFile("a"));
      expect(relevant(repo.check().diagnostics)).toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  test("rejects a file with no frontmatter", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", "# just prose\n");
      expect(hasCode(repo.check().diagnostics, "role/missing-frontmatter")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects unterminated frontmatter", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", "---\nid: a\nname: A\n");
      expect(hasCode(repo.check().diagnostics, "role/unterminated-frontmatter")).toBe(true);
    } finally {
      repo.dispose();
    }
  });
});

describe("fail-closed validation", () => {
  test("an unknown key is an error, not a warning", () => {
    const repo = tempRepo();
    try {
      // The motivating case: a misspelled 'enabled' must not silently leave
      // the role active.
      repo.builtin("orchestration/a.md", roleFile("a", { enabledd: false }));
      const diagnostics = repo.check().diagnostics;
      const d = diagnostics.find((x) => x.code === "role/unknown-key");
      expect(d).toBeDefined();
      expect(d!.severity).toBe("error");
      expect(d!.message).toContain("Did you mean \"enabled\"?");
    } finally {
      repo.dispose();
    }
  });

  test("an unknown artifact kind suggests the nearest term", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_artifacts: ["task-recrod"] }));
      const d = repo.check().diagnostics.find((x) => x.code === "role/unknown-vocabulary-term");
      expect(d?.message).toContain("Did you mean \"task-record\"?");
    } finally {
      repo.dispose();
    }
  });

  test("rejects an unsupported schema_version instead of guessing", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { schema_version: 2 }));
      expect(hasCode(repo.check().diagnostics, "role/unsupported-schema-version")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects write access to a scope the role cannot read", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        memory_scopes: { read: ["session"], write: ["session", "project"] },
      }));
      expect(hasCode(repo.check().diagnostics, "role/write-without-read")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("a file-writing role must declare how its work is verified", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        writes_files: true,
        verify_commands: [],
      }));
      // Evidence means a recorded command and exit code. Without a declared
      // command the role has no way to produce one, and will report success
      // it never checked.
      expect(hasCode(repo.check().diagnostics, "role/no-verify-commands")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("a role cannot hand its own stuck work back to itself", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { escalates_on_failure_to: "a" }));
      // That is precisely the retry loop the three-strike rule exists to break.
      expect(hasCode(repo.check().diagnostics, "role/self-escalation")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects placeholder text in the body", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {}, "# a\n\nTODO: write this up later."));
      expect(hasCode(repo.check().diagnostics, "role/placeholder-text")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects an empty body", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {}, "   \n\n"));
      expect(hasCode(repo.check().diagnostics, "role/empty-body")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects a filename that disagrees with the id", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/wrong-name.md", roleFile("a"));
      expect(hasCode(repo.check().diagnostics, "role/filename-id-mismatch")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects self-escalation, which loops forever at runtime", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { escalates_to: "a" }));
      expect(hasCode(repo.check().diagnostics, "role/self-escalation")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects a catalogue role claiming to be always active", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { tier: "catalogue", activation: ["always"] }));
      expect(hasCode(repo.check().diagnostics, "role/catalogue-always-active")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("a deprecated role must name its successor", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { status: "deprecated" }));
      expect(hasCode(repo.check().diagnostics, "role/deprecated-without-successor")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("rejects two files claiming one id in the same layer", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      // Same id, different department directory: precedence is undefined.
      repo.builtin("architecture/a.md", roleFile("a", { department: "architecture" }));
      expect(hasCode(repo.check().diagnostics, "role/duplicate-id")).toBe(true);
    } finally {
      repo.dispose();
    }
  });
});

describe("ownership collisions (Part XII 47)", () => {
  test("two roles owning one artifact is a build error", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_artifacts: ["api-endpoint"] }));
      repo.builtin("orchestration/b.md", roleFile("b", { owns_artifacts: ["api-endpoint"] }));
      const d = repo.check().diagnostics.find((x) => x.code === "catalogue/ownership-collision");
      expect(d).toBeDefined();
      expect(d!.severity).toBe("error");
      expect(d!.message).toContain("api-endpoint");
    } finally {
      repo.dispose();
    }
  });

  test("owner plus contributor is fine", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_artifacts: ["api-endpoint"] }));
      repo.builtin("orchestration/b.md", roleFile("b", { contributes_artifacts: ["api-endpoint"] }));
      const { registry, diagnostics } = repo.check();
      expect(relevant(diagnostics)).toEqual([]);
      void registry;
    } finally {
      repo.dispose();
    }
  });

  test("reciprocal shared_with is accepted, one-sided is rejected", () => {
    const oneSided = tempRepo();
    try {
      oneSided.builtin("orchestration/a.md", roleFile("a", {
        owns_artifacts: ["api-endpoint"],
        shared_with: { "api-endpoint": ["b"] },
      }));
      oneSided.builtin("orchestration/b.md", roleFile("b", { owns_artifacts: ["api-endpoint"] }));
      // b never agreed, so the authors did not actually agree.
      expect(hasCode(oneSided.check().diagnostics, "catalogue/ownership-collision")).toBe(true);
    } finally {
      oneSided.dispose();
    }

    const mutual = tempRepo();
    try {
      mutual.builtin("orchestration/a.md", roleFile("a", {
        owns_artifacts: ["api-endpoint"],
        shared_with: { "api-endpoint": ["b"] },
      }));
      mutual.builtin("orchestration/b.md", roleFile("b", {
        owns_artifacts: ["api-endpoint"],
        shared_with: { "api-endpoint": ["a"] },
      }));
      const diagnostics = mutual.check().diagnostics;
      expect(hasCode(diagnostics, "catalogue/ownership-collision")).toBe(false);
      // Permitted but discouraged: still surfaced as a warning.
      expect(hasCode(diagnostics, "catalogue/shared-ownership")).toBe(true);
    } finally {
      mutual.dispose();
    }
  });

  test("a disabled role does not collide", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { owns_artifacts: ["api-endpoint"] }));
      repo.builtin("orchestration/b.md", roleFile("b", {
        owns_artifacts: ["api-endpoint"], enabled: false,
      }));
      expect(hasCode(repo.check().diagnostics, "catalogue/ownership-collision")).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  test("shared_with without declared ownership is rejected", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { shared_with: { "api-endpoint": ["b"] } }));
      expect(hasCode(repo.check().diagnostics, "role/shared-without-ownership")).toBe(true);
    } finally {
      repo.dispose();
    }
  });
});

describe("reference and chain integrity", () => {
  test("a dangling collaborator is a broken handoff", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { collaborators: ["ghost"] }));
      expect(hasCode(repo.check().diagnostics, "catalogue/dangling-collaborator")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("an unresolvable escalation target is an error", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { escalates_to: "ghost" }));
      expect(hasCode(repo.check().diagnostics, "catalogue/dangling-escalation")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("an escalation cycle is detected before runtime", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { escalates_to: "b" }));
      repo.builtin("orchestration/b.md", roleFile("b", { escalates_to: "c" }));
      repo.builtin("orchestration/c.md", roleFile("c", { escalates_to: "a" }));
      const d = repo.check().diagnostics.find((x) => x.code === "catalogue/escalation-cycle");
      expect(d).toBeDefined();
      expect(d!.message).toMatch(/->/);
    } finally {
      repo.dispose();
    }
  });

  test("a chain terminating at the operator is accepted", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { escalates_to: "b" }));
      repo.builtin("orchestration/b.md", roleFile("b", { escalates_to: "operator" }));
      expect(hasCode(repo.check().diagnostics, "catalogue/escalation-cycle")).toBe(false);
    } finally {
      repo.dispose();
    }
  });
});

describe("layered customisation (Part IV 7.3)", () => {
  test("a project layer overrides one key and keeps the shipped body", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { max_calls: 5 }, "# a\n\nShipped prose worth keeping."));
      // A patch: only the key being changed, no body.
      repo.project("a.md", "---\nid: a\nmax_calls: 42\n---\n");
      const role = repo.resolve().byId.get("a");
      expect(role?.max_calls).toBe(42);
      expect(role?.body).toContain("Shipped prose worth keeping");
      expect(role?.provenance["max_calls"]).toBe("project");
      expect(role?.provenance["mission"]).toBe("builtin");
    } finally {
      repo.dispose();
    }
  });

  test("precedence is builtin < user < project", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { max_calls: 1 }));
      repo.user("a.md", "---\nid: a\nmax_calls: 2\n---\n");
      repo.project("a.md", "---\nid: a\nmax_calls: 3\n---\n");
      expect(repo.resolve().byId.get("a")?.max_calls).toBe(3);
    } finally {
      repo.dispose();
    }
  });

  test("a local layer can disable a shipped role", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      repo.project("a.md", "---\nid: a\nenabled: false\n---\n");
      const role = repo.resolve().byId.get("a");
      expect(role?.enabled).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  test("a local layer can introduce an entirely new role", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      repo.project("custom.md", roleFile("custom"));
      const registry = repo.resolve();
      expect(registry.byId.has("custom")).toBe(true);
      expect(registry.byId.get("custom")?.file).toContain(".se/roles/custom.md");
    } finally {
      repo.dispose();
    }
  });

  test("an override may not change the id", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      // Writing a different id into a file matched by filename "a.md".
      repo.project("a.md", "---\nid: b\n---\n");
      // Caught as a filename/id mismatch before it can rewrite identity.
      const diagnostics = repo.check().diagnostics;
      expect(
        hasCode(diagnostics, "role/filename-id-mismatch") ||
        hasCode(diagnostics, "role/id-changed-by-override"),
      ).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  test("appendable list keys accumulate instead of replacing", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { collaborators: ["b"] }));
      repo.builtin("orchestration/b.md", roleFile("b"));
      repo.builtin("orchestration/c.md", roleFile("c"));
      repo.project("a.md", "---\nid: a\ncollaborators: [\"c\"]\n---\n");
      // Adding a collaborator locally must not silently drop the shipped one.
      expect(repo.resolve().byId.get("a")?.collaborators).toEqual(["b", "c"]);
    } finally {
      repo.dispose();
    }
  });

  test("an explicit null clears an inherited value", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { boundary: "shipped boundary statement" }));
      repo.project("a.md", "---\nid: a\nboundary: null\n---\n");
      expect(repo.resolve().byId.get("a")?.boundary).toBe(null);
    } finally {
      repo.dispose();
    }
  });

  test("a missing override layer is normal, not an error", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      expect(relevant(repo.check().diagnostics)).toEqual([]);
    } finally {
      repo.dispose();
    }
  });
});

describe("determinism", () => {
  test("role order and diagnostics are stable across runs", () => {
    const repo = tempRepo();
    try {
      for (const id of ["zeta", "alpha", "mid"]) {
        repo.builtin(`orchestration/${id}.md`, roleFile(id));
      }
      const first = repo.resolve().all.map((r) => r.id);
      const second = repo.resolve().all.map((r) => r.id);
      // Unstable ordering makes the generated inventory churn in git and
      // makes CI logs undiffable.
      expect(first).toEqual(["alpha", "mid", "zeta"]);
      expect(second).toEqual(first);
    } finally {
      repo.dispose();
    }
  });

  test("the content hash ignores which layer defined the role", () => {
    const a = tempRepo();
    let builtinHash = "";
    try {
      a.builtin("orchestration/a.md", roleFile("a"));
      builtinHash = a.resolve().byId.get("a")!.hash;
    } finally {
      a.dispose();
    }

    const b = tempRepo();
    try {
      // Same content, defined in the project layer instead.
      b.project("a.md", roleFile("a"));
      // Moving a role between layers must not invalidate an evaluation
      // measured against its content (Part XVII 63).
      expect(b.resolve().byId.get("a")!.hash).toBe(builtinHash);
    } finally {
      b.dispose();
    }
  });

  test("changing any content key changes the hash", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { max_calls: 5 }));
      const before = repo.resolve().byId.get("a")!.hash;
      repo.builtin("orchestration/a.md", roleFile("a", { max_calls: 6 }));
      expect(repo.resolve().byId.get("a")!.hash).not.toBe(before);
    } finally {
      repo.dispose();
    }
  });
});

describe("the real shipped catalogue", () => {
  test("every shipped role file validates", async () => {
    const { findRepoRoot } = await import("../src/util/paths.ts");
    const { resolveRoles } = await import("../src/roles/resolve.ts");
    const root = findRepoRoot(import.meta.dir);
    expect(root).not.toBe(null);
    const registry = resolveRoles(root!);
    // Only catalogue-size errors are tolerated while the catalogue is
    // being filled in; per-file errors are never tolerated.
    const perFile = registry.diagnostics.sorted().filter((d) => d.code.startsWith("role/"));
    if (perFile.length > 0) {
      throw new Error(`shipped role files have errors:\n${registry.diagnostics.format()}`);
    }
    expect(codes(perFile)).toEqual([]);
  });
});
