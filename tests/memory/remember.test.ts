import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdMemory } from "../../src/memory/cli.ts";

interface Harness {
  readonly repoRoot: string;
  /** Run `se memory <args>`; returns the exit code with stdout and stderr captured. */
  run(positional: string[], flags?: Record<string, string | true>): Run;
  file(rel: string, contents: string): void;
  dispose(): void;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function harness(): Harness {
  const repoRoot = mkdtempSync(join(tmpdir(), "se-remember-"));
  const memoryRoot = join(repoRoot, ".memory-store");
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");

  return {
    repoRoot,
    file(rel, contents) {
      const full = join(repoRoot, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    },
    run(positional, flags = {}) {
      const map = new Map<string, string | true>(Object.entries(flags));
      // Pinned explicitly so the test is independent of the fixture's package
      // name, its git remote, and the developer's real store.
      map.set("memory-root", memoryRoot);
      map.set("project", "fixture-app");

      const out: string[] = [];
      const err: string[] = [];
      const log = console.log;
      const error = console.error;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      console.error = (...a: unknown[]) => void err.push(a.join(" "));
      try {
        const code = cmdMemory(repoRoot, positional, map);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } finally {
        console.log = log;
        console.error = error;
      }
    },
    dispose: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

/** `--source a --source b` reaches the CLI as one newline-joined value. */
function repeated(...values: string[]): string {
  return values.join("\n");
}

describe("remember writes a record without the caller assembling one", () => {
  test("a session-scope note needs nothing but a sentence", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "totals are computed client-side"], { scope: "session" });
      expect(run.code).toBe(0);
      expect(run.out).toContain("accepted:");
      expect(run.out).toContain("revision 1");
    } finally {
      h.dispose();
    }
  });

  test("the record id is a readable slug that stops at a word boundary", () => {
    const h = harness();
    try {
      h.run(["remember", "cart totals are computed client-side and must move to the server soon"], {
        scope: "session",
      });
      const list = h.run(["list"]);
      // Truncated to the 48-character budget, but never mid-word.
      expect(list.out).toContain("cart-totals-are-computed-client-side-and-must");
      expect(list.out).not.toContain("-mu\n");
    } finally {
      h.dispose();
    }
  });

  test("an explicit --id overrides the slug", () => {
    const h = harness();
    try {
      h.run(["remember", "anything at all"], { scope: "session", id: "payments-decision" });
      expect(h.run(["list"]).out).toContain("payments-decision");
    } finally {
      h.dispose();
    }
  });

  /*
   * The expected revision is the single most common cause of a refusal that
   * reads like a tool bug. `remember` resolves it, so writing twice updates the
   * record instead of failing with a conflict the caller cannot act on.
   */
  test("writing the same record again updates it rather than conflicting", () => {
    const h = harness();
    try {
      h.run(["remember", "a decision"], { scope: "session", id: "d" });
      const second = h.run(["remember", "a decision, revised"], { scope: "session", id: "d" });
      expect(second.code).toBe(0);
      expect(second.out).toContain("revision 2");
    } finally {
      h.dispose();
    }
  });

  test("identical content creates no new revision", () => {
    const h = harness();
    try {
      h.run(["remember", "an unchanged decision"], { scope: "session", id: "d" });
      const again = h.run(["remember", "an unchanged decision"], { scope: "session", id: "d" });
      expect(again.code).toBe(0);
      expect(again.out).toContain("unchanged");
      expect(again.out).not.toContain("revision 2");
    } finally {
      h.dispose();
    }
  });

  test("--source is hashed from disk, so freshness works without the caller hashing", () => {
    const h = harness();
    try {
      h.file("src/cart.ts", "export const total = 1;\n");
      const run = h.run(["remember", "cart maths lives here"], {
        scope: "session",
        source: "src/cart.ts",
      });
      expect(run.code).toBe(0);

      expect(h.run(["recall"]).out).toContain("src/cart.ts (current)");
      h.file("src/cart.ts", "export const total = 2;\n");
      const stale = h.run(["recall"]);
      expect(stale.out).toContain("src/cart.ts (stale)");
      expect(stale.out).toContain("STALE");
    } finally {
      h.dispose();
    }
  });

  /*
   * `--source` takes an operator- or agent-supplied path and reads the file to
   * hash it. The first implementation joined it to the repo root and read
   * whatever came back, so `--source ../../../.ssh/id_rsa` would have been read
   * and its hash stored in a record. Containment is enforced now; these tests
   * exist so a later refactor cannot quietly remove it again.
   */
  test("a --source escaping the project root is refused, not read", () => {
    const h = harness();
    try {
      for (const attempt of ["../../../etc/passwd", "..\\..\\..\\windows\\win.ini", "../outside.txt"]) {
        const run = h.run(["remember", "about a file outside the project"], {
          scope: "session",
          source: attempt,
        });
        expect(run.code).toBe(2);
        expect(h.run(["list"]).out).toContain("no records");
      }
    } finally {
      h.dispose();
    }
  });

  test("an absolute --source is refused", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "about an absolute path"], {
        scope: "session",
        source: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd",
      });
      expect(run.code).toBe(2);
      expect(h.run(["list"]).out).toContain("no records");
    } finally {
      h.dispose();
    }
  });

  test("a binary --source is refused rather than hashed as text", () => {
    const h = harness();
    try {
      writeFileSync(join(h.repoRoot, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
      const run = h.run(["remember", "about a binary file"], { scope: "session", source: "blob.bin" });
      expect(run.code).toBe(2);
      expect(h.run(["list"]).out).toContain("no records");
    } finally {
      h.dispose();
    }
  });

  test("a missing --source is refused before anything is written", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "about a file that is not there"], {
        scope: "session",
        source: "src/nope.ts",
      });
      expect(run.code).toBe(2);
      expect(run.err).toContain("does not exist");
      expect(h.run(["list"]).out).toContain("no records");
    } finally {
      h.dispose();
    }
  });

  test("several sources are all recorded", () => {
    const h = harness();
    try {
      h.file("a.ts", "a\n");
      h.file("b.ts", "b\n");
      h.run(["remember", "spans two files"], {
        scope: "session",
        source: repeated("a.ts", "b.ts"),
      });
      const out = h.run(["recall"]).out;
      expect(out).toContain("a.ts (current)");
      expect(out).toContain("b.ts (current)");
    } finally {
      h.dispose();
    }
  });
});

