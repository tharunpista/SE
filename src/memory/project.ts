/**
 * Part XX 23. Project identity.
 *
 * Memory is namespaced by project, and the namespace has to be *stable*: if the
 * id changes, the project silently gets an empty memory and every record
 * written before the change becomes unreachable. Deriving it from the directory
 * name is therefore not acceptable, even though it usually works -- renaming a
 * folder, or cloning to a different path, orphans the memory with no error.
 *
 * Section 23 requires an explicit answer: resolve from reliable metadata, or
 * ask. Do not guess. This module does exactly that, and refuses rather than
 * inventing an identity.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { seHome } from "../util/paths.ts";

export const PROJECT_CONFIG_PATH = join(".se", "project.json");

export type IdentitySource = "flag" | "env" | "config" | "git-remote" | "package-name";

export interface ProjectIdentity {
  /** Directory-safe, stable, used as the memory namespace. */
  readonly id: string;
  /** Human-facing name. Never used as the namespace. */
  readonly label: string;
  readonly source: IdentitySource;
  /** Where the identity came from, for provenance in `se memory status`. */
  readonly origin?: string;
}

interface ProjectConfig {
  readonly schema_version: 1;
  readonly id: string;
  readonly label?: string;
  readonly origin?: string;
}

/**
 * Raised when no reliable metadata establishes the project. Carries the
 * instruction to fix it, because "ambiguous project" with no next step is a
 * dead end for whoever hits it.
 */
export class AmbiguousProjectError extends Error {
  constructor(readonly repoRoot: string) {
    super(
      `Cannot determine the project identity for ${repoRoot}.\n\n` +
        `Memory is namespaced per project, and an unstable namespace silently orphans ` +
        `every record written under the old one. Part XX 23 requires this to be resolved ` +
        `from reliable metadata rather than guessed at, so it is not inferred from the ` +
        `directory name.\n\n` +
        `Fix it once, and it is committed for every clone:\n` +
        `  se memory init                  # derive from the git remote\n` +
        `  se memory init --id <stable-id> # set one explicitly\n\n` +
        `Or override per command: --project <id>, or the SE_PROJECT environment variable.`,
    );
    this.name = "AmbiguousProjectError";
  }
}

/** Lower-case, dash-separated, safe as a single path segment. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug;
}

function requireProjectId(value: string, source: string): string {
  const id = slugify(value);
  if (!id) {
    throw new Error(`${source} does not produce a usable project id. Use letters or digits, for example --id my-project.`);
  }
  return id;
}

/**
 * Turn a git remote into a stable id. Two clones of the same repository resolve
 * to the same id regardless of where they sit on disk, which is the property
 * the directory name lacks.
 */
export function identityFromRemote(remote: string): { id: string; label: string } {
  // git@host:owner/repo.git | https://host/owner/repo.git | ssh://host/owner/repo
  const cleaned = remote
    .trim()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@]+@/, "")
    .replace(/:/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  const owner = parts.length >= 2 ? parts[parts.length - 2]! : "";
  const repo = parts[parts.length - 1] ?? "";
  const label = owner ? `${owner}/${repo}` : repo;
  return { id: requireProjectId(label || remote, "Git remote"), label };
}

function readGitRemote(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // No git, no origin, or not a repository. All mean "no reliable metadata".
    return null;
  }
}

/** The `name` field of the project's package.json, if it declares one. */
function readPackageName(repoRoot: string): string | null {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

export function readProjectConfig(repoRoot: string): ProjectConfig | null {
  const path = join(repoRoot, PROJECT_CONFIG_PATH);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${PROJECT_CONFIG_PATH} is not valid JSON: ${(cause as Error).message}`);
  }
  const config = parsed as ProjectConfig;
  if (config?.schema_version !== 1) {
    throw new Error(
      `${PROJECT_CONFIG_PATH} has unsupported schema_version ${String(config?.schema_version)}; expected 1.`,
    );
  }
  if (typeof config.id !== "string" || !config.id || slugify(config.id) !== config.id) {
    throw new Error(
      `${PROJECT_CONFIG_PATH} has id ${JSON.stringify(config.id)}, which is not a valid namespace. ` +
        `Use lower-case letters, digits and dashes.`,
    );
  }
  return config;
}

export interface ResolveOptions {
  /** From --project. Highest precedence: an operator saying so explicitly. */
  readonly flag?: string | undefined;
  /** Defaults to process.env, injectable for tests. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Resolve the project identity, in precedence order. Throws
 * AmbiguousProjectError when nothing reliable establishes it.
 */
export function resolveProject(repoRoot: string, options: ResolveOptions = {}): ProjectIdentity {
  const env = options.env ?? process.env;

  if (options.flag) {
    return { id: requireProjectId(options.flag, "--project"), label: options.flag, source: "flag" };
  }

  const fromEnv = env["SE_PROJECT"];
  if (fromEnv) {
    return { id: requireProjectId(fromEnv, "SE_PROJECT"), label: fromEnv, source: "env" };
  }

  const config = readProjectConfig(repoRoot);
  if (config) {
    return {
      id: config.id,
      label: config.label ?? config.id,
      source: "config",
      ...(config.origin ? { origin: config.origin } : {}),
    };
  }

  const remote = readGitRemote(repoRoot);
  if (remote) {
    const { id, label } = identityFromRemote(remote);
    return { id, label, source: "git-remote", origin: remote };
  }

  /*
   * A declared package name is committed metadata, not an inference from the
   * filesystem, so it satisfies section 23's "reliable metadata" where the
   * directory name does not. It is weaker than a remote -- two unrelated
   * projects can both be called "app" -- so it is reported as unpinned and
   * ranked last.
   */
  const packaged = readPackageName(repoRoot);
  if (packaged) {
    return {
      id: requireProjectId(packaged, "package.json name"),
      label: packaged,
      source: "package-name",
      origin: "package.json#name",
    };
  }

  // Deliberately not falling back to the directory name.
  throw new AmbiguousProjectError(repoRoot);
}

export type MemoryRootSource = "flag" | "env" | "repo-local" | "global";

export interface MemoryLocation {
  readonly root: string;
  readonly source: MemoryRootSource;
}

/** Repo-local Tier 0, private to one checkout and ignored by Git. */
export const REPO_LOCAL_MEMORY_DIR = "memory";

const MEMORY_IGNORE_START = "# BEGIN se local-memory runtime exclusion";
const MEMORY_IGNORE_END = "# END se local-memory runtime exclusion";
const MEMORY_IGNORE_BLOCK = [
  MEMORY_IGNORE_START,
  "*",
  "!.gitignore",
  "!.gitkeep",
  MEMORY_IGNORE_END,
].join("\n");

/**
 * Ensure an opted-in checkout-local store is not accidentally added to Git.
 * The rule lives beside the data so `se memory init --local` is safe in any
 * consuming repository, not only in this CLI's own checkout. Preserve existing
 * user rules and append one marked, idempotent block.
 */
export function ensureRepoLocalMemoryGitignore(repoRoot: string): { path: string; changed: boolean } {
  const memoryDir = join(repoRoot, REPO_LOCAL_MEMORY_DIR);
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const hasStart = existing.includes(MEMORY_IGNORE_START);
  const hasEnd = existing.includes(MEMORY_IGNORE_END);

  if (hasStart && hasEnd) return { path, changed: false };
  if (hasStart || hasEnd) {
    throw new Error(`Cannot safely update ${path}: found an incomplete se-managed ignore block.`);
  }

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${MEMORY_IGNORE_BLOCK}\n`, "utf8");
  return { path, changed: true };
}

