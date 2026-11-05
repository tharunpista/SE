/**
 * Resolved project facts: the constants a role should never have to discover.
 *
 * 131 role definitions carry the literal text `<project test command>`. The
 * answer has been sitting in `package.json` the whole time. A placeholder is
 * not neutral: every hired role pays tool calls to re-derive a constant, and
 * the ones that guess wrong report a check they never ran.
 *
 * This module resolves what is knowable from committed metadata and says
 * nothing about what is not. A fact that cannot be read is omitted rather than
 * guessed -- an absent line is a question the role will ask, which is cheap,
 * while a wrong line is a command it will run, which is not.
 *
 * Deliberately *not* here: anything requiring the dependency tree to be
 * installed, or a network. `se/engineering/stack-discipline.md` already owns
 * the harder question of which API to call, and answers it by reading the
 * lockfile at the moment of use. This module answers only "what does this
 * project call its own scripts", which is committed, stable and cheap.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One resolved fact, with the file that proves it. */
export interface ProjectFact {
  readonly key: string;
  readonly value: string;
  /** Repository-relative path the value was read from. */
  readonly source: string;
}

export interface ProjectFacts {
  readonly facts: readonly ProjectFact[];
  /** Placeholder names this set can satisfy, for the validator. */
  readonly resolves: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Manifest -> runner mapping. The lockfile decides the runner, because the
 * manifest does not: a `package.json` says nothing about whether the operator
 * uses bun, pnpm, yarn or npm, and running the wrong one either fails outright
 * or silently resolves a different tree than CI used.
 */
const JS_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Script names worth surfacing, mapped to the placeholder they answer. Order
 * matters: the first alias present wins, so `check` is preferred over `test`
 * for the verification placeholder when a project defines an aggregate gate.
 */
const SCRIPT_FACTS: ReadonlyArray<{
  readonly key: string;
  readonly aliases: readonly string[];
  readonly placeholders: readonly string[];
}> = [
  { key: "test", aliases: ["test"], placeholders: ["project test command"] },
  { key: "validate", aliases: ["validate", "validate:policy"], placeholders: ["project-native policy validation command", "project schema validation command", "schema validate command"] },
  { key: "check", aliases: ["check", "ci", "verify"], placeholders: ["project verification command"] },
  { key: "typecheck", aliases: ["typecheck", "tsc", "types"], placeholders: ["project typecheck command"] },
  { key: "lint", aliases: ["lint"], placeholders: ["project lint command"] },
  { key: "build", aliases: ["build"], placeholders: ["project build command"] },
  { key: "coverage", aliases: ["coverage", "test:coverage"], placeholders: ["project coverage command"] },
  { key: "format", aliases: ["format", "fmt"], placeholders: ["project format command"] },
  { key: "start", aliases: ["start", "dev"], placeholders: ["project start command"] },
];

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A manifest that does not parse is a fact about the project, but not one
    // this module can act on. The caller reports it; it must not throw and
    // take a render down with it.
    return null;
  }
}