/*
 * The phase gates are the point of the write protocol. `remember` must make
 * them easier to satisfy, never optional.
 */
describe("remember derives the phase but never relaxes it", () => {
  test("a project-scope write without evidence is refused, naming the flag that fixes it", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "we chose Stripe"]);
      expect(run.code).toBe(2);
      expect(run.err).toContain("requires evidence");
      expect(run.err).toContain("--evidence");
      expect(run.err).toContain("--scope session");
      expect(h.run(["list"]).out).toContain("no records");
    } finally {
      h.dispose();
    }
  });

  test("a project-scope write with evidence is accepted", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "we chose Stripe"], { evidence: "bun test:0" });
      expect(run.code).toBe(0);
      expect(run.out).toContain("accepted:");
    } finally {
      h.dispose();
    }
  });

  test("a command and its exit code are stored as command evidence", () => {
    const h = harness();
    try {
      h.run(["remember", "the suite passes"], { evidence: "bun test --filter memory:0" });
      const json = JSON.parse(h.run(["get", "the-suite-passes"], { json: true }).out) as {
        record: { evidence: { kind: string; detail: string; exit_code?: number }[] };
      };
      expect(json.record.evidence[0]?.kind).toBe("command");
      expect(json.record.evidence[0]?.detail).toBe("bun test --filter memory");
      expect(json.record.evidence[0]?.exit_code).toBe(0);
    } finally {
      h.dispose();
    }
  });

  test("evidence without an exit code is recorded as an operator statement, not a command", () => {
    const h = harness();
    try {
      h.run(["remember", "reviewed in person"], { evidence: "walked through it with the operator" });
      const json = JSON.parse(h.run(["get", "reviewed-in-person"], { json: true }).out) as {
        record: { evidence: { kind: string }[] };
      };
      expect(json.record.evidence[0]?.kind).toBe("operator");
    } finally {
      h.dispose();
    }
  });

  test("promotion beyond the project cannot be self-granted", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "a rule for every project"], {
        scope: "organization",
        evidence: "bun test:0",
      });
      expect(run.code).toBe(2);
      expect(run.err).toContain("requires operator approval");
    } finally {
      h.dispose();
    }
  });

  test("promotion succeeds once an operator approves it", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "a rule for every project"], {
        scope: "organization",
        evidence: "bun test:0",
        approve: "tharun",
      });
      expect(run.code).toBe(0);
    } finally {
      h.dispose();
    }
  });

  test("a secret is refused and the content is handed back", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "the key is sk_" + "live_51H8xQ2abcdefghijklmnopqrstuvwxyz0123"], {
        scope: "session",
      });
      expect(run.code).toBe(1);
      expect(run.err).toContain("REFUSED");
      expect(run.err).toContain("reproduced here");
    } finally {
      h.dispose();
    }
  });

  test("--dry-run shows the request it would send and writes nothing", () => {
    const h = harness();
    try {
      const run = h.run(["remember", "a candidate record"], { scope: "session", "dry-run": true });
      expect(run.code).toBe(0);
      expect(run.out).toContain("dry run: nothing was written");
      expect(JSON.parse(run.out.slice(0, run.out.lastIndexOf("}") + 1)).request.expected_revision).toBe(0);
      expect(h.run(["list"]).out).toContain("no records");
    } finally {
      h.dispose();
    }
  });
});

