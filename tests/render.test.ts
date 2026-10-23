import { describe, expect, test } from "bun:test";
import { claudeCodeAdapter } from "../src/render/claude-code.ts";
import { estimateTokens, routingDescription } from "../src/render/host.ts";
import { roleFile, tempRepo } from "./harness.ts";


function render(repo: ReturnType<typeof tempRepo>, ids?: string[]) {
  const registry = repo.resolve();
  const roles = ids
    ? ids.map((id) => registry.byId.get(id)!).filter(Boolean)
    : registry.all.filter((r) => r.enabled && r.status === "active");
  return claudeCodeAdapter.render(roles);
}

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

  test("a full 220-role catalogue overruns the budget and nearly trips the host", () => {
    // Measured, not assumed. The three real starter roles average 62.7
    // description tokens each, so the full catalogue is about 13,800 tokens:
    // it overruns this adapter's budget almost twice over, and leaves only
    // ~8% headroom under Claude Code's own 15,000-token warning. One verbose
    // mission trips it.
    //
    // This is the load-bearing reason roster selection exists. If this test
    // starts passing trivially, the budget has been raised too far and
    // someone in a hurry will render the catalogue whole.
    const MEASURED_TOKENS_PER_ROLE = 62.7;
    const fullCatalogue = Math.round(MEASURED_TOKENS_PER_ROLE * 220);

    expect(fullCatalogue).toBeGreaterThan(claudeCodeAdapter.metadataTokenBudget! * 1.5);
    expect(fullCatalogue).toBeGreaterThan(13000);
    // Not yet over the host's hard threshold, which is exactly why a
    // self-imposed budget is needed: the host will not stop you.
    expect(15000 - fullCatalogue).toBeLessThan(2000);
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