/** Resolve every fact readable from committed metadata at `root`. */
export function resolveProjectFacts(root: string): ProjectFacts {
  const facts: ProjectFact[] = [];
  const resolves: string[] = [];
  const warnings: string[] = [];

  const pkgPath = join(root, "package.json");
  const pkg = readJson(pkgPath);

  if (pkg === null) {
    if (existsSync(pkgPath)) warnings.push("package.json exists but does not parse; no script facts resolved.");
    else warnings.push("No package.json at the project root; script facts are unavailable.");
    return { facts, resolves, warnings };
  }

  // The runner comes from the lockfile, not from the manifest. Without one,
  // say so rather than assuming npm: a wrong runner is worse than no answer.
  const runner = JS_LOCKFILES.find(([file]) => existsSync(join(root, file)));
  if (runner === undefined) {
    warnings.push("No lockfile found; commands are reported without a runner prefix and may resolve a different dependency tree than CI.");
  } else {
    facts.push({ key: "runner", value: runner[1], source: runner[0] });
  }
  const prefix = runner ? `${runner[1]} run ` : "";

  const scripts = (pkg["scripts"] ?? {}) as Record<string, unknown>;
  for (const spec of SCRIPT_FACTS) {
    const name = spec.aliases.find((a) => typeof scripts[a] === "string");
    if (name === undefined) continue;
    /*
     * `bun test` is bun's own test runner, not a script invocation. Reporting
     * `bun run test` would work here only because this project happens to
     * define a `test` script that shells out to it; in a project that does not,
     * the same string fails. Prefer the runner's native subcommand where one
     * exists.
     */
    const value = runner?.[1] === "bun" && name === "test" ? "bun test" : `${prefix}${name}`;
    facts.push({ key: spec.key, value, source: "package.json#scripts" });
    resolves.push(...spec.placeholders);
  }

  // Runtime floor. A role that writes code against the wrong language version
  // produces output that reviews cleanly and fails on the operator's machine.
  const engines = (pkg["engines"] ?? {}) as Record<string, unknown>;
  for (const [name, range] of Object.entries(engines)) {
    if (typeof range !== "string") continue;
    facts.push({ key: `engine:${name}`, value: range, source: "package.json#engines" });
    resolves.push("project runtime version");
  }

  /*
   * Runner-derived commands: every JS package manager implements `audit`, so it
   * is resolvable from the lockfile alone without a declared script. This
   * matters because a role that hardcodes `bun audit` is wrong in every npm
   * project, and eighteen roles shipped a hardcoded runner before this existed.
   */
  if (runner !== undefined) {
    facts.push({ key: "audit", value: `${runner[1]} audit`, source: runner[0] });
    resolves.push("project dependency audit command");
  }

  const pm = pkg["packageManager"];
  if (typeof pm === "string") facts.push({ key: "packageManager", value: pm, source: "package.json#packageManager" });

  if (facts.every((f) => f.key !== "test" && f.key !== "check")) {
    warnings.push("No test or check script declared; roles that require evidence have no command to run and must ask the operator.");
  }

  return { facts, resolves, warnings };
}

/**
 * The injected block. Kept to a handful of lines on purpose: this is paid on
 * every hire, and a role needs the commands, not a description of them.
 */
export function renderFactsBlock(facts: ProjectFacts): string {
  if (facts.facts.length === 0) return "";
  const lines = facts.facts.map((f) => `${f.key}: ${f.value}`);
  return [
    "**Project facts.** Resolved from committed metadata. These are the real",
    "commands for this project; do not re-derive them, and do not substitute a",
    "convention from another project.",
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    "A fact absent from this list was not resolvable: ask rather than guess, and",
    "never report a check you did not run.",
  ].join("\n");
}

/**
 * Is this command's binary actually on PATH?
 *
 * A verification command naming a tool nobody installed is the same defect as
 * an unresolved `<project test command>` placeholder wearing better clothes:
 * the role is handed a gate it cannot run, and either reports a check it never
 * performed or silently drops it. Measured on this machine: `semgrep` and
 * `gitleaks` are named by eleven security roles and neither is installed.
 *
 * Checked by probing PATH directly rather than shelling out, because this runs
 * once per render for every command in the roster and a subprocess per probe
 * would dominate the render.
 */
const PATH_CACHE = new Map<string, boolean>();

export function commandAvailable(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  if (first === undefined || first.length === 0) return false;

  // A placeholder or a path-qualified script is not a PATH lookup. `./gradlew`
  // exists per project, so its absence here says nothing about the consumer.
  if (first.startsWith("<") || first.includes("/") || first.includes("\\")) return true;

  const cached = PATH_CACHE.get(first);
  if (cached !== undefined) return cached;

  const pathVar = process.env["PATH"] ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  // On Windows a bare name resolves against PATHEXT, so each extension is tried.
  const exts = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  let found = false;
  for (const dir of pathVar.split(sep)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, first + ext))) { found = true; break; }
    }
    if (found) break;
  }
  PATH_CACHE.set(first, found);
  return found;
}