/*
 * `brief` runs in a hook, where nobody reads stderr and a non-zero exit looks
 * like a broken install. Both properties are load-bearing, so both are tested.
 */
describe("the session brief", () => {
  test("it names the project and where the identity came from", () => {
    const h = harness();
    try {
      const run = h.run(["brief"]);
      expect(run.code).toBe(0);
      expect(run.out).toContain("Project: fixture-app");
      expect(run.out).toContain("identity:");
    } finally {
      h.dispose();
    }
  });

  test("an empty store still briefs, and says how to record the first thing", () => {
    const h = harness();
    try {
      const run = h.run(["brief"]);
      expect(run.code).toBe(0);
      expect(run.out).toContain("No project memory yet");
      expect(run.out).toContain("se memory remember");
    } finally {
      h.dispose();
    }
  });

  test("records are included, so a resumed session reads memory before source", () => {
    const h = harness();
    try {
      h.run(["remember", "payments go through Stripe"], { scope: "session", id: "pay" });
      const run = h.run(["brief"]);
      expect(run.out).toContain("1 live at generation");
      expect(run.out).toContain("## pay");
    } finally {
      h.dispose();
    }
  });

  test("an ambiguous namespace is reported on stdout, where a hook can actually see it", () => {
    const h = harness();
    try {
      // Two unrelated directories resolving to one name-derived namespace.
      const other = join(h.repoRoot, "other");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");

      const map = new Map<string, string | true>([
        ["memory-root", join(h.repoRoot, ".memory-store")],
      ]);
      const out: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      let code: number;
      try {
        cmdMemory(h.repoRoot, ["brief"], map);
        code = cmdMemory(other, ["brief"], map);
      } finally {
        console.log = log;
      }

      expect(code).toBe(0);
      expect(out.join("\n")).toContain("WARNING");
      expect(out.join("\n")).toContain("may belong to a different project");
    } finally {
      h.dispose();
    }
  });
});

/*
 * `--hook` answers the host's SessionStart payload. Two properties matter more
 * than the content: it must never inject twice into one conversation (resume,
 * compact and fork already carry the brief), and it must never fail, because a
 * hook that errors on session start breaks every session in the project --
 * strictly worse than a session with no memory.
 */
describe("the SessionStart hook", () => {
  /** Run the real CLI with a payload on stdin; the hook path reads fd 0. */
  async function hook(source: string | null, raw?: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "..", "src", "cli.ts"), "memory", "brief", "--hook"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "..", "..") },
    );
    proc.stdin.write(raw ?? (source === null ? "" : JSON.stringify({ source })));
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  }

  test("a new session is answered in the host's hook format", async () => {
    const { code, out } = await hook("startup");
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Project:");
  });

  /*
   * The cost control. resume, compact and fork continue a conversation that
   * already carries the brief, so injecting again pays twice for the same
   * records and displaces the conversation it was meant to inform.
   */
  test.each(["resume", "compact", "fork"])("%s injects nothing", async (source) => {
    const { code, out } = await hook(source);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({});
  });

  test("clear is a new context window, so it does inject", async () => {
    const { out } = await hook("clear");
    expect(JSON.parse(out).hookSpecificOutput).toBeDefined();
  });

  test("an unparseable payload still injects rather than failing the session", async () => {
    const { code, out } = await hook(null, "this is not json");
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput).toBeDefined();
  });

  test("empty stdin exits 0", async () => {
    const { code } = await hook(null, "");
    expect(code).toBe(0);
  });

  test("an unknown source is treated as not-new and injects nothing", async () => {
    expect(JSON.parse((await hook("something-new-in-a-later-version")).out)).toEqual({});
  });

  /*
   * The hook is installed globally, so it fires in every directory -- a home
   * directory, a scratch folder, a clone with no manifest or remote. Printing
   * the identity refusal there at every session start is how an operator
   * learns to disable the hook, so an unresolvable project is "no memory
   * here", not an error.
   */
  test("a directory with no project identity answers with a silent no-op", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "se-noproject-"));
    try {
      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "..", "..", "src", "cli.ts"), "memory", "brief", "--hook"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: scratch },
      );
      proc.stdin.write(JSON.stringify({ source: "startup" }));
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out)).toEqual({});
      // Nothing on stderr either: a hook that chatters is a hook that gets removed.
      expect(err).not.toContain("Cannot determine the project identity");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("brief never throws and never exits non-zero, whatever the store holds", () => {
    const h = harness();
    try {
      expect(h.run(["brief"]).code).toBe(0);
      h.run(["remember", "a record"], { scope: "session" });
      expect(h.run(["brief"]).code).toBe(0);
    } finally {
      h.dispose();
    }
  });

  test("the injected brief stays within a bounded size", () => {
    const h = harness();
    try {
      // Twelve records with long bodies; the budget must still cap the output.
      const long = "x".repeat(600);
      for (let i = 0; i < 12; i++) {
        h.run(["remember", `decision ${i} ${long}`], { scope: "session", id: `d${i}` });
      }
      const out = h.run(["brief"], { budget: "1500" }).out;
      // ~4 chars per token against a 1500-token budget, plus the header.
      expect(out.length).toBeLessThan(1500 * 4 + 800);
      expect(out).toContain("omitted by the 1500-token budget");
    } finally {
      h.dispose();
    }
  });
});

