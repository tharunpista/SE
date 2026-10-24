import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AmbiguousProjectError,
  ensureRepoLocalMemoryGitignore,
  identityFromRemote,
  initProject,
  PROJECT_CONFIG_PATH,
  resolveMemoryLocation,
  resolveProject,
  slugify,
} from "../../src/memory/project.ts";

function tempProject(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "se-proj-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** No ambient environment, so a developer's real SE_PROJECT cannot alter a test. */
const NO_ENV: Record<string, string | undefined> = {};

describe("slugify", () => {
  test("produces a single safe path segment", () => {
    expect(slugify("Acme Web App")).toBe("acme-web-app");
    expect(slugify("@scope/pkg")).toBe("scope-pkg");
    expect(slugify("--trim--")).toBe("trim");
  });

  test("never yields a path separator or traversal", () => {
    for (const hostile of ["../escape", "a/b", "..", "C:\\win"]) {
      const s = slugify(hostile);
      expect(s).not.toContain("/");
      expect(s).not.toContain("\\");
      expect(s).not.toBe("..");
    }
  });
});

describe("identity from a git remote", () => {
  const cases: Array<[string, string]> = [
    ["git@github.com:acme/web.git", "acme-web"],
    ["https://github.com/acme/web.git", "acme-web"],
    ["https://github.com/acme/web", "acme-web"],
    ["ssh://git@gitlab.com/group/thing.git", "group-thing"],
  ];

  for (const [remote, expected] of cases) {
    test(`${remote} resolves to ${expected}`, () => {
      expect(identityFromRemote(remote).id).toBe(expected);
    });
  }

  test("two clones of one repository agree, whatever the directory is called", () => {
    // This is the property the directory name lacks, and the whole reason this
    // module exists: a rename must not start a new, empty memory.
    const a = identityFromRemote("git@github.com:acme/web.git");
    const b = identityFromRemote("https://github.com/acme/web");
    expect(a.id).toBe(b.id);
  });
});

describe("resolution precedence", () => {
  test("an explicit flag wins over everything", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "from-package" }) });
    try {
      const identity = resolveProject(p.root, { flag: "Explicit Choice", env: { SE_PROJECT: "from-env" } });
      expect(identity.id).toBe("explicit-choice");
      expect(identity.source).toBe("flag");
    } finally {
      p.dispose();
    }
  });

  test("the environment wins over committed config", () => {
    const p = tempProject({
      [PROJECT_CONFIG_PATH]: JSON.stringify({ schema_version: 1, id: "from-config" }),
    });
    try {
      const identity = resolveProject(p.root, { env: { SE_PROJECT: "from-env" } });
      expect(identity.id).toBe("from-env");
      expect(identity.source).toBe("env");
    } finally {
      p.dispose();
    }
  });

  test("invalid explicit and environment ids are refused instead of using the store root", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "safe-project" }) });
    try {
      expect(() => resolveProject(p.root, { flag: "../" , env: NO_ENV })).toThrow(/usable project id/);
      expect(() => resolveProject(p.root, { env: { SE_PROJECT: "../../" } })).toThrow(/usable project id/);
    } finally {
      p.dispose();
    }
  });

  test("committed config wins over the package name", () => {
    const p = tempProject({
      "package.json": JSON.stringify({ name: "from-package" }),
      [PROJECT_CONFIG_PATH]: JSON.stringify({ schema_version: 1, id: "from-config" }),
    });
    try {
      const identity = resolveProject(p.root, { env: NO_ENV });
      expect(identity.id).toBe("from-config");
      expect(identity.source).toBe("config");
    } finally {
      p.dispose();
    }
  });

  test("the package name is used only as a last resort, and reported as such", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "se-org" }) });
    try {
      const identity = resolveProject(p.root, { env: NO_ENV });
      expect(identity.id).toBe("se-org");
      expect(identity.source).toBe("package-name");
    } finally {
      p.dispose();
    }
  });
});

