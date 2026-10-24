import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** `~/.se`, or `SE_HOME` when set. Holds user-global overrides and config. */
export function seHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env["SE_HOME"];
  // SE_HOME is a user-level location, so a relative override is relative to the
  // user's home, never to whichever project happens to be the current cwd.
  return configured ? resolve(homedir(), configured) : join(homedir(), ".se");
}

export const GLOBAL_CONFIG_PATH = "config.json";

interface GlobalConfig {
  readonly schema_version: 1;
  /** Absolute path to the repository holding the role catalogue. */
  readonly catalogue_root: string;
}

/**
 * Where the role catalogue lives, which is a different question from where the
 * user is working.
 *
 * `findRepoRoot` answers "am I inside the se repository", and the two were
 * originally the same thing because every command ran from inside it. Once the
 * CLI is installed globally they diverge: the catalogue stays in one place while
 * the project being worked on is wherever the user is. Conflating them means
 * either the roles cannot be found, or project memory gets written into the
 * catalogue repository -- both silent.
 *
 * Resolution order, most explicit first:
 *   1. `SE_CATALOGUE` --- an operator saying so for this invocation.
 *   2. Walking up from the cwd --- working inside the catalogue repo itself.
 *   3. `~/.se/config.json` --- registered once by `se link`.
 */
export function findCatalogueRoot(from = process.cwd()): string | null {
  const fromEnv = process.env["SE_CATALOGUE"];
  if (fromEnv && isCatalogueRoot(fromEnv)) return resolve(fromEnv);

  const local = findRepoRoot(from);
  if (local) return local;

  const config = readGlobalConfig();
  if (config && isCatalogueRoot(config.catalogue_root)) return resolve(config.catalogue_root);

  return null;
}

/**
 * The root of the project being worked on, which is where rendered host
 * integrations and project memory belong.
 *
 * Distinct from the catalogue root. With the CLI installed globally these are
 * usually different directories, and anchoring output on the catalogue root
 * instead would write one project's agents into the catalogue repository.
 */
export function findProjectRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    // No marker anywhere up the tree: the cwd is the best available answer.
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** A directory is a catalogue root when it carries the specification tree. */
export function isCatalogueRoot(dir: string): boolean {
  return existsSync(join(dir, "se", "agents")) && existsSync(join(dir, "package.json"));
}

export function readGlobalConfig(env: Record<string, string | undefined> = process.env): GlobalConfig | null {
  const path = join(seHome(env), GLOBAL_CONFIG_PATH);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GlobalConfig>;
    if (
      parsed?.schema_version !== 1 ||
      typeof parsed.catalogue_root !== "string" ||
      !isAbsolute(parsed.catalogue_root)
    ) return null;
    return parsed as GlobalConfig;
  } catch {
    // A corrupt global config must not break a command that can resolve the
    // catalogue another way; `se link` reports and rewrites it.
    return null;
  }
}

/** Register a catalogue root for use from any directory. */
export function writeGlobalConfig(catalogueRoot: string, env: Record<string, string | undefined> = process.env): string {
  const home = seHome(env);
  mkdirSync(home, { recursive: true });
  const path = join(home, GLOBAL_CONFIG_PATH);
  const config: GlobalConfig = { schema_version: 1, catalogue_root: resolve(catalogueRoot) };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
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
    userOverrides: join(seHome(), "overrides", "roles"),
    projectRoles: join(root, ".se", "roles"),
  };
}

/** Tier 2 run state. Outside the source tree, never committed. Part XX 70. */
export function stateRoot(root: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env["SE_STATE_ROOT"];
  return configured ? resolve(root, configured) : join(root, ".se", "state");
}
