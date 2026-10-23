/**
 * Part XX 80. The invariant diagnostic.
 *
 * Two rules govern this module:
 *
 *   1. A failing invariant is a build failure, not a logged warning.
 *   2. An invariant that cannot be checked yet reports `not-implemented`. It is
 *      never reported as passing. A diagnostic that claims a check it did not
 *      run is worse than having no diagnostic, because it converts an unknown
 *      into a false assurance.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  hashContent,
  listGenerations,
  manifestDir,
  manifestHash,
  readGeneration,
  readLiveManifest,
  recordsDir,
  type Manifest,
} from "./manifest.ts";
import { findSecrets } from "./redact.ts";
import type { MemoryRecord } from "./types.ts";

/**
 * `repairable` is distinct from `fail` on purpose. Part XX 72's crash table
 * states that a crash between steps 5 and 6 leaves an orphan version file, so an
 * orphan is an expected post-crash residue, not corruption: the invariant that
 * matters is that it is never visible or silently adopted. Treating it as a
 * failure would turn every interrupted write into a red build and teach the
 * operator to ignore the diagnostic.
 */
export type InvariantStatus = "pass" | "fail" | "repairable" | "not-implemented";

export interface InvariantResult {
  /** Numbering follows Part XX 80 so a failure can be traced to the requirement. */
  readonly id: string;
  readonly name: string;
  readonly status: InvariantStatus;
  readonly findings: readonly string[];
  /** Present for `not-implemented`: what is missing and why it is not a pass. */
  readonly blocked_on?: string;
}

export interface DoctorReport {
  readonly project_id: string;
  readonly generation: number;
  readonly record_count: number;
  readonly invariants: readonly InvariantResult[];
  /** False when any invariant failed. Drives the process exit code. */
  readonly ok: boolean;
  /** Invariants that could not be checked. Visible, and never counted as passes. */
  readonly incomplete: number;
  /** Residue a repair step can collect. Reported, but not a build failure. */
  readonly repairable: number;
}

interface Context {
  readonly memoryRoot: string;
  readonly projectId: string;
  readonly manifests: string;
  readonly records: string;
  readonly live: Manifest | null;
  /** Source tree root, for resolving a record's source references. */
  readonly sourceRoot: string;
}

function pass(id: string, name: string): InvariantResult {
  return { id, name, status: "pass", findings: [] };
}

function result(id: string, name: string, findings: readonly string[]): InvariantResult {
  return { id, name, status: findings.length === 0 ? "pass" : "fail", findings };
}

function notImplemented(id: string, name: string, blockedOn: string): InvariantResult {
  return { id, name, status: "not-implemented", findings: [], blocked_on: blockedOn };
}

/** Residue that a repair step can collect, rather than a violated guarantee. */
function repairable(id: string, name: string, findings: readonly string[]): InvariantResult {
  return { id, name, status: findings.length === 0 ? "pass" : "repairable", findings };
}

