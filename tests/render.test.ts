import { describe, expect, test } from "bun:test";
import { ADAPTERS, claudeCodeAdapter } from "../src/render/claude-code.ts";
import { estimateTokens, routingDescription } from "../src/render/host.ts";
import { hasCode, roleFile, tempRepo } from "./harness.ts";
import type { Role } from "../src/roles/types.ts";

/**
 * A Role object built directly, bypassing file parsing and validation.
 *
 * Only for testing the renderer's defence against inputs `validate` refuses to
 * produce. Anything reachable through a role file should be tested through a
 * repository fixture instead, so the test exercises the real path.
 */
function synthesiseRole(overrides: Partial<Role> & { id: string }): Role {
  return {
    schema_version: 1,
    name: overrides.id,
    department: "orchestration",
    tier: "catalogue",
    mission: "Exercise the renderer with a definition the validator would refuse.",
    activation: ["a synthetic condition"],
    tools: ["read-files"],
    memory_scopes: { read: ["session"], write: [] },
    owns_artifacts: [],
    contributes_artifacts: [],
    owns_interfaces: [],
    participates_interfaces: [],
    shared_with: {},
    collaborators: [],
    escalates_to: "operator",
    context_budget_tokens: 20000,
    max_calls: 5,
    enabled: true,
    status: "active",
    supersedes: [],
    superseded_by: null,
    boundary: null,
    requires_evidence: false,
    writes_files: false,
    owns_spec_sections: [],
    verify_commands: [],
    escalates_on_failure_to: null,
    blocked_on: [],
    stack_aware: false,
    body: `# ${overrides.id}\n\n## Mission\n\nSynthetic.`,
    file: `synthetic/${overrides.id}.md`,
    provenance: {},
    hash: "0".repeat(64),
    ...overrides,
  } as Role;
}

function render(repo: ReturnType<typeof tempRepo>, ids?: string[]) {
  const registry = repo.resolve();
  const roles = ids
    ? ids.map((id) => registry.byId.get(id)!).filter(Boolean)
    : registry.all.filter((r) => r.enabled && r.status === "active");
  return claudeCodeAdapter.render(roles);
}

describe("shared role execution and handoff contract", () => {
  test("every full-definition host renders the same coordination rules", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      const role = repo.resolve().byId.get("a")!;
      for (const adapter of ADAPTERS.filter((candidate) => candidate.id !== "agents-md")) {
        const rendered = adapter.render([role], repo.root);
        expect(rendered.files.length).toBeGreaterThan(0);
        for (const file of rendered.files) {
          expect(file.contents).toContain("Mandatory execution and handoff contract");
          expect(file.contents).toContain("delivery alone is not acceptance");
          expect(file.contents).toContain("Never invent a package, command, or tool result");
        }
      }
    } finally {
      repo.dispose();
    }
  });
});

function frontmatter(contents: string): Record<string, string> {
  const end = contents.indexOf("\n---", 4);
  const block = contents.slice(4, end);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

describe("tool mapping enforces the role's declared constraints", () => {
  test("a role that does not write files receives no Write or Edit tool", () => {
    const repo = tempRepo();
    try {
      // The Chief Orchestrator's definition says it must not implement.
      // Rendering turns that from prose into something the host enforces.
      repo.builtin("orchestration/a.md", roleFile("a", {
        tools: ["read-files", "search", "invoke-agent"],
        writes_files: false,
      }));
      const fm = frontmatter(render(repo).files[0]!.contents);
      expect(fm["tools"]).toBe("Agent, Glob, Grep, Read");
      expect(fm["tools"]).not.toContain("Write");
      expect(fm["tools"]).not.toContain("Edit");
      expect(fm["tools"]).not.toContain("Bash");
    } finally {
      repo.dispose();
    }
  });

  test("a role that writes files gets an isolated worktree", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        tools: ["read-files", "write-files"],
        writes_files: true,
      }));
      const fm = frontmatter(render(repo).files[0]!.contents);
      // Part XV 53: parallel writers in one tree corrupt each other with no
      // error anywhere. The host provides isolation declaratively.
      expect(fm["isolation"]).toBe("worktree");
      expect(fm["tools"]).toContain("Write");
    } finally {
      repo.dispose();
    }
  });

  test("a non-writing role gets no isolation key", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { writes_files: false }));
      expect(frontmatter(render(repo).files[0]!.contents)["isolation"]).toBeUndefined();
    } finally {
      repo.dispose();
    }
  });

  test("max_calls becomes the host's turn limit", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { max_calls: 17 }));
      expect(frontmatter(render(repo).files[0]!.contents)["maxTurns"]).toBe("17");
    } finally {
      repo.dispose();
    }
  });

  test("project memory scope enables cross-session memory", () => {
    const withProject = tempRepo();
    try {
      withProject.builtin("orchestration/a.md", roleFile("a", {
        memory_scopes: { read: ["session", "project"], write: ["session", "project"] },
      }));
      expect(frontmatter(render(withProject).files[0]!.contents)["memory"]).toBe("project");
    } finally {
      withProject.dispose();
    }

    const sessionOnly = tempRepo();
    try {
      sessionOnly.builtin("orchestration/a.md", roleFile("a", {
        memory_scopes: { read: ["session"], write: ["session"] },
      }));
      expect(frontmatter(render(sessionOnly).files[0]!.contents)["memory"]).toBeUndefined();
    } finally {
      sessionOnly.dispose();
    }
  });

  test("an unmappable capability is reported, never silently dropped", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        tools: ["read-files", "drive-a-browser"],
      }));
      const result = render(repo);
      // Silently dropping a capability produces a role that looks fine and
      // cannot do its job. It must surface, both to the operator and in the
      // rendered prompt.
      expect(result.unmapped.get("a")).toEqual(["drive-a-browser"]);
      expect(result.files[0]!.contents).toContain("Unavailable capabilities");
    } finally {
      repo.dispose();
    }
  });

  test("capabilities this project serves itself are not reported as unmapped", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        tools: ["read-files", "memory-read", "memory-write", "escalate", "task-graph"],
      }));
      const result = render(repo);
      // These are served by se's own layer. Rendering them as Bash would hand
      // the role a shell it was never granted.
      expect(result.unmapped.size).toBe(0);
      expect(frontmatter(result.files[0]!.contents)["tools"]).toBe("Read");
    } finally {
      repo.dispose();
    }
  });
});

