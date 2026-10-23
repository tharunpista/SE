/**
 * Tier 0 authority (Part XX 70, amended -- see docs/spec-amendments.md).
 *
 * The live state of a project's memory is the highest-numbered manifest
 * generation. Publishing generation N+1 is the single instant at which a write
 * becomes visible, and it is one filesystem operation, so a multi-record
 * changeset is atomic by construction rather than by protocol.
 *
 * Two platform facts drive this design, both measured in
 * docs/platform-atomicity.md rather than assumed:
 *
 *   1. Windows refuses to rename over a file while any handle is open on it, so
 *      replacing one pointer file is unreliable under concurrent readers --
 *      measured at 4 of 164 publishes succeeding on the first attempt. Creating
 *      a name that does not yet exist cannot hit that sharing violation.
 *   2. `link` fails with EEXIST when the target exists, atomically, on NTFS and
 *      POSIX alike. That makes it a create-if-absent primitive, which is what
 *      stops two writers racing for the same generation from silently
 *      overwriting one another. `rename` would let the loser win.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryScope, RecordStatus } from "./types.ts";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** One record's live position, as of a generation. */
export interface ManifestEntry {
  readonly revision: number;
  /** Hash of the canonical version file, so the index can be checked without reading it. */
  readonly hash: string;
  readonly status: RecordStatus;
  readonly scope: MemoryScope;
  readonly type: string;
  /** Part XX 78. The key of the write that produced this revision. */
  readonly idempotency_key: string;
}

/**
 * An immutable snapshot of which revision of every record is live. Readers take
 * the highest generation and see a consistent set; they never assemble state
 * from several files and so cannot observe a half-applied changeset.
 */
export interface Manifest {
  readonly schema_version: typeof MANIFEST_SCHEMA_VERSION;
  readonly generation: number;
  readonly project_id: string;
  readonly committed_at: string;
  /** Hash of the previous generation, making the chain verifiable. */
  readonly parent_hash: string | null;
  /** Why this generation exists, for the audit trail. */
  readonly changeset_id: string;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

export class Tier0CorruptionError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "Tier0CorruptionError";
  }
}

/** Raised when another writer published the generation we were building. */
export class GenerationTakenError extends Error {
  constructor(readonly generation: number) {
    super(`Generation ${generation} was published by another writer`);
    this.name = "GenerationTakenError";
  }
}

const GENERATION_DIGITS = 6;
const GENERATION_FILE = /^(\d{6})\.json$/;

export function manifestDir(memoryRoot: string, projectId: string): string {
  return join(memoryRoot, projectId, "manifest");
}

export function recordsDir(memoryRoot: string, projectId: string): string {
  return join(memoryRoot, projectId, "records");
}

export function generationPath(dir: string, generation: number): string {
  return join(dir, `${String(generation).padStart(GENERATION_DIGITS, "0")}.json`);
}

/**
 * Canonical JSON: object keys sorted at every depth, so that the same logical
 * content always hashes to the same value. Idempotency (Part XX 78) and the
 * generation chain both depend on this being stable, including across platforms
 * and across insertion orders.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Recursively ordered copy, so a serialiser emits keys in a stable order. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (v !== undefined) out[k] = sortKeysDeep(v);
  }
  return out;
}

/**
 * What is actually written to Tier 0. Part XX 70 requires Tier 0 to be
 * human-readable and diffable -- if the tooling is lost, the memory must still
 * be readable -- so files are indented, with keys in the same stable order as
 * `canonicalJson` to keep diffs minimal.
 *
 * Hashes are always taken over `canonicalJson`, never over this, so formatting
 * is free to change without invalidating a single stored hash: every verifier
 * re-canonicalises after parsing.
 */
export function storedJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * Durably write a file, then expose it under its final name only once it is
 * complete. Returns the staging path so the caller can publish or discard it.
 *
 * The directory `fsync` that Part XX 72 step 5 requires is not possible on
 * Windows (EPERM, measured). It is attempted and the failure tolerated, which
 * is a genuinely weaker durability guarantee on that platform; pretending
 * otherwise would be the more dangerous choice.
 */