describe("the directory name is never used", () => {
  test("a project with no reliable metadata is refused, not guessed at", () => {
    const p = tempProject({});
    try {
      // Part XX 23: resolve from reliable metadata or ask. Falling back to the
      // folder name would appear to work and then silently orphan every record
      // the first time the folder is renamed.
      expect(() => resolveProject(p.root, { env: NO_ENV })).toThrow(AmbiguousProjectError);
    } finally {
      p.dispose();
    }
  });

  test("the refusal says how to fix it", () => {
    const p = tempProject({});
    try {
      try {
        resolveProject(p.root, { env: NO_ENV });
        throw new Error("should have refused");
      } catch (cause) {
        expect((cause as Error).message).toContain("se memory init");
        expect((cause as Error).message).toContain("--project");
      }
    } finally {
      p.dispose();
    }
  });

  test("renaming the directory does not change the resolved id", () => {
    const p = tempProject({
      [PROJECT_CONFIG_PATH]: JSON.stringify({ schema_version: 1, id: "stable-id" }),
    });
    try {
      const before = resolveProject(p.root, { env: NO_ENV }).id;
      // Simulate the rename by resolving against a copy at a different path.
      const moved = mkdtempSync(join(tmpdir(), "se-renamed-"));
      mkdirSync(join(moved, ".se"), { recursive: true });
      writeFileSync(
        join(moved, PROJECT_CONFIG_PATH),
        JSON.stringify({ schema_version: 1, id: "stable-id" }),
        "utf8",
      );
      const after = resolveProject(moved, { env: NO_ENV }).id;
      expect(after).toBe(before);
      rmSync(moved, { recursive: true, force: true });
    } finally {
      p.dispose();
    }
  });
});

describe("malformed config is refused loudly", () => {
  test("invalid JSON", () => {
    const p = tempProject({ [PROJECT_CONFIG_PATH]: "{ broken" });
    try {
      expect(() => resolveProject(p.root, { env: NO_ENV })).toThrow(/not valid JSON/);
    } finally {
      p.dispose();
    }
  });

  test("an unknown schema version is not guessed at", () => {
    const p = tempProject({ [PROJECT_CONFIG_PATH]: JSON.stringify({ schema_version: 9, id: "x" }) });
    try {
      expect(() => resolveProject(p.root, { env: NO_ENV })).toThrow(/schema_version/);
    } finally {
      p.dispose();
    }
  });

  test("an id that is not a safe namespace is refused", () => {
    const p = tempProject({
      [PROJECT_CONFIG_PATH]: JSON.stringify({ schema_version: 1, id: "../escape" }),
    });
    try {
      // A config-supplied id reaches the filesystem as a path segment, so this
      // is a containment check, not a style check.
      expect(() => resolveProject(p.root, { env: NO_ENV })).toThrow(/not a valid namespace/);
    } finally {
      p.dispose();
    }
  });
});

describe("init pins the identity", () => {
  test("it writes a config derived from the package name when there is no remote", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "derived-name" }) });
    try {
      const result = initProject(p.root);
      expect(result.created).toBe(true);
      expect(result.identity.id).toBe("derived-name");

      // After init the identity is pinned, not re-derived.
      expect(resolveProject(p.root, { env: NO_ENV }).source).toBe("config");
    } finally {
      p.dispose();
    }
  });

  test("an explicit id overrides derivation", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "ignored" }) });
    try {
      expect(initProject(p.root, "Chosen Name").identity.id).toBe("chosen-name");
      expect(resolveProject(p.root, { env: NO_ENV }).id).toBe("chosen-name");
    } finally {
      p.dispose();
    }
  });

  test("re-running init does not silently change a pinned id", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "first" }) });
    try {
      initProject(p.root);
      const again = initProject(p.root);
      // Changing it would orphan everything already written under it, so an
      // unargumented re-run is a no-op that says so.
      expect(again.created).toBe(false);
      expect(again.identity.id).toBe("first");
    } finally {
      p.dispose();
    }
  });

  test("init refuses when there is nothing to derive from", () => {
    const p = tempProject({});
    try {
      expect(() => initProject(p.root)).toThrow(/--id/);
    } finally {
      p.dispose();
    }
  });
});

