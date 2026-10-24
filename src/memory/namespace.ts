/**
 * Namespace claims: which directories have used a given project id.
 *
 * Project identity (Part XX 23) is resolved from metadata rather than from the
 * directory name, which stops a rename from orphaning memory. It does not stop
 * the opposite failure: two unrelated projects agreeing on an id. A package
 * called `app` in two different checkouts resolves to one namespace, and both
 * read and write the same records with nothing reporting it.
 *
 * That failure is silent and it is the dangerous direction. Reading another
 * project's decisions is worse than reading none, because an empty store is
 * obviously empty while a populated one looks authoritative.
 *
 * So every resolution records the directory that claimed the namespace, and a
 * claim arriving from an unexpected directory is reported. The ledger is
 * advisory: it never blocks a command, because a false positive that stops work
 * is worse than a warning that is occasionally ignored. It lives beside the
 * store rather than in the project, so it survives the checkout being deleted
 * and cannot be committed by accident.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storedJson } from "./manifest.ts";
import type { IdentitySource } from "./project.ts";

export const CLAIMS_FILE = "claims.json";

/** One directory's use of a namespace. */
export interface NamespaceClaim {
  /** Absolute path of the project root that resolved to this namespace. */
  readonly path: string;
  readonly identity_source: IdentitySource;
  /** What the identity was derived from, when the source records one. */
  readonly origin?: string;
  /**
   * `git remote get-url origin`, when there is one. Two checkouts of the same
   * repository share a remote, which is what distinguishes a second clone from
   * an unrelated project that happens to agree on a name.
   */
  readonly git_remote?: string;
  readonly first_seen: string;
  readonly last_seen: string;
}

export interface ClaimsLedger {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly claims: readonly NamespaceClaim[];
}

/**
 * `new`        nothing had claimed this namespace.
 * `known`      this directory has claimed it before.
 * `shared`     other directories use it, and the evidence says deliberately
 *              (a pinned id, or a matching git remote: a second clone).
 * `ambiguous`  other directories use it and nothing ties them together. This is
 *              the collision case, and the only one worth interrupting over.
 */
export type ClaimStatus = "new" | "known" | "shared" | "ambiguous";

export interface ClaimReport {
  readonly status: ClaimStatus;
  readonly projectId: string;
  /** Claims from directories other than the one just resolved. */
  readonly others: readonly NamespaceClaim[];
  /** Set when this directory has claimed the namespace before under another id. */
  readonly previousIdentitySource?: IdentitySource;
}

function claimsPath(memoryRoot: string, projectId: string): string {
  return join(memoryRoot, projectId, CLAIMS_FILE);
}

/**
 * The ledger, or null when absent. A damaged ledger returns null rather than
 * throwing: it is advisory metadata, and refusing to read memory because a
 * warning file is malformed would be a worse outcome than losing the warning.
 */
export function readClaims(memoryRoot: string, projectId: string): ClaimsLedger | null {
  const path = claimsPath(memoryRoot, projectId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaimsLedger;
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.claims)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeClaims(memoryRoot: string, projectId: string, ledger: ClaimsLedger): void {
  const dir = join(memoryRoot, projectId);
  mkdirSync(dir, { recursive: true });
  const target = claimsPath(memoryRoot, projectId);
  // Staged then renamed: a torn claims file would be unreadable, and an
  // unreadable ledger silently disables the collision warning.
  const staging = join(dir, `.${CLAIMS_FILE}.tmp.${process.pid}.${randomUUID()}`);
  writeFileSync(staging, storedJson(ledger), "utf8");
  renameSync(staging, target);
}

/** `git remote get-url origin`, or undefined when there is no repository. */
export function readRemote(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An id the operator stated or committed is a deliberate choice, so two
 * directories sharing it is intentional. An id merely derived from a package
 * name is a guess that happened to agree, and that is the case worth reporting.
 */
function isDeliberate(source: IdentitySource): boolean {
  return source === "flag" || source === "env" || source === "config";
}

export interface RecordClaimOptions {
  readonly memoryRoot: string;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly identitySource: IdentitySource;
  readonly origin?: string | undefined;
  readonly now?: () => Date;
  /** Injected so tests need no repository. */
  readonly remote?: string | undefined;
  /** When false, the ledger is read and classified but not written. */
  readonly persist?: boolean;
}

/**
 * Record that `repoRoot` used `projectId`, and classify what that means.
 *
 * Writing the ledger is best-effort. A read-only or full disk must not fail a
 * memory read, so a failure here degrades to the classification alone.
 */
export function recordClaim(options: RecordClaimOptions): ClaimReport {
  const { memoryRoot, projectId, repoRoot, identitySource } = options;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const remote = options.remote !== undefined ? options.remote : readRemote(repoRoot);

  const existing = readClaims(memoryRoot, projectId);
  const previous = existing?.claims.find((c) => c.path === repoRoot);
  const others = (existing?.claims ?? []).filter((c) => c.path !== repoRoot);

  const mine: NamespaceClaim = {
    path: repoRoot,
    identity_source: identitySource,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(remote === undefined ? {} : { git_remote: remote }),
    first_seen: previous?.first_seen ?? now,
    last_seen: now,
  };

  if (options.persist !== false) {
    try {
      writeClaims(memoryRoot, projectId, {
        schema_version: 1,
        project_id: projectId,
        // Newest claim last, so the file reads chronologically.
        claims: [...others, mine],
      });
    } catch {
      // Advisory metadata only. Never fail a memory operation over it.
    }
  }

  const status = classify(identitySource, remote, previous !== undefined, others);
  return {
    status,
    projectId,
    others,
    ...(previous === undefined ? {} : { previousIdentitySource: previous.identity_source }),
  };
}

function classify(
  identitySource: IdentitySource,
  remote: string | undefined,
  seenBefore: boolean,
  others: readonly NamespaceClaim[],
): ClaimStatus {
  if (others.length === 0) return seenBefore ? "known" : "new";

  // A stated or committed id is a deliberate choice; so is a remote shared with
  // every other claimant, which is simply a second clone of one repository.
  if (isDeliberate(identitySource)) return "shared";
  if (remote !== undefined && others.every((c) => c.git_remote === remote)) return "shared";

  return "ambiguous";
}

/**
 * Operator-facing lines for a report, or an empty array when there is nothing
 * worth saying. Returned rather than printed so the caller decides the stream:
 * an ambiguity belongs on stderr, where it is visible even when stdout is piped
 * into another tool.
 */
export function describeClaim(report: ClaimReport, repoRoot: string): string[] {
  if (report.status !== "ambiguous") return [];

  const lines = [
    `warning: the memory namespace "${report.projectId}" is also used by ` +
      `${report.others.length} other director${report.others.length === 1 ? "y" : "ies"}, ` +
      `and nothing links them to this one.`,
    "",
    `  this directory:  ${repoRoot}`,
  ];
  for (const other of report.others) {
    lines.push(`  also claimed by: ${other.path}  (last used ${other.last_seen.slice(0, 10)})`);
  }
  lines.push(
    "",
    "  The id was derived from a package name, so two unrelated projects can",
    "  agree on it and then share one store. Records written in one appear in",
    "  the other, which looks authoritative and is wrong.",
    "",
    "  Give this project its own namespace, committed for every clone:",
    "    se memory init --id <stable-id>",
    "",
    "  Or confirm the sharing is intended by pinning the same id in both.",
  );
  return lines;
}
