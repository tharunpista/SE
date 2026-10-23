import { dirname, join, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Forward-slash a path for display and for use as a stable key on any OS. */
export function posix(p: string): string {
  return p.split(sep).join("/");
}

export function repoRelative(root: string, abs: string): string {
  return posix(relative(root, abs));
}

/**
 * Walk up for the repo marker. Anchoring on package.json alone is wrong in a
 * monorepo; we require the se/ specification directory to be present too.
 */
export function findRepoRoot(from = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "se"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LayerPaths {
  /** Lowest precedence: roles shipped with the project. */
  readonly builtin: string;
  /** User-global overrides, applied over builtin. */
  readonly userOverrides: string;
  /** Project-local roles, highest precedence. */
  readonly projectRoles: string;
}

/**
 * Resolution order, lowest precedence first. A local layer may override
 * individual keys, disable a role, or introduce a new one, and never
 * modifies the shipped files. Part IV 7.3.
 */
export function layerPaths(root: string): LayerPaths {
  return {
    builtin: join(root, "se", "agents"),
    userOverrides: join(process.env["SE_HOME"] ?? join(homedir(), ".se"), "overrides", "roles"),
    projectRoles: join(root, ".se", "roles"),
  };
}

/** Tier 2 run state. Outside the source tree, never committed. Part XX 70. */
export function stateRoot(root: string): string {
  return process.env["SE_STATE_ROOT"] ?? join(root, ".se", "state");
}
