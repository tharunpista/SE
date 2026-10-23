/**
 * The memory store: the write protocol (Part XX 72), changesets (73), the record
 * state machine (74), phase gating (75), idempotency (78) and the degraded-mode
 * rules (79).
 *
 * The ordering of the protocol is the design. Every refusal returns a named code
 * and hands the submitted content back, because Part XX 79's absolute rule is
 * that an agent's work is never silently discarded: if memory cannot accept it,
 * the operator is told, with the content.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  commitGeneration,
  GenerationTakenError,
  hashContent,
  manifestDir,
  readLiveManifest,
  recordsDir,
  storedJson,
  type Manifest,
  type ManifestEntry,
} from "./manifest.ts";
import { findSecrets } from "./redact.ts";
import {
  isLegalTransition,
  PHASE_RULES,
  type MemoryRecord,
  type RefusalCode,
  type WriteGrant,
  type WriteRequest,
  type WriteResult,
} from "./types.ts";

/**
 * Points in the write protocol at which the fault hook fires. Part XX 81.1
 * requires the process to be killed at each step of Part XX 72 and the
 * invariants to hold afterwards; a crash cannot be simulated from outside,
 * because the interesting states last microseconds.
 */
export type FaultPoint =
  | "after-stage"
  | "after-version-write"
  | "after-publish"
  | "after-mirror";

export interface StoreOptions {
  /** Tier 0 root. Committed to the repository; diffable by design (Part XX 70). */
  readonly memoryRoot: string;
  readonly projectId: string;
  /** Injected so tests can pin time without waiting for it. */
  readonly now?: () => Date;
  /**
   * Fires at each protocol step so a test can kill the process there. Left
   * undefined in production; the hook is the only way to observe the states the
   * crash table in Part XX 72 describes.
   */
  readonly faultHook?: (point: FaultPoint) => void;
}

/** One member of a changeset, paired with the record it would produce. */
interface Staged {
  readonly request: WriteRequest;
  readonly record: MemoryRecord;
  readonly entry: ManifestEntry;
  /** Set when the key matched an existing revision: nothing to write. */
  readonly deduplicated: boolean;
}

export interface ChangesetResult {
  readonly accepted: boolean;
  /** Present when accepted. */
  readonly generation?: number;
  readonly results: readonly WriteResult[];
}

function refuse(
  request: WriteRequest,
  code: RefusalCode,
  message: string,
  conflictingRevision?: number,
): WriteResult {
  return {
    accepted: false,
    record_id: request.record_id,
    code,
    message,
    surfaced: request,
    ...(conflictingRevision === undefined ? {} : { conflicting_revision: conflictingRevision }),
  };
}

export class MemoryStore {
  private readonly manifests: string;
  private readonly records: string;
  private readonly now: () => Date;
  private readonly fault: (point: FaultPoint) => void;

  constructor(private readonly options: StoreOptions) {
    this.fault = options.faultHook ?? (() => {});
    this.manifests = manifestDir(options.memoryRoot, options.projectId);
    this.records = recordsDir(options.memoryRoot, options.projectId);
    this.now = options.now ?? (() => new Date());
  }

  get projectId(): string {
    return this.options.projectId;
  }

  /** The live manifest, or null when this project has no memory yet. */
  liveManifest(): Manifest | null {
    return readLiveManifest(this.manifests);
  }

  get generation(): number {
    return this.liveManifest()?.generation ?? -1;
  }

  /**
   * Part XX 76. Retrieval performs no writes whatsoever -- not even an access
   * counter or a last-read timestamp on a canonical record.
   */
  get(recordId: string): MemoryRecord | null {
    const entry = this.liveManifest()?.entries[recordId];
    if (!entry) return null;
    return this.readVersion(recordId, entry.revision);
  }

  getRevision(recordId: string, revision: number): MemoryRecord | null {
    return this.readVersion(recordId, revision);
  }

