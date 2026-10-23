/**
 * Where a host looks for role definitions, and what is actually there.
 *
 * This module exists because of a specific, expensive failure mode: `se render`
 * reported success, the operator restarted the host, and the roles did not
 * appear. Every part of that is working as designed -- the render wrote real
 * files to a real directory -- and none of it tells the operator the one thing
 * they need, which is *which* directory the session they are sitting in will
 * read. The render anchors output on the nearest ancestor holding `package.json`
 * or `.git`, and that is not necessarily the directory the host opened as its
 * root. When the two differ, a correct render is invisible.
 *
 * So the question is made answerable directly: enumerate every location the host
 * consults for a session rooted at a given directory, report what each one
 * holds, and distinguish files this tool generated from files it did not. A
 * "rendered 11 roles" line is a claim about this process; this is a claim about
 * what the host will load, which is what was actually being asked.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostAdapter } from "./host.ts";
import type { Role } from "../roles/types.ts";

/** Written into every rendered definition by the adapters. */
const GENERATED_MARKER = "GENERATED from se/agents/";
const ROLE_HASH = /Role hash:\s*([0-9a-f]+)/;

export interface InstalledDefinition {
  readonly name: string;
  readonly roleId: string;
  /** The role hash recorded in the file when it was rendered. */
  readonly hash: string | null;
  /**
   * True when the catalogue's current role no longer matches the hash the file
   * was rendered from. The host loads the file regardless, so drift is silent:
   * the operator is running a role definition they have since edited.
   */
  readonly stale: boolean;
}

export interface Site {
  /** `project` is read only for sessions rooted at or under `projectRoot`. */
  readonly kind: "project" | "user";
  readonly dir: string;
  readonly exists: boolean;
  /** Definitions this tool generated, which a later render may replace. */
  readonly generated: readonly InstalledDefinition[];
  /** Files this tool did not write. Never touched by a render; reported so a
   *  hand-written definition is not mistaken for a missing one. */
  readonly foreign: readonly string[];
  /**
   * Precedence among sites that both apply, lower wins the name clash. The host
   * resolves a duplicate name in favour of the more specific location, so a
   * project definition shadows a user-level one of the same name.
   */
  readonly precedence: number;
}

function inspect(
  dir: string,
  kind: Site["kind"],
  precedence: number,
  roleHashes: ReadonlyMap<string, string>,
): Site {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { kind, dir, exists: false, generated: [], foreign: [], precedence };
  }

  const generated: InstalledDefinition[] = [];
  const foreign: string[] = [];

  const definitionFiles: string[] = [];
  const collectFiles = (current: string, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collectFiles(join(current, entry.name), relative);
      else if (entry.isFile()) definitionFiles.push(relative);
    }
  };
  collectFiles(dir);
  for (const name of definitionFiles) {
    // Native host formats are Markdown for Claude/Cursor/Antigravity and TOML
    // for Codex. Ignoring TOML makes `where --host codex` report zero installed
    // roles immediately after a successful render, which is indistinguishable
    // from the original discovery failure.
    if (!/\.(?:md|toml)$/.test(name)) continue;
    let contents: string;
    try {
      contents = readFileSync(join(dir, name), "utf8");
    } catch {
      // Unreadable is not the same as absent, and guessing either way misleads.
      foreign.push(name);
      continue;
    }
    if (!contents.includes(GENERATED_MARKER)) {
      foreign.push(name);
      continue;
    }
    // VS Code's native custom-agent suffix is `.agent.md`; strip it as one
    // extension or `where --host copilot` reports every definition as an
    // orphan (`backend-lead.agent`) even though the host loads it correctly.
    const skillMatch = /^([^/]+)\/SKILL\.md$/i.exec(name);
    const roleId = skillMatch?.[1] ?? name.replace(/\.agent\.md$/i, "").replace(/\.(?:md|toml)$/i, "");
    const hash = ROLE_HASH.exec(contents)?.[1] ?? null;
    const current = roleHashes.get(roleId);
    generated.push({
      name,
      roleId,
      hash,
      // Unknown on either side is not drift: a role removed from the catalogue
      // is reported separately, and a file with no recorded hash predates the
      // marker rather than disagreeing with it.
      stale: hash !== null && current !== undefined && current !== hash,
    });
  }

  return { kind, dir, exists: true, generated, foreign, precedence };
}

/**
 * Every location this host reads, most specific first.
 *
 * `projectRoot` is the directory the host has open, not the catalogue: those are
 * different roots and conflating them is the bug this whole module reports on.
 */
export function hostSites(
  adapter: HostAdapter,
  projectRoot: string,
  roles: readonly Role[],
): Site[] {
  const roleHashes = new Map(roles.map((r) => [r.id, r.hash] as const));
  const sites: Site[] = [inspect(join(projectRoot, adapter.defaultOut), "project", 0, roleHashes)];
  if (adapter.userOut !== null) {
    sites.push(inspect(adapter.userOut, "user", 1, roleHashes));
  }
  return sites;
}

/**
 * Which role ids the host will actually load, after precedence is applied.
 *
 * A name present in two sites is loaded once, from the more specific one. The
 * shadowed copy is not a second role and must not be counted as one, or a
 * roster of eleven reports as twenty-two.
 */
export function effectiveRoster(sites: readonly Site[]): Map<string, Site> {
  const winner = new Map<string, Site>();
  for (const site of [...sites].sort((a, b) => a.precedence - b.precedence)) {
    for (const def of site.generated) {
      if (!winner.has(def.roleId)) winner.set(def.roleId, site);
    }
  }
  return winner;
}
