import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRoles } from "../src/roles/resolve.ts";
import { checkIntegrity } from "../src/roles/integrity.ts";
import type { Registry } from "../src/roles/resolve.ts";
import type { Diagnostic } from "../src/util/diagnostics.ts";

export interface TempRepo {
  readonly root: string;
  /** Write a file into the builtin layer: se/agents/<dept>/<name>. */
  builtin(relPath: string, contents: string): void;
  /** Write into the user-global override layer. */
  user(relPath: string, contents: string): void;
  /** Write into the project-local layer: .se/roles/<name>. */
  project(relPath: string, contents: string): void;
  resolve(): Registry;
  /** Resolve plus every catalogue-wide integrity check. */
  check(): { registry: Registry; diagnostics: readonly Diagnostic[] };
  dispose(): void;
}

function put(root: string, relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/**
 * Creates an isolated repo per test. SE_HOME is redirected into the temp
 * tree so a test can never read, or write to, the developer's real
 * ~/.se overrides -- a test suite that touches real user state is a test
 * suite that eventually destroys it.
 */
export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "se-test-"));
  const seHome = join(root, "fake-home", ".se");
  mkdirSync(join(seHome, "overrides", "roles"), { recursive: true });
  mkdirSync(join(root, "se", "agents"), { recursive: true });

  const priorSeHome = process.env["SE_HOME"];
  process.env["SE_HOME"] = seHome;

  const repo: TempRepo = {
    root,
    builtin: (p, c) => put(root, join("se", "agents", p), c),
    user: (p, c) => put(seHome, join("overrides", "roles", p), c),
    project: (p, c) => put(root, join(".se", "roles", p), c),
    resolve: () => resolveRoles(root),
    check: () => {
      const registry = resolveRoles(root);
      const integrity = checkIntegrity(registry);
      registry.diagnostics.absorb(integrity.diagnostics);
      return { registry, diagnostics: registry.diagnostics.sorted() };
    },
    dispose: () => {
      if (priorSeHome === undefined) delete process.env["SE_HOME"];
      else process.env["SE_HOME"] = priorSeHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
  return repo;
}

export interface RoleOverrides {
  readonly [key: string]: unknown;
}

/**
 * Build a minimal valid role file. Tests then override exactly the one key
 * under test, so a failure points at that key rather than at boilerplate.
 */
export function roleFile(id: string, overrides: RoleOverrides = {}, body?: string): string {
  const fm: Record<string, unknown> = {
    schema_version: 1,
    id,
    name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    department: "orchestration",
    tier: "catalogue",
    mission: `Own a bounded slice of work for the purposes of the ${id} test fixture.`,
    activation: ["a project fact that activates this fixture role"],
    tools: ["read-files"],
    memory_scopes: { read: ["session", "project"], write: ["session"] },
    owns_artifacts: [],
    owns_interfaces: [],
    collaborators: [],
    escalates_to: "operator",
    context_budget_tokens: 20000,
    max_calls: 5,
    enabled: true,
    // A role that writes files and requires evidence must declare a
    // verification command, so the default fixture carries one. Tests that
    // exercise that rule override it explicitly.
    verify_commands: ["<project test command>"],
    ...overrides,
  };

  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  lines.push(body ?? `# ${id}\n\nFixture role with a real body so the placeholder check passes.`);
  return lines.join("\n");
}

export function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export function hasCode(diagnostics: readonly Diagnostic[], code: string): boolean {
  return diagnostics.some((d) => d.code === code);
}

/** Diagnostics excluding catalogue-size errors, which every small fixture trips. */
export function relevant(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(
    (d) => d.code !== "catalogue/total-count" && d.code !== "catalogue/department-count",
  );
}