  /** Live record ids. Project scoping is structural: a store addresses one project. */
  listRecordIds(): string[] {
    const manifest = this.liveManifest();
    return manifest ? Object.keys(manifest.entries).sort() : [];
  }

  private versionPath(recordId: string, revision: number): string {
    return join(this.records, recordId, `v${revision}.json`);
  }

  private readVersion(recordId: string, revision: number): MemoryRecord | null {
    const path = this.versionPath(recordId, revision);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MemoryRecord;
    if (parsed.schema_version !== 1) {
      // Part XX 79: refuse to read an unknown schema version; never guess.
      throw new Error(
        `Record ${recordId} v${revision} has unsupported schema_version ` +
          `${String(parsed.schema_version)}. Migration is explicit.`,
      );
    }
    return parsed;
  }

  /** A single write. Convenience over the changeset path, with identical rules. */
  put(request: WriteRequest, grant: WriteGrant): WriteResult {
    const result = this.putChangeset([request], grant);
    return result.results[0]!;
  }

  /**
   * Part XX 73. Related writes submitted as one changeset. Every member is
   * validated and staged first; the generation is published only if all of them
   * pass. If any member is refused, nothing is published at all -- so a reader
   * can never observe a half-applied changeset, and a partial success can never
   * be mistaken for a whole one.
   */
  putChangeset(requests: readonly WriteRequest[], grant: WriteGrant): ChangesetResult {
    if (requests.length === 0) return { accepted: true, generation: this.generation, results: [] };

    const base = this.liveManifest();
    const staged: Staged[] = [];
    const refusals: WriteResult[] = [];

    for (const request of requests) {
      const outcome = this.stage(request, grant, base, staged);
      if ("accepted" in outcome) refusals.push(outcome);
      else staged.push(outcome);
    }

    if (refusals.length > 0) {
      // Members that would have succeeded are reported as refused too, with the
      // cause named, so no caller believes a partial write landed.
      const blocked = staged.map((s) =>
        refuse(
          s.request,
          refusals[0]!.accepted === false ? refusals[0]!.code : "schema-invalid",
          `Not published: changeset refused because ${refusals
            .filter((r): r is Extract<WriteResult, { accepted: false }> => !r.accepted)
            .map((r) => `${r.record_id} (${r.code})`)
            .join(", ")}`,
        ),
      );
      return { accepted: false, results: [...blocked, ...refusals] };
    }

    this.fault("after-stage");

    const toWrite = staged.filter((s) => !s.deduplicated);

    // Part XX 78. Nothing new: a replay must produce zero revisions and zero
    // generations, or history inflates every time a run is resumed.
    if (toWrite.length === 0) {
      return {
        accepted: true,
        generation: base?.generation ?? -1,
        results: staged.map((s) => ({
          accepted: true as const,
          record_id: s.request.record_id,
          revision: s.entry.revision,
          generation: base?.generation ?? -1,
          deduplicated: true,
        })),
      };
    }

    // Step 5: stage every version file under a name that does not yet exist, so
    // this can never replace a published version. A crash here leaves orphan
    // version files that no manifest references -- invisible, and collected by
    // `se memory doctor`.
    try {
      for (const s of toWrite) this.writeVersionFile(s.record);
      this.fault("after-version-write");
    } catch (cause) {
      const message = `Tier 0 is unwritable: ${(cause as Error).message}`;
      return {
        accepted: false,
        results: staged.map((s) => refuse(s.request, "store-unwritable", message)),
      };
    }

    // Step 6: the single atomic publish. Before this instant nothing is visible;
    // after it, every member of the changeset is.
    const entries: Record<string, ManifestEntry> = { ...(base?.entries ?? {}) };
    for (const s of staged) entries[s.request.record_id] = s.entry;

    let committed: Manifest;
    try {
      committed = commitGeneration(this.manifests, this.projectId, base, entries, randomUUID());
    } catch (cause) {
      if (cause instanceof GenerationTakenError) {
        // Another writer published while we were staging. We do not retry: their
        // commit may have changed the very records our expected revisions were
        // read from, so retrying blindly is the lost update CAS exists to stop.
        const message =
          `Another writer published generation ${cause.generation} while this changeset was staged. ` +
          `Re-read the affected records and resubmit.`;
        return {
          accepted: false,
          results: staged.map((s) => refuse(s.request, "revision-conflict", message, s.entry.revision - 1)),
        };
      }
      const message = `Publish failed: ${(cause as Error).message}`;
      return {
        accepted: false,
        results: staged.map((s) => refuse(s.request, "store-unwritable", message)),
      };
    }

    this.fault("after-publish");

    // Step 7 onwards is derived state only. A failure past the publish cannot
    // un-accept the write, so it must never be reported as a write failure.
    this.mirrorPointers(staged);
    this.fault("after-mirror");

    return {
      accepted: true,
      generation: committed.generation,
      results: staged.map((s) => ({
        accepted: true as const,
        record_id: s.request.record_id,
        revision: s.entry.revision,
        generation: committed.generation,
        deduplicated: s.deduplicated,
      })),
    };
  }