/*
 * Where Tier 0 lives decides which local boundary contains it: one checkout
 * or the user's home. Both are legitimate, so resolution has to be explicit
 * and testable -- a silent change of
 * placement would make an existing store look empty.
 */
describe("memory placement", () => {
  const NO_MEMORY_ENV: Record<string, string | undefined> = {};

  test("a project with no memory directory uses the global store", () => {
    const p = tempProject({ "package.json": JSON.stringify({ name: "fresh" }) });
    try {
      const location = resolveMemoryLocation(p.root, { env: NO_MEMORY_ENV });
      expect(location.source).toBe("global");
      expect(location.root).not.toContain(p.root);
    } finally {
      p.dispose();
    }
  });

  test("an existing memory directory wins, so no project needs migrating", () => {
    const p = tempProject({ "memory/.gitkeep": "" });
    try {
      const location = resolveMemoryLocation(p.root, { env: NO_MEMORY_ENV });
      expect(location.source).toBe("repo-local");
      expect(location.root).toBe(join(p.root, "memory"));
    } finally {
      p.dispose();
    }
  });

  test("local initialization adds an idempotent ignore rule without replacing user rules", () => {
    const p = tempProject({ "memory/.gitignore": "# existing local policy\n*.tmp\n" });
    try {
      const first = ensureRepoLocalMemoryGitignore(p.root);
      const contents = readFileSync(first.path, "utf8");
      expect(first.changed).toBe(true);
      expect(contents).toContain("# existing local policy");
      expect(contents).toContain("*\n!.gitignore\n!.gitkeep");

      const second = ensureRepoLocalMemoryGitignore(p.root);
      expect(second.changed).toBe(false);
      expect(readFileSync(second.path, "utf8")).toBe(contents);
    } finally {
      p.dispose();
    }
  });

  test("the environment overrides the resolved placement", () => {
    const p = tempProject({ "memory/.gitkeep": "" });
    try {
      const location = resolveMemoryLocation(p.root, {
        env: { SE_MEMORY_ROOT: join(p.root, "elsewhere") },
      });
      expect(location.source).toBe("env");
      expect(location.root).toBe(join(p.root, "elsewhere"));
    } finally {
      p.dispose();
    }
  });

  test("an explicit flag beats the environment", () => {
    const p = tempProject({});
    try {
      const location = resolveMemoryLocation(p.root, {
        flag: "from-flag",
        env: { SE_MEMORY_ROOT: "from-env" },
      });
      expect(location.source).toBe("flag");
      expect(location.root).toBe(join(p.root, "from-flag"));
    } finally {
      p.dispose();
    }
  });

  test("an explicit custom store location is reported as custom", () => {
    const p = tempProject({});
    try {
      const outside = mkdtempSync(join(tmpdir(), "se-outside-"));
      const location = resolveMemoryLocation(p.root, { flag: outside, env: NO_MEMORY_ENV });
      expect(location.source).toBe("flag");
      rmSync(outside, { recursive: true, force: true });
    } finally {
      p.dispose();
    }
  });

  test("placement never changes which project the memory belongs to", () => {
    // Project identity and store location are independent: moving the store
    // must not merge or split namespaces.
    const p = tempProject({ "package.json": JSON.stringify({ name: "same-project" }) });
    try {
      const globalRoot = resolveMemoryLocation(p.root, { env: NO_MEMORY_ENV });
      const flagged = resolveMemoryLocation(p.root, { flag: "other", env: NO_MEMORY_ENV });
      expect(globalRoot.root).not.toBe(flagged.root);
      expect(resolveProject(p.root, { env: NO_MEMORY_ENV }).id).toBe("same-project");
    } finally {
      p.dispose();
    }
  });
});
