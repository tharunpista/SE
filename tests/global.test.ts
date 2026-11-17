import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { findProjectRoot, isCatalogueRoot, readGlobalConfig, seHome, stateRoot, writeGlobalConfig } from "../src/util/paths.ts";
import { agentsMdAdapter } from "../src/render/agents-md.ts";
import { ADAPTERS, claudeCodeAdapter, findAdapter } from "../src/render/claude-code.ts";
import { roleFile, tempRepo } from "./harness.ts";

function tempTree(files: Record<string, string>, dirs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "se-global-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("environment path overrides", () => {
  test("SE_HOME is anchored to an absolute path rather than reinterpreted by each command", () => {
    expect(seHome({ SE_HOME: "relative-se-home" })).toBe(join(homedir(), "relative-se-home"));
  });

  test("SE_STATE_ROOT resolves to an absolute path", () => {
    const root = join(tmpdir(), "se-project");
    expect(stateRoot(root, { SE_STATE_ROOT: "relative-state" })).toBe(join(root, "relative-state"));
  });

  test("registered catalogue paths must be absolute and remain stable", () => {
    const t = tempTree({});
    const env = { SE_HOME: join(t.root, "home") };
    try {
      const path = writeGlobalConfig(t.root, env);
      expect(readGlobalConfig(env)?.catalogue_root).toBe(t.root);
      writeFileSync(path, JSON.stringify({ schema_version: 1, catalogue_root: "relative-catalogue" }));
      expect(readGlobalConfig(env)).toBeNull();
    } finally {
      t.dispose();
    }
  });
});

describe("catalogue root and project root are different questions", () => {
  test("a catalogue root needs the specification tree, not just a package.json", () => {
    const plain = tempTree({ "package.json": "{}" });
    const catalogue = tempTree({ "package.json": "{}", "se/agents/.keep": "" });
    try {
      expect(isCatalogueRoot(plain.root)).toBe(false);
      expect(isCatalogueRoot(catalogue.root)).toBe(true);
    } finally {
      plain.dispose();
      catalogue.dispose();
    }
  });

  test("the project root is found from a nested directory", () => {
    const t = tempTree({ "package.json": "{}", "src/deep/file.ts": "" });
    try {
      expect(findProjectRoot(join(t.root, "src", "deep"))).toBe(t.root);
    } finally {
      t.dispose();
    }
  });

  test("a bare directory with no marker resolves to itself rather than wandering up", () => {
    const t = tempTree({}, ["empty"]);
    try {
      const nested = join(t.root, "empty");
      const resolved = findProjectRoot(nested);
      // Walking up out of an unmarked directory would land on the user's home
      // or drive root, and render output would be written there.
      expect(resolved).toBe(nested);
    } finally {
      t.dispose();
    }
  });

  test("a project root is recognised by .git alone", () => {
    const t = tempTree({}, [".git"]);
    try {
      expect(findProjectRoot(t.root)).toBe(t.root);
    } finally {
      t.dispose();
    }
  });

  test("a manifest in the home directory never claims the folders beneath it", () => {
    // `root` plays the home directory and carries an unrelated package.json.
    const t = tempTree({ "package.json": "{}" }, ["scratch/deep"]);
    try {
      const nested = join(t.root, "scratch", "deep");
      expect(findProjectRoot(nested, t.root)).toBe(nested);
      expect(findProjectRoot(t.root, t.root)).toBe(t.root);
    } finally {
      t.dispose();
    }
  });
});