  /**
   * Validate one member and compute the version it would produce. Returns a
   * refusal instead of throwing, so that one bad member reports its own cause
   * rather than collapsing the whole changeset into a single opaque error.
   */
  private stage(
    request: WriteRequest,
    grant: WriteGrant,
    base: Manifest | null,
    alreadyStaged: readonly Staged[],
  ): Staged | WriteResult {
    const rule = PHASE_RULES[grant.phase];
    if (!rule) return refuse(request, "schema-invalid", `Unknown lifecycle phase "${grant.phase}"`);

    // Part XX 75. Context assembly is read-only with zero exceptions: an agent
    // that edits memory while deciding what to read can convince itself of facts
    // nobody established.
    if (rule.writable_scopes.length === 0) {
      return refuse(
        request,
        "phase-forbids-write",
        `Phase "${grant.phase}" permits no writes. Retrieval must be a pure function.`,
      );
    }

    if (!rule.writable_scopes.includes(request.scope)) {
      return refuse(
        request,
        "scope-not-granted",
        `Phase "${grant.phase}" may write ${rule.writable_scopes.join(", ")}; not "${request.scope}".`,
      );
    }

    // The grant is narrower than the phase: a context package may permit fewer
    // scopes than the phase allows, never more.
    if (!grant.scopes.includes(request.scope)) {
      return refuse(
        request,
        "scope-not-granted",
        `This grant covers ${grant.scopes.join(", ") || "no scopes"}; not "${request.scope}".`,
      );
    }

    if (!grant.write_targets.includes("*") && !grant.write_targets.includes(request.record_id)) {
      return refuse(
        request,
        "target-not-granted",
        `Record "${request.record_id}" is outside the granted write targets.`,
      );
    }

    if (rule.requires_evidence && (request.evidence?.length ?? 0) === 0) {
      return refuse(
        request,
        "evidence-required",
        `Phase "${grant.phase}" requires evidence; an unsupported claim is not recordable.`,
      );
    }

    if (rule.requires_approval && !grant.approved_by) {
      return refuse(
        request,
        "approval-required",
        `Phase "${grant.phase}" requires operator approval, which an agent cannot grant itself.`,
      );
    }

    if (!request.record_id || /[\\/]|^\.\.?$/.test(request.record_id)) {
      return refuse(request, "schema-invalid", `Invalid record id "${request.record_id}".`);
    }
    if (!request.summary?.trim()) {
      return refuse(request, "schema-invalid", "A record requires a summary.");
    }

    const existingEntry = base?.entries[request.record_id];
    const liveRevision = existingEntry?.revision ?? 0;

    /*
     * Part XX 78, and it must be checked *before* the compare-and-swap.
     *
     * A replay carries the expected_revision it was first written with, so a
     * replayed write of an already-stored revision looks like a stale write to
     * CAS. Checking CAS first makes journal replay (Part XV 56) impossible --
     * the resumed run is refused for a conflict with the revision it itself
     * created. The content is byte-identical to what is live, so the write is
     * already satisfied: it is a no-op, not a conflict.
     */
    const key = idempotencyKey(request, this.projectId);
    if (existingEntry && existingEntry.idempotency_key === key) {
      const stored = this.readVersion(request.record_id, existingEntry.revision);
      if (stored) return { request, record: stored, entry: existingEntry, deduplicated: true };
    }

    // Part XX 72 step 3. Abort and report; never merge, never retry blindly.
    if (request.expected_revision !== liveRevision) {
      return refuse(
        request,
        "revision-conflict",
        `Expected revision ${request.expected_revision} of "${request.record_id}" but ${
          liveRevision === 0 ? "it does not exist" : `revision ${liveRevision} is live`
        }.`,
        liveRevision,
      );
    }

    // Part XX 74.
    const fromStatus = existingEntry?.status ?? "draft";
    if (existingEntry && !isLegalTransition(fromStatus, request.status)) {
      return refuse(
        request,
        "illegal-transition",
        `"${fromStatus}" cannot become "${request.status}".`,
      );
    }
    if (!existingEntry && request.status !== "draft" && request.status !== "active") {
      return refuse(
        request,
        "illegal-transition",
        `A new record starts as draft or active, not "${request.status}".`,
      );
    }

    if (rule.status_only && existingEntry) {
      const previous = this.readVersion(request.record_id, existingEntry.revision);
      if (previous && (previous.summary !== request.summary || (previous.body ?? "") !== (request.body ?? ""))) {
        return refuse(
          request,
          "content-rewrite-forbidden",
          `Phase "${grant.phase}" permits status transitions only; content may not be rewritten.`,
        );
      }
    }

    const supersessionRefusal = this.checkSupersession(request, base, alreadyStaged);
    if (supersessionRefusal) return supersessionRefusal;

    // Part XI. Refused before persisting, not scrubbed after.
    const secretScan = findSecrets([request.summary, request.body ?? "", canonicalJson(request.source_refs ?? [])].join("\n"));
    if (secretScan.length > 0) {
      return refuse(
        request,
        "secret-detected",
        `Refused: content matches ${secretScan.map((f) => `${f.rule} [${f.excerpt}]`).join(", ")}. ` +
          `Credentials must not enter a store that never hard-deletes.`,
      );
    }

    const timestamp = this.now().toISOString();
    const created = existingEntry
      ? (this.readVersion(request.record_id, existingEntry.revision)?.created_at ?? timestamp)
      : timestamp;

    const record: MemoryRecord = {
      schema_version: 1,
      record_id: request.record_id,
      revision: liveRevision + 1,
      project_id: this.projectId,
      scope: request.scope,
      type: request.type,
      status: request.status,
      summary: request.summary,
      ...(request.body === undefined ? {} : { body: request.body }),
      source_refs: request.source_refs ?? [],
      evidence: request.evidence ?? [],
      trust_tier: request.trust_tier ?? "derived",
      owner: request.owner,
      created_at: created,
      written_at: timestamp,
      ...(request.superseded_by === undefined ? {} : { superseded_by: request.superseded_by }),
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
      ...(request.task_id === undefined ? {} : { task_id: request.task_id }),
      idempotency_key: key,
    };

    const serialised = canonicalJson(record);
    return {
      request,
      record,
      deduplicated: false,
      entry: {
        revision: record.revision,
        hash: hashContent(serialised),
        status: record.status,
        scope: record.scope,
        type: record.type,
        idempotency_key: record.idempotency_key,
      },
    };
  }