describe("frontmatter safety", () => {
  test("a mission containing a colon or quote cannot break the frontmatter", () => {
    const repo = tempRepo();
    try {
      // Claude Code skips a subagent whose frontmatter does not parse, and
      // does so WITHOUT reporting it in the session. A quoting bug here is a
      // silently missing role, which is the worst class of failure.
      repo.builtin("orchestration/a.md", roleFile("a", {
        mission: 'Own the "wire format": schemas, errors, and compatibility rules.',
      }));
      const contents = render(repo).files[0]!.contents;
      const descLine = contents.split("\n").find((l) => l.startsWith("description:"))!;
      expect(descLine).toContain('\\"wire format\\"');
      // The block must still terminate on its own line.
      expect(contents.split("\n").indexOf("---", 1)).toBeGreaterThan(0);
    } finally {
      repo.dispose();
    }
  });

  test("the generated file names its source and role hash", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a"));
      const role = repo.resolve().byId.get("a")!;
      const contents = render(repo).files[0]!.contents;
      // Traceability: a regression must be traceable to a wording change.
      expect(contents).toContain(role.hash);
      expect(contents).toContain("se/agents/orchestration/a.md");
      expect(contents).toContain("Do not edit here");
    } finally {
      repo.dispose();
    }
  });

  test("the evidence rule reaches the rendered prompt", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", { requires_evidence: true }));
      expect(render(repo).files[0]!.contents).toContain("Your confidence is not");
    } finally {
      repo.dispose();
    }
  });
});

describe("always-loaded metadata budget", () => {
  test("the description is bounded in length", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        mission: "A".repeat(395),
        activation: ["B".repeat(80), "C".repeat(80), "D".repeat(80)],
      }));
      const role = repo.resolve().byId.get("a")!;
      const description = routingDescription(role);
      expect(description.length).toBeLessThanOrEqual(320);
    } finally {
      repo.dispose();
    }
  });

  test("the adapter declares a budget below the host's warning threshold", () => {
    // Claude Code warns once combined custom subagent descriptions exceed
    // 15,000 tokens. The budget sits well under it, because the warning is
    // the mild symptom: a large subagent tree also slows session start and
    // crowds out context the actual task needs.
    expect(claudeCodeAdapter.metadataTokenBudget).not.toBeNull();
    expect(claudeCodeAdapter.metadataTokenBudget!).toBeLessThan(15000);
  });

  test("the full 191-role active catalogue fits under the metadata budget", () => {
    const makeRoster = (count: number) => Array.from({ length: count }, (_, i) =>
      synthesiseRole({
        id: `role-${i}`,
        mission: "Mission detail ".repeat(25),
        activation: ["Routing condition ".repeat(12)],
      }),
    );
    const fullActiveCatalogue = claudeCodeAdapter.render(makeRoster(191));

    expect(fullActiveCatalogue.metadataTokens).toBeLessThan(claudeCodeAdapter.metadataTokenBudget!);
  });

  test("the measured per-role cost has not silently inflated", () => {
    // Guards the figure the test above depends on. If descriptions grow,
    // this fails here rather than as a mysterious startup warning later.
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/a.md", roleFile("a", {
        mission:
          "Own the authoritative request and response contract between producer " +
          "and consumer, and make it exist before either side builds against an " +
          "assumption.",
        activation: ["any work crossing a frontend and backend boundary"],
      }));
      const tokens = estimateTokens(routingDescription(repo.resolve().byId.get("a")!));
      expect(tokens).toBeLessThanOrEqual(80);
    } finally {
      repo.dispose();
    }
  });

  test("the starter roster fits comfortably", () => {
    const repo = tempRepo();
    try {
      for (let i = 0; i < 9; i++) {
        repo.builtin(`orchestration/s${i}.md`, roleFile(`s${i}`, { tier: "starter", activation: ["always"] }));
      }
      const result = render(repo);
      expect(result.files.length).toBe(9);
      expect(result.metadataTokens).toBeLessThan(claudeCodeAdapter.metadataTokenBudget! / 2);
    } finally {
      repo.dispose();
    }
  });
});