function writeStaged(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.tmp.${process.pid}.${randomUUID()}`);
  const fd = openSync(staging, "wx");
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dir);
  return staging;
}

/** Best-effort directory durability. Fails with EPERM on Windows; see above. */
export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows does not permit fsync on a directory handle. Nothing to do.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Publish content under an exact name, failing if that name is taken.
 * `link` is the create-if-absent primitive; `rename` is not, and would let a
 * racing writer silently replace a committed generation.
 */
function publishExclusive(staging: string, target: string): void {
  try {
    linkSync(staging, target);
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      /* staging already removed */
    }
  }
}

/** Generation numbers present on disk, ascending. Ignores staging files. */
export function listGenerations(dir: string): number[] {
  if (!existsSync(dir)) return [];
  const generations: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = GENERATION_FILE.exec(name);
    if (match) generations.push(Number(match[1]));
  }
  return generations.sort((a, b) => a - b);
}

/**
 * The live manifest, or null for a project with no memory yet.
 *
 * A manifest file is either absent or complete -- it is published under its
 * final name only after being written in full -- so an unparseable generation is
 * real corruption and is refused loudly. Guessing with the previous generation
 * would silently roll memory backwards, which is the failure this layer exists
 * to make impossible.
 */
export function readLiveManifest(dir: string): Manifest | null {
  const generations = listGenerations(dir);
  if (generations.length === 0) return null;
  const generation = generations[generations.length - 1]!;
  return readGeneration(dir, generation);
}

export function readGeneration(dir: string, generation: number): Manifest {
  const path = generationPath(dir, generation);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Tier0CorruptionError(
      `Manifest generation ${generation} is listed but unreadable: ${(cause as Error).message}`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Tier0CorruptionError(
      `Manifest generation ${generation} is not valid JSON: ${(cause as Error).message}`,
      path,
    );
  }

  const manifest = parsed as Manifest;
  if (manifest?.schema_version !== MANIFEST_SCHEMA_VERSION) {
    // Part XX 79: an unknown schema version is refused, never guessed at.
    throw new Tier0CorruptionError(
      `Manifest generation ${generation} has unsupported schema_version ` +
        `${String(manifest?.schema_version)}; expected ${MANIFEST_SCHEMA_VERSION}. ` +
        `Migration is explicit, never inferred.`,
      path,
    );
  }
  if (manifest.generation !== generation) {
    throw new Tier0CorruptionError(
      `Manifest at generation ${generation} declares generation ${manifest.generation}`,
      path,
    );
  }
  return manifest;
}

export function manifestHash(manifest: Manifest): string {
  return hashContent(canonicalJson(manifest));
}

/**
 * Commit a new generation. The returned manifest is live the instant this
 * resolves; until then nothing a caller wrote is visible to any reader.
 *
 * Throws GenerationTakenError when another writer took the generation, which the
 * store surfaces as a revision conflict rather than retrying blindly: the
 * competing commit may have changed the very records this caller based its
 * expected revisions on (Part XX 72 step 3).
 */
export function commitGeneration(
  dir: string,
  projectId: string,
  base: Manifest | null,
  entries: Readonly<Record<string, ManifestEntry>>,
  changesetId: string,
): Manifest {
  const generation = (base?.generation ?? -1) + 1;
  const next: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    generation,
    project_id: projectId,
    committed_at: new Date().toISOString(),
    parent_hash: base ? manifestHash(base) : null,
    changeset_id: changesetId,
    entries,
  };

  const target = generationPath(dir, generation);
  const staging = writeStaged(dir, storedJson(next));
  try {
    publishExclusive(staging, target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GenerationTakenError(generation);
    }
    throw cause;
  }
  syncDirectory(dir);
  return next;
}