  /**
   * Part XX 74. A `superseded` record must name an existing, active successor,
   * and the chain must not contain a cycle. Both are checked at write time:
   * discovering a cycle at read time means the corruption is already durable.
   */
  private checkSupersession(
    request: WriteRequest,
    base: Manifest | null,
    alreadyStaged: readonly Staged[],
  ): WriteResult | null {
    if (request.status !== "superseded") return null;

    if (!request.superseded_by) {
      return refuse(
        request,
        "supersession-missing",
        `A superseded record must name the record that replaces it.`,
      );
    }
    if (request.superseded_by === request.record_id) {
      return refuse(request, "supersession-cycle", `A record cannot supersede itself.`);
    }

    // The successor may be another member of this same changeset, which is the
    // normal shape of a supersession: new decision plus old one retired.
    const stagedById = new Map(alreadyStaged.map((s) => [s.request.record_id, s] as const));
    const successorStatus = (id: string): string | undefined =>
      stagedById.get(id)?.record.status ?? base?.entries[id]?.status;

    const status = successorStatus(request.superseded_by);
    if (status === undefined) {
      return refuse(
        request,
        "supersession-missing",
        `Successor "${request.superseded_by}" does not exist.`,
      );
    }
    if (status !== "active") {
      return refuse(
        request,
        "supersession-missing",
        `Successor "${request.superseded_by}" is "${status}"; it must be active.`,
      );
    }

    // Walk the chain. The pending write is treated as applied, so a cycle it
    // would create is caught before it exists.
    const pendingLink = new Map<string, string>();
    for (const s of alreadyStaged) {
      if (s.record.superseded_by) pendingLink.set(s.record.record_id, s.record.superseded_by);
    }
    pendingLink.set(request.record_id, request.superseded_by);

    const successorOf = (id: string): string | undefined => {
      if (pendingLink.has(id)) return pendingLink.get(id);
      const entry = base?.entries[id];
      if (!entry || entry.status !== "superseded") return undefined;
      return this.readVersion(id, entry.revision)?.superseded_by;
    };

    const seen = new Set<string>([request.record_id]);
    let cursor: string | undefined = request.superseded_by;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return refuse(
          request,
          "supersession-cycle",
          `This write would create a supersession cycle through "${cursor}".`,
        );
      }
      seen.add(cursor);
      cursor = successorOf(cursor);
    }
    return null;
  }

  /** Step 5. A new version filename, so a published version is never replaced. */
  private writeVersionFile(record: MemoryRecord): void {
    const dir = join(this.records, record.record_id);
    mkdirSync(dir, { recursive: true });
    const target = this.versionPath(record.record_id, record.revision);
    const staging = `${target}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(staging, storedJson(record), { encoding: "utf8", flush: true });
    renameSync(staging, target);
  }

  /**
   * Part XX 70's diffability requirement. `current` is a derived convenience for
   * a human reading the tree, never consulted as authority -- the manifest is.
   * A failure here is not a write failure: the write is already committed.
   */
  private mirrorPointers(staged: readonly Staged[]): void {
    for (const s of staged) {
      try {
        const dir = join(this.records, s.request.record_id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "current"), `${s.entry.revision}\n`, "utf8");
      } catch {
        // Derived state only. `se memory doctor` reports and repairs drift.
      }
    }
  }
}

/**
 * Part XX 78. hash(task_id, record_id, canonical content). Content only: the
 * revision, timestamps and the key itself are excluded, or every write would
 * produce a different key and replay protection would never trigger.
 */
export function idempotencyKey(request: WriteRequest, projectId: string): string {
  return hashContent(
    canonicalJson({
      project_id: projectId,
      task_id: request.task_id ?? null,
      record_id: request.record_id,
      scope: request.scope,
      type: request.type,
      status: request.status,
      summary: request.summary,
      body: request.body ?? null,
      source_refs: request.source_refs ?? [],
      evidence: request.evidence ?? [],
      trust_tier: request.trust_tier ?? "derived",
      superseded_by: request.superseded_by ?? null,
      supersedes: request.supersedes ?? null,
    }),
  );
}