describe("determinism", () => {
  test("render order is stable regardless of discovery order", () => {
    const repo = tempRepo();
    try {
      for (const id of ["zeta", "alpha", "mid"]) {
        repo.builtin(`orchestration/${id}.md`, roleFile(id));
      }
      const once = render(repo).files.map((f) => f.path);
      const twice = render(repo).files.map((f) => f.path);
      // An unstable render churns the diff and hides real changes among
      // reorderings.
      expect(once).toEqual(["alpha.md", "mid.md", "zeta.md"]);
      expect(twice).toEqual(once);
    } finally {
      repo.dispose();
    }
  });
});

/*
 * The audit that prompted these tests found that a role declaring
 * `writes_files: false` while listing the `write-files` capability was rendered
 * with Write and Edit, and -- because the same false flag gates workspace
 * isolation -- without `isolation: worktree`. Write access with no isolated
 * workspace is strictly worse than either problem alone.
 *
 * `validate` now rejects that combination at source. These tests cover the
 * renderer anyway: a defence that exists in only one layer is one edit away
 * from being gone.
 */
describe("write tools are withheld from a role that declares no file writing", () => {
  test("validate rejects the contradiction at source", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/reader.md",
        roleFile("reader", {
          tools: ["read-files", "search", "write-files"],
          writes_files: false,
          verify_commands: [],
          requires_evidence: false,
        }),
      );
      const { diagnostics } = repo.check();
      expect(hasCode(diagnostics, "role/contradictory-write-declaration")).toBe(true);
      // Fail-closed: the role does not resolve at all, so nothing downstream
      // has to compensate for it.
      expect(repo.resolve().byId.has("reader")).toBe(false);
    } finally {
      repo.dispose();
    }
  });

  test("an honestly read-only role keeps the capabilities it did declare", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/honest.md",
        roleFile("honest", {
          tools: ["read-files", "search"],
          writes_files: false,
          verify_commands: [],
          requires_evidence: false,
        }),
      );
      const fm = frontmatter(render(repo, ["honest"]).files[0]!.contents);
      const tools = (fm["tools"] ?? "").split(",").map((t) => t.trim());

      expect(tools).toContain("Read");
      expect(tools).toContain("Grep");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
    } finally {
      repo.dispose();
    }
  });

  /*
   * These two go straight at the adapter. `validate` rejects the contradictory
   * combination, so a fixture carrying it never resolves and can never reach
   * the renderer through the file layer -- which is the point of the rule, and
   * also why the renderer's own guard has to be tested directly rather than
   * through a repository fixture.
   */
  test("the adapter withholds write tools even if a contradictory role reaches it", () => {
    const rendered = claudeCodeAdapter.render([
      synthesiseRole({ id: "sneaky", tools: ["read-files", "write-files", "edit-notebook"], writes_files: false }),
    ]);
    const fm = frontmatter(rendered.files[0]!.contents);
    const tools = (fm["tools"] ?? "").split(",").map((t) => t.trim());

    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("NotebookEdit");
    expect(tools).toContain("Read");
    // No write declaration means no worktree, which is exactly why the tools
    // must not arrive: write access without isolation is the worst combination.
    expect(fm["isolation"]).toBeUndefined();
  });

  test("withholding the tools leaves no empty tools key behind", () => {
    const rendered = claudeCodeAdapter.render([
      synthesiseRole({ id: "onlywrite", tools: ["write-files"], writes_files: false }),
    ]);
    // An empty `tools:` line would read to the host as "no tools", which is a
    // different claim from "the key is absent".
    expect(rendered.files[0]!.contents).not.toMatch(/^tools:\s*$/m);
  });

  test("a role that does declare file writing keeps its write tools and gets isolation", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/writer.md",
        roleFile("writer", { tools: ["read-files", "write-files"], writes_files: true }),
      );
      const contents = render(repo, ["writer"]).files[0]!.contents;
      const fm = frontmatter(contents);
      expect(fm["tools"]).toContain("Write");
      expect(fm["tools"]).toContain("Edit");
      // Part XV 53: a file writer gets its own workspace, or parallel writers
      // corrupt each other with no error anywhere.
      expect(fm["isolation"]).toBe("worktree");
    } finally {
      repo.dispose();
    }
  });

});