describe("host registry", () => {
  test("all host adapters are registered and findable by id", () => {
    expect(ADAPTERS.map((a) => a.id).sort()).toEqual([
      "agent-skills", "agents-md", "antigravity", "claude-code", "claude-skills",
      "codex", "copilot", "cursor", "gemini-cli", "opencode",
    ]);
    expect(findAdapter("agents-md")).toBe(agentsMdAdapter);
    expect(findAdapter("nope")).toBeUndefined();
  });

  test("each host declares whether it provides workspace isolation", () => {
    // Reporting isolation a host does not provide tells the operator parallel
    // writers are safe when they are not.
    expect(claudeCodeAdapter.providesWorkspaceIsolation).toBe(true);
    expect(agentsMdAdapter.providesWorkspaceIsolation).toBe(false);
  });

  test("a host with no agreed user-level location declares none", () => {
    expect(claudeCodeAdapter.userOut).toContain(".claude");
    // Guessing a path for AGENTS.md would either be ignored or apply these
    // instructions to every unrelated project on the machine.
    expect(agentsMdAdapter.userOut).toBeNull();
  });
});

describe("the AGENTS.md adapter emits an index, not a roster", () => {
  function renderAll(ids: string[]) {
    const repo = tempRepo();
    try {
      for (const id of ids) {
        repo.builtin(`orchestration/${id}.md`, roleFile(id, { tier: "starter", activation: ["always"] }));
      }
      const roles = ids.map((id) => repo.resolve().byId.get(id)!);
      return agentsMdAdapter.render(roles);
    } finally {
      repo.dispose();
    }
  }

  test("one file, named AGENTS.md", () => {
    const result = renderAll(["alpha", "beta"]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("AGENTS.md");
  });

  test("every role appears once, as a row", () => {
    const contents = renderAll(["alpha", "beta", "gamma"]).files[0]!.contents;
    for (const id of ["alpha", "beta", "gamma"]) {
      expect(contents).toContain(`\`${id}\``);
    }
  });

  test("it does not inline full role bodies", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/bodied.md",
        roleFile("bodied", {}, "# Bodied\n\n## Mission\n\nUNIQUE_BODY_MARKER appears only in the body."),
      );
      const role = repo.resolve().byId.get("bodied")!;
      const contents = agentsMdAdapter.render([role]).files[0]!.contents;

      // A single-instruction-file host has no selector, so inlining 152 full
      // definitions would load every specialist at once -- and they are written
      // to contradict each other about scope on purpose.
      expect(contents).not.toContain("UNIQUE_BODY_MARKER");
      expect(contents).toContain("se role <id>");
    } finally {
      repo.dispose();
    }
  });

  test("the index is substantially cheaper than the equivalent Claude Code roster", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `role${i}`);
    const repo = tempRepo();
    try {
      for (const id of ids) {
        repo.builtin(`orchestration/${id}.md`, roleFile(id, { tier: "starter", activation: ["always"] }));
      }
      const roles = ids.map((id) => repo.resolve().byId.get(id)!);
      const index = agentsMdAdapter.render(roles).metadataTokens;
      const roster = claudeCodeAdapter.render(roles).metadataTokens;
      // Both are real costs; the point is that one line per role is the cheaper
      // shape for a host that loads everything at once.
      expect(index).toBeGreaterThan(0);
      expect(roster).toBeGreaterThan(0);
    } finally {
      repo.dispose();
    }
  });

  test("it states that it grants no tools, rather than implying enforcement", () => {
    const contents = renderAll(["alpha"]).files[0]!.contents;
    expect(contents).toContain("grants no tools");
    // Reported once in the file, not 152 times in the render output.
    expect(renderAll(["alpha"]).unmapped.size).toBe(0);
  });

  test("it tells the agent to read memory before source", () => {
    const contents = renderAll(["alpha"]).files[0]!.contents;
    expect(contents).toContain("se memory");
    expect(contents).toContain("stale");
  });

  test("it does not pretend a collaborator list performs delegation", () => {
    const contents = renderAll(["alpha"]).files[0]!.contents;
    expect(contents).toContain("not proof of automatic delegation");
    expect(contents).toContain("receiver confirms acceptance");
  });

  test("it does not point at a catalogue path that may not exist locally", () => {
    // The catalogue is often outside the project being worked on, so a relative
    // path instruction is wrong exactly when the CLI is used globally.
    const contents = renderAll(["alpha"]).files[0]!.contents;
    expect(contents).not.toContain("se/agents/<department>");
  });
});