describe("recall returns the whole store in one call", () => {
  test("an empty store says so rather than failing", () => {
    const h = harness();
    try {
      const run = h.run(["recall"]);
      expect(run.code).toBe(0);
      expect(run.out).toContain("no memory");
    } finally {
      h.dispose();
    }
  });

  test("active records come before superseded ones", () => {
    const h = harness();
    try {
      h.run(["remember", "the new way"], { scope: "session", id: "new" });
      h.run(["remember", "the old way"], { scope: "session", id: "old" });
      h.run(["remember", "the old way"], {
        scope: "session",
        id: "old",
        status: "superseded",
        "superseded-by": "new",
      });
      const out = h.run(["recall"]).out;
      expect(out.indexOf("## new")).toBeLessThan(out.indexOf("## old"));
    } finally {
      h.dispose();
    }
  });

  test("a topic filters by id, summary, body and type", () => {
    const h = harness();
    try {
      h.run(["remember", "payments go through Stripe"], { scope: "session", id: "pay" });
      h.run(["remember", "search is Postgres full-text"], { scope: "session", id: "search" });
      const out = h.run(["recall", "stripe"]).out;
      expect(out).toContain("## pay");
      expect(out).not.toContain("## search");
    } finally {
      h.dispose();
    }
  });

  test("--scope and --type narrow the result", () => {
    const h = harness();
    try {
      h.run(["remember", "a risk"], { scope: "session", type: "risk", id: "r" });
      h.run(["remember", "a decision"], { scope: "session", type: "decision", id: "d" });
      expect(h.run(["recall"], { type: "risk" }).out).toContain("## r");
      expect(h.run(["recall"], { type: "risk" }).out).not.toContain("## d");
    } finally {
      h.dispose();
    }
  });

  test("--limit bounds the count", () => {
    const h = harness();
    try {
      for (const id of ["a", "b", "c"]) h.run(["remember", `record ${id}`], { scope: "session", id });
      const out = h.run(["recall"], { limit: "2" }).out;
      expect(out.match(/^## /gm)).toHaveLength(2);
      expect(out).toContain("1 further record");
    } finally {
      h.dispose();
    }
  });

  /*
   * The budget exists so the output can be injected into a context window
   * without being measured first. One record always comes back: a budget that
   * can return nothing is a budget that silently hides memory.
   */
  test("a budget too small for even one record still returns one", () => {
    const h = harness();
    try {
      h.run(["remember", "a record with a reasonably long summary to exceed a tiny budget"], {
        scope: "session",
      });
      const out = h.run(["recall"], { budget: "1" }).out;
      expect(out.match(/^## /gm)).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  test("the budget stops the second record and reports the omission", () => {
    const h = harness();
    try {
      const long = "x".repeat(400);
      h.run(["remember", `first ${long}`], { scope: "session", id: "one" });
      h.run(["remember", `second ${long}`], { scope: "session", id: "two" });
      const out = h.run(["recall"], { budget: "120" }).out;
      expect(out.match(/^## /gm)).toHaveLength(1);
      expect(out).toContain("1 further record(s) omitted");
    } finally {
      h.dispose();
    }
  });

  test("--json carries freshness and the generation it was read at", () => {
    const h = harness();
    try {
      h.file("src/a.ts", "a\n");
      h.run(["remember", "about a"], { scope: "session", source: "src/a.ts" });
      const parsed = JSON.parse(h.run(["recall"], { json: true }).out) as {
        generation: number;
        returned: number;
        records: { freshness: { path: string; state: string }[] }[];
      };
      expect(parsed.generation).toBe(0);
      expect(parsed.returned).toBe(1);
      expect(parsed.records[0]?.freshness[0]).toEqual({ path: "src/a.ts", state: "current" });
    } finally {
      h.dispose();
    }
  });
});
