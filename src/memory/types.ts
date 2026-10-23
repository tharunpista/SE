/**
 * Memory layer record model (Part XX 71, 74) and the vocabularies the store
 * enforces. Nothing here depends on the storage mechanism, so the state machine
 * and the scope rules can be tested without touching a disk.
 */

/** Part XX 74. Statuses are not free text. */
export const RECORD_STATUSES = [
  "draft",
  "active",
  "superseded",
  "disputed",
  "archived",
  "cancelled",
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/**
 * Part XX 74. The only legal transitions. A transition absent from this table is
 * a rejected write, not a warning -- an illegal status reached by accident is
 * indistinguishable later from one reached on purpose.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<RecordStatus, readonly RecordStatus[]>> = {
  draft: ["active", "cancelled"],
  active: ["superseded", "disputed", "archived"],
  disputed: ["active", "superseded", "archived"],
  superseded: ["archived"],
  archived: [],
  cancelled: [],
};

/** Terminal statuses, derived so the two cannot drift apart. */
export const TERMINAL_STATUSES: ReadonlySet<RecordStatus> = new Set(
  RECORD_STATUSES.filter((s) => LEGAL_TRANSITIONS[s].length === 0),
);

export function isLegalTransition(from: RecordStatus, to: RecordStatus): boolean {
  if (from === to) return true; // a content-only revision keeps its status
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** schemas/vocabulary.json memory_scopes. */
export const MEMORY_SCOPES = ["session", "project", "role", "organization", "preference"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** schemas/vocabulary.json lifecycle_phases. Part XX 75 gates writes on these. */
export const LIFECYCLE_PHASES = [
  "project-resolution",
  "context-assembly",
  "execution",
  "verification",
  "outcome-recording",
  "promotion",
  "compaction",
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

/** Part XVI 60. Where a claim came from, which decides how much weight it carries. */
export const TRUST_TIERS = ["operator", "repository", "derived", "external"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * Part XX 75. What each phase may do. The store consults this table; it is never
 * left to agent good behaviour. `context-assembly` is deliberately empty: an
 * agent that writes while deciding what to read can persuade itself of facts
 * nobody established.
 */
export interface PhaseRule {
  readonly writable_scopes: readonly MemoryScope[];
  readonly requires_evidence: boolean;
  readonly requires_approval: boolean;
  /** Status transitions only; content may not be rewritten. */
  readonly status_only: boolean;
}

export const PHASE_RULES: Readonly<Record<LifecyclePhase, PhaseRule>> = {
  "project-resolution": {
    writable_scopes: [],
    requires_evidence: false,
    requires_approval: false,
    status_only: false,
  },
  "context-assembly": {
    writable_scopes: [],
    requires_evidence: false,
    requires_approval: false,
    status_only: false,
  },
  execution: {
    writable_scopes: ["session"],
    requires_evidence: false,
    requires_approval: false,
    status_only: false,
  },
  verification: {
    writable_scopes: ["session"],
    requires_evidence: true,
    requires_approval: false,
    status_only: false,
  },
  "outcome-recording": {
    writable_scopes: ["project"],
    requires_evidence: true,
    requires_approval: false,
    status_only: false,
  },
  promotion: {
    writable_scopes: ["role", "organization"],
    requires_evidence: true,
    requires_approval: true,
    status_only: false,
  },
  compaction: {
    writable_scopes: ["session", "project", "role", "organization", "preference"],
    requires_evidence: false,
    requires_approval: false,
    status_only: true,
  },
};

/** A pointer from a record to the source it describes, with the hash it was true at. */
export interface SourceRef {
  readonly path: string;
  /** Hash of the file content when this record was written. Freshness derives from it. */
  readonly hash: string;
  readonly lines?: readonly [number, number];
}

/** Recorded proof for a claim. Part XX 75 requires it in some phases. */
export interface Evidence {
  readonly kind: "command" | "test" | "file" | "operator";
  readonly detail: string;
  /** Exit code where the evidence is an executed command. */
  readonly exit_code?: number;
  readonly recorded_at: string;
}

/**
 * One immutable record version (Part XX 71). Written once, never edited.
 */
export interface MemoryRecord {
  readonly schema_version: 1;
  readonly record_id: string;
  readonly revision: number;
  readonly project_id: string;
  readonly scope: MemoryScope;
  readonly type: string;
  readonly status: RecordStatus;
  readonly summary: string;
  readonly body?: string;
  readonly source_refs: readonly SourceRef[];
  readonly evidence: readonly Evidence[];
  readonly trust_tier: TrustTier;
  readonly owner: string;
  readonly created_at: string;
  readonly written_at: string;
  /** Part XX 74. Required when status is `superseded`. */
  readonly superseded_by?: string;
  readonly supersedes?: string;
  /** Part XX 78. hash(task_id, record_id, canonical content). */
  readonly idempotency_key: string;
  readonly task_id?: string;
}

/** What a caller submits. The store assigns revision, timestamps and the key. */
export interface WriteRequest {
  readonly record_id: string;
  readonly scope: MemoryScope;
  readonly type: string;
  readonly status: RecordStatus;
  readonly summary: string;
  readonly body?: string;
  readonly source_refs?: readonly SourceRef[];
  readonly evidence?: readonly Evidence[];
  readonly trust_tier?: TrustTier;
  readonly owner: string;
  readonly superseded_by?: string;
  readonly supersedes?: string;
  readonly task_id?: string;
  /**
   * Part XX 72 step 3. The revision the writer believes is live. `0` asserts the
   * record does not exist yet. A blind write is the lost update this prevents.
   */
  readonly expected_revision: number;
}

/**
 * Part IX / Part XX 75. The capability a context package grants. The store
 * rejects anything outside it; the grant is data, not a convention.
 */
export interface WriteGrant {
  readonly phase: LifecyclePhase;
  /** Record ids this grant permits. `"*"` permits any id within the allowed scopes. */
  readonly write_targets: readonly string[];
  readonly scopes: readonly MemoryScope[];
  readonly owner: string;
  /** Set by the operator, never by an agent. Required by the promotion phase. */
  readonly approved_by?: string;
}

/** Why a write was refused. Named causes, because "failed" is not actionable. */
export type RefusalCode =
  | "phase-forbids-write"
  | "scope-not-granted"
  | "target-not-granted"
  | "evidence-required"
  | "approval-required"
  | "revision-conflict"
  | "illegal-transition"
  | "supersession-cycle"
  | "supersession-missing"
  | "secret-detected"
  | "schema-invalid"
  | "project-mismatch"
  | "lease-unavailable"
  | "store-unwritable"
  | "index-unavailable"
  | "content-rewrite-forbidden"
  | "unknown-schema-version";

/**
 * Part XX 79. The result of a write. `accepted` is set by the store after the
 * commit, never by the caller -- and when it is false the content is handed back
 * so the operator still has the work.
 */
export type WriteResult =
  | {
      readonly accepted: true;
      readonly record_id: string;
      readonly revision: number;
      readonly generation: number;
      /** True when an idempotency key matched and no new revision was created. */
      readonly deduplicated: boolean;
    }
  | {
      readonly accepted: false;
      readonly record_id: string;
      readonly code: RefusalCode;
      readonly message: string;
      /** The rejected content, so a refusal never silently destroys work. */
      readonly surfaced: WriteRequest;
      readonly conflicting_revision?: number;
    };