describe("acceptance tests are not shipped to the agent", () => {
  const body = [
    "# Role",
    "",
    "## Mission",
    "",
    "Do the bounded thing.",
    "",
    "## 15. Common failure modes and mitigations",
    "",
    "| Failure | Mitigation |",
    "|---|---|",
    "| Silent skip | Report the gap |",
    "",
    "## 16. Acceptance tests",
    "",
    "1. A planted secret is rejected.",
    "2. An illegal transition is refused.",
  ].join("\n");

  test("the acceptance-test section is stripped from the rendered body", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/evaled.md", roleFile("evaled", {}, body));
      const contents = render(repo, ["evaled"]).files[0]!.contents;

      expect(contents).not.toContain("A planted secret is rejected");
      expect(contents).not.toContain("Acceptance tests");
    } finally {
      repo.dispose();
    }
  });

  test("failure modes are kept, because mitigations change what the agent does", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/evaled2.md", roleFile("evaled2", {}, body));
      const contents = render(repo, ["evaled2"]).files[0]!.contents;

      expect(contents).toContain("Common failure modes");
      expect(contents).toContain("Report the gap");
      // Everything before the stripped section survives intact.
      expect(contents).toContain("Do the bounded thing.");
    } finally {
      repo.dispose();
    }
  });

  test("the role file itself still carries the acceptance tests for the eval harness", () => {
    const repo = tempRepo();
    try {
      repo.builtin("orchestration/evaled3.md", roleFile("evaled3", {}, body));
      const role = repo.resolve().byId.get("evaled3")!;
      // Stripping is a rendering concern. The source of truth keeps them, or
      // there would be nothing left to evaluate the role against.
      expect(role.body).toContain("A planted secret is rejected");
    } finally {
      repo.dispose();
    }
  });
});

/*
 * `memory-read` and `memory-write` deliberately map to no host tool. A
 * capability that resolves to nothing and is never mentioned is, from inside the
 * agent, indistinguishable from having no memory -- which is how a role ends up
 * re-reading source it already summarised. The rendered body therefore states
 * the access path, and states honestly when there is none.
 */
describe("memory access is stated, and stated honestly", () => {
  test("a role with a shell is given the commands and the staleness rule", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/mem-shell.md",
        roleFile("mem-shell", {
          tools: ["read-files", "run-shell", "memory-read", "memory-write"],
          memory_scopes: { read: ["session", "project"], write: ["project"] },
        }),
      );
      const contents = render(repo, ["mem-shell"]).files[0]!.contents;

      expect(contents).toContain("se memory get");
      expect(contents).toContain("se memory put");
      // The whole point is reading memory instead of re-reading source.
      expect(contents).toContain("before");
      // Live source always wins over a summary of it.
      expect(contents).toContain("stale");
      expect(contents).toContain("project");
    } finally {
      repo.dispose();
    }
  });

  test("a read-only memory role is not told how to write", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/mem-read.md",
        roleFile("mem-read", {
          tools: ["read-files", "run-shell", "memory-read"],
          memory_scopes: { read: ["project"], write: [] },
        }),
      );
      const contents = render(repo, ["mem-read"]).files[0]!.contents;
      expect(contents).toContain("se memory get");
      expect(contents).not.toContain("se memory put");
    } finally {
      repo.dispose();
    }
  });

  test("a role with no shell is told memory is unreachable, not left to guess", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/mem-noshell.md",
        roleFile("mem-noshell", {
          tools: ["read-files", "memory-read", "memory-write"],
          verify_commands: [],
          requires_evidence: false,
        }),
      );
      const contents = render(repo, ["mem-noshell"]).files[0]!.contents;

      expect(contents).toContain("unreachable");
      // It must not be handed commands it cannot run, or it will report a write
      // that never happened.
      expect(contents).not.toContain("- `se memory status`");
      expect(contents).toContain("do not claim a");
    } finally {
      repo.dispose();
    }
  });

  test("a role declaring no memory capability gets no memory block at all", () => {
    const repo = tempRepo();
    try {
      repo.builtin(
        "orchestration/no-mem.md",
        roleFile("no-mem", {
          tools: ["read-files"],
          verify_commands: [],
          requires_evidence: false,
        }),
      );
      const contents = render(repo, ["no-mem"]).files[0]!.contents;
      expect(contents).not.toContain("Project memory");
    } finally {
      repo.dispose();
    }
  });
});