function readRecord(ctx: Context, recordId: string, revision: number): MemoryRecord | null {
  const path = join(ctx.records, recordId, `v${revision}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MemoryRecord;
  } catch {
    return null;
  }
}

/** Version numbers present on disk for a record, ascending. */
function versionsOnDisk(ctx: Context, recordId: string): number[] {
  const dir = join(ctx.records, recordId);
  if (!existsSync(dir)) return [];
  const found: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^v(\d+)\.json$/.exec(name);
    if (match) found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

/** Invariant 1: every live pointer resolves to a parseable, schema-valid version. */
function checkPointersResolve(ctx: Context): InvariantResult {
  const name = "Every live entry references an existing, parseable, schema-valid version";
  if (!ctx.live) return pass("80.1", name);
  const findings: string[] = [];

  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    const path = join(ctx.records, recordId, `v${entry.revision}.json`);
    if (!existsSync(path)) {
      findings.push(`${recordId}: manifest names revision ${entry.revision} but ${path} is missing`);
      continue;
    }
    let record: MemoryRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as MemoryRecord;
    } catch (cause) {
      findings.push(`${recordId} v${entry.revision}: unparseable (${(cause as Error).message})`);
      continue;
    }
    if (record.schema_version !== 1) {
      findings.push(`${recordId} v${entry.revision}: unsupported schema_version ${String(record.schema_version)}`);
    }
    if (record.revision !== entry.revision) {
      findings.push(`${recordId} v${entry.revision}: file declares revision ${record.revision}`);
    }
    // The manifest carries the hash so drift is detectable without trusting the index.
    const actual = hashContent(canonicalJson(record));
    if (actual !== entry.hash) {
      findings.push(`${recordId} v${entry.revision}: content hash differs from the manifest (file edited in place?)`);
    }
    if (record.status !== entry.status) {
      findings.push(`${recordId}: manifest says "${entry.status}", record says "${record.status}"`);
    }
  }
  return result("80.1", name, findings);
}

/** Invariant 2: revisions are gapless and monotonic. */
function checkRevisionsGapless(ctx: Context): InvariantResult {
  const name = "Revision numbers per record are gapless and monotonic";
  if (!ctx.live) return pass("80.2", name);
  const findings: string[] = [];

  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    const versions = versionsOnDisk(ctx, recordId);
    if (versions.length === 0) {
      findings.push(`${recordId}: no version files on disk`);
      continue;
    }
    for (let i = 0; i < versions.length; i++) {
      if (versions[i] !== i + 1) {
        findings.push(`${recordId}: versions ${versions.join(", ")} are not gapless from v1`);
        break;
      }
    }
    if (entry.revision > versions[versions.length - 1]!) {
      findings.push(`${recordId}: manifest revision ${entry.revision} exceeds the highest file v${versions[versions.length - 1]}`);
    }
  }
  return result("80.2", name, findings);
}

/**
 * Invariant 3: no orphan version files beyond the pointer without adoption.
 *
 * An orphan is the expected residue of a crash between steps 5 and 6 (Part XX
 * 72's crash table), so its presence is reported rather than treated as
 * corruption -- but it must never be silently adopted as live.
 */
function checkNoOrphans(ctx: Context): InvariantResult {
  const name = "No orphan version files beyond the live pointer without explicit adoption";
  const findings: string[] = [];
  if (!existsSync(ctx.records)) return pass("80.3", name);

  for (const recordId of readdirSync(ctx.records)) {
    const entry = ctx.live?.entries[recordId];
    const versions = versionsOnDisk(ctx, recordId);
    const liveRevision = entry?.revision ?? 0;
    const orphans = versions.filter((v) => v > liveRevision);
    if (orphans.length > 0) {
      findings.push(
        `${recordId}: version(s) ${orphans.map((v) => `v${v}`).join(", ")} exist beyond live revision ` +
          `${liveRevision} -- residue of an interrupted write; not visible, awaiting collection`,
      );
    }
    // Staging files from a crash mid-write.
    const dir = join(ctx.records, recordId);
    if (statSync(dir).isDirectory()) {
      const staging = readdirSync(dir).filter((f) => f.includes(".tmp."));
      if (staging.length > 0) findings.push(`${recordId}: ${staging.length} staging file(s) left by an interrupted write`);
    }
  }
  return repairable("80.3", name, findings);
}

/** Invariant 4: no supersession cycles; every successor exists and is active. */
function checkSupersession(ctx: Context): InvariantResult {
  const name = "No supersession cycles; every superseded record has an existing active successor";
  if (!ctx.live) return pass("80.4", name);
  const findings: string[] = [];

  const successor = new Map<string, string>();
  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    if (entry.status !== "superseded") continue;
    const record = readRecord(ctx, recordId, entry.revision);
    if (!record) continue; // reported by invariant 1
    if (!record.superseded_by) {
      findings.push(`${recordId}: superseded but names no successor`);
      continue;
    }
    successor.set(recordId, record.superseded_by);
    const target = ctx.live.entries[record.superseded_by];
    if (!target) {
      findings.push(`${recordId}: successor "${record.superseded_by}" does not exist`);
    } else if (target.status !== "active") {
      findings.push(`${recordId}: successor "${record.superseded_by}" is "${target.status}", not active`);
    }
  }

  for (const start of successor.keys()) {
    const seen = new Set<string>([start]);
    let cursor = successor.get(start);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        findings.push(`supersession cycle through "${cursor}"`);
        break;
      }
      seen.add(cursor);
      cursor = successor.get(cursor);
    }
  }
  return result("80.4", name, [...new Set(findings)]);
}

/** Invariant 7: no record carries secret-shaped content. */
function checkNoSecrets(ctx: Context): InvariantResult {
  const name = "No record contains unredacted secret-shaped content";
  if (!ctx.live) return pass("80.7", name);
  const findings: string[] = [];

  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    const record = readRecord(ctx, recordId, entry.revision);
    if (!record) continue;
    const hits = findSecrets([record.summary, record.body ?? ""].join("\n"));
    for (const hit of hits) findings.push(`${recordId} v${entry.revision}: ${hit.rule} [${hit.excerpt}]`);
  }
  return result("80.7", name, findings);
}

/**
 * Invariant 8: every active record's source references resolve. An unresolved
 * reference is flagged stale, never deleted -- the record may still be the only
 * account of why something was done.
 */
function checkSourceRefs(ctx: Context): InvariantResult {
  const name = "Every active record's source references resolve, or are flagged stale";
  if (!ctx.live) return pass("80.8", name);
  const findings: string[] = [];

  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    if (entry.status !== "active") continue;
    const record = readRecord(ctx, recordId, entry.revision);
    if (!record) continue;
    for (const ref of record.source_refs) {
      const path = join(ctx.sourceRoot, ref.path);
      if (!existsSync(path)) {
        findings.push(`${recordId}: source "${ref.path}" no longer exists (stale, retained)`);
        continue;
      }
      const actual = hashContent(readFileSync(path, "utf8"));
      if (actual !== ref.hash) {
        findings.push(`${recordId}: source "${ref.path}" changed since this record was written (stale, retained)`);
      }
    }
  }
  // Staleness is a fact to surface, not a violation: live source always
  // supersedes a memory summary about it, and the record is still the only
  // account of why the change was made.
  return repairable("80.8", name, findings);
}

/** Invariant 9: a record's project_id matches the namespace it is stored in. */
function checkProjectNamespace(ctx: Context): InvariantResult {
  const name = "Every record's project_id matches the namespace it is stored in";
  if (!ctx.live) return pass("80.9", name);
  const findings: string[] = [];

  if (ctx.live.project_id !== ctx.projectId) {
    findings.push(`manifest declares project "${ctx.live.project_id}" but is stored under "${ctx.projectId}"`);
  }
  for (const [recordId, entry] of Object.entries(ctx.live.entries)) {
    const record = readRecord(ctx, recordId, entry.revision);
    if (record && record.project_id !== ctx.projectId) {
      findings.push(`${recordId}: project_id "${record.project_id}" but stored under "${ctx.projectId}"`);
    }
  }
  return result("80.9", name, findings);
}

/**
 * Generation chain integrity. Not in the original Part XX 80 list, which assumed
 * per-record pointer files; the amended design makes the chain the authority, so
 * its integrity is an invariant in its own right.
 */
function checkGenerationChain(ctx: Context): InvariantResult {
  const name = "Generations are gapless and each one's parent hash matches its predecessor";
  const generations = listGenerations(ctx.manifests);
  if (generations.length === 0) return pass("80.11", name);
  const findings: string[] = [];

  for (let i = 0; i < generations.length; i++) {
    if (generations[i] !== i) {
      findings.push(`generation sequence has a gap: found ${generations.join(", ")}`);
      break;
    }
  }

  let previous: Manifest | null = null;
  for (const generation of generations) {
    let manifest: Manifest;
    try {
      manifest = readGeneration(ctx.manifests, generation);
    } catch (cause) {
      findings.push(`generation ${generation}: ${(cause as Error).message}`);
      previous = null;
      continue;
    }
    const expected = previous ? manifestHash(previous) : null;
    if (manifest.parent_hash !== expected) {
      findings.push(
        `generation ${generation}: parent_hash ${String(manifest.parent_hash)} does not match ` +
          `generation ${generation - 1} (${String(expected)})`,
      );
    }
    previous = manifest;
  }
  return result("80.11", name, findings);
}

export interface DoctorOptions {
  readonly memoryRoot: string;
  readonly projectId: string;
  /** Root the source references are relative to. Defaults to the process cwd. */
  readonly sourceRoot?: string;
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const ctx: Context = {
    memoryRoot: options.memoryRoot,
    projectId: options.projectId,
    manifests: manifestDir(options.memoryRoot, options.projectId),
    records: recordsDir(options.memoryRoot, options.projectId),
    live: readLiveManifest(manifestDir(options.memoryRoot, options.projectId)),
    sourceRoot: options.sourceRoot ?? process.cwd(),
  };

  const invariants: InvariantResult[] = [
    checkPointersResolve(ctx),
    checkRevisionsGapless(ctx),
    checkNoOrphans(ctx),
    checkSupersession(ctx),
    // Invariants 5, 6 and 10 depend on components that do not exist yet. They
    // are reported as unchecked rather than as passing: see the header comment.
    notImplemented(
      "80.5",
      "Tier 1 agrees with Tier 0, or is flagged dirty and rebuildable",
      "No Tier 1 index exists yet (src/memory has no index module).",
    ),
    notImplemented(
      "80.6",
      "No lease is held past its expiry",
      "No lease manager exists yet; write safety currently rests on the generation CAS, not on leases.",
    ),
    checkNoSecrets(ctx),
    checkSourceRefs(ctx),
    checkProjectNamespace(ctx),
    notImplemented(
      "80.10",
      "The derived snapshot recomputes and matches its cached value",
      "No snapshot projection exists yet (src/memory has no snapshot module).",
    ),
    checkGenerationChain(ctx),
  ];

  return {
    project_id: options.projectId,
    generation: ctx.live?.generation ?? -1,
    record_count: ctx.live ? Object.keys(ctx.live.entries).length : 0,
    invariants,
    ok: invariants.every((i) => i.status !== "fail"),
    incomplete: invariants.filter((i) => i.status === "not-implemented").length,
    repairable: invariants.filter((i) => i.status === "repairable").length,
  };
}

/** Human-readable report. The exit code comes from `ok`, not from this text. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`memory doctor: project "${report.project_id}"`);
  lines.push(`  generation ${report.generation}, ${report.record_count} live record(s)`);
  lines.push("");

  const MARK: Readonly<Record<InvariantStatus, string>> = {
    pass: "ok  ",
    fail: "FAIL",
    repairable: "warn",
    "not-implemented": "----",
  };

  for (const invariant of report.invariants) {
    lines.push(`  ${MARK[invariant.status]} ${invariant.id}  ${invariant.name}`);
    if (invariant.blocked_on) lines.push(`         not checked: ${invariant.blocked_on}`);
    for (const finding of invariant.findings) lines.push(`         ${finding}`);
  }

  lines.push("");
  const failed = report.invariants.filter((i) => i.status === "fail").length;
  const passed = report.invariants.filter((i) => i.status === "pass").length;
  lines.push(
    `  ${passed} passed, ${failed} failed, ${report.repairable} repairable, ` +
      `${report.incomplete} not checked` +
      (report.incomplete > 0 ? " (reported as unchecked, never as passing)" : ""),
  );
  return lines.join("\n");
}