/**
 * Where this project's Tier 0 lives.
 *
 * Two placements are legitimate and they trade off against each other:
 *
 *   repo-local  `<project>/memory/` --- private to this checkout, useful for
 *               keeping memory beside one working copy. Git ignores it.
 *   global      `~/.se/memory/` --- works in every project with no setup, and
 *               survives the project directory being moved or re-cloned, but is
 *               personal: nothing is shared and nothing is reviewed.
 *
 * Global is the default because a globally installed CLI is used across many
 * projects, most of which will never opt in to checkout-local memory, and a tool
 * that silently writes an uncommitted `memory/` directory into every repository
 * it touches is worse than one that keeps personal state in one place.
 *
 * A project opts in to checkout-local placement simply by having the directory:
 * `se memory init --local` creates it. Runtime records remain ignored by Git;
 * repo-local placement is not a mechanism for team sharing.
 */
export function resolveMemoryLocation(
  repoRoot: string,
  options: { flag?: string | undefined; env?: Record<string, string | undefined> } = {},
): MemoryLocation {
  const env = options.env ?? process.env;

  if (options.flag) {
    const root = isAbsolute(options.flag) ? options.flag : join(repoRoot, options.flag);
    return { root, source: "flag" };
  }

  const fromEnv = env["SE_MEMORY_ROOT"];
  if (fromEnv) {
    const root = isAbsolute(fromEnv) ? fromEnv : join(repoRoot, fromEnv);
    return { root, source: "env" };
  }

  const repoLocal = join(repoRoot, REPO_LOCAL_MEMORY_DIR);
  if (existsSync(repoLocal)) {
    return { root: repoLocal, source: "repo-local" };
  }

  return { root: join(seHome(), "memory"), source: "global" };
}

export interface InitResult {
  readonly identity: ProjectIdentity;
  readonly path: string;
  readonly created: boolean;
}

/**
 * Write `.se/project.json`, pinning the identity for every clone. Committed on
 * purpose: a project id that differs per checkout is the problem this solves.
 */
export function initProject(repoRoot: string, explicitId?: string): InitResult {
  const path = join(repoRoot, PROJECT_CONFIG_PATH);
  const existing = readProjectConfig(repoRoot);
  if (existing && !explicitId) {
    return {
      identity: {
        id: existing.id,
        label: existing.label ?? existing.id,
        source: "config",
        ...(existing.origin ? { origin: existing.origin } : {}),
      },
      path,
      created: false,
    };
  }

  let id: string;
  let label: string;
  let origin: string | undefined;

  if (explicitId) {
    id = requireProjectId(explicitId, "--id");
    label = explicitId;
  } else {
    const remote = readGitRemote(repoRoot);
    if (remote) {
      const derived = identityFromRemote(remote);
      id = derived.id;
      label = derived.label;
      origin = remote;
    } else {
      const packaged = readPackageName(repoRoot);
      if (!packaged) {
        throw new Error(
          `Nothing to derive a project id from: no git remote "origin" and no name in package.json.\n` +
            `Pass one explicitly: se memory init --id <stable-id>`,
        );
      }
      id = requireProjectId(packaged, "package.json name");
      label = packaged;
      origin = "package.json#name";
    }
  }

  const config: ProjectConfig = {
    schema_version: 1,
    id,
    label,
    ...(origin ? { origin } : {}),
  };

  mkdirSync(join(repoRoot, ".se"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    identity: { id, label, source: "config", ...(origin ? { origin } : {}) },
    path,
    created: true,
  };
}
