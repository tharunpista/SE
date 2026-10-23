export type Tier = "starter" | "catalogue";
export type RoleStatus = "active" | "deprecated";
export type MemoryScope = "session" | "project" | "role" | "organization" | "preference";

export interface MemoryScopeAccess {
  readonly read: readonly MemoryScope[];
  readonly write: readonly MemoryScope[];
}

/** A fully resolved, validated role. Every optional key has been defaulted. */
export interface Role {
  readonly schema_version: 1;
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly tier: Tier;
  readonly mission: string;
  readonly activation: readonly string[];
  readonly tools: readonly string[];
  readonly memory_scopes: MemoryScopeAccess;
  readonly owns_artifacts: readonly string[];
  readonly contributes_artifacts: readonly string[];
  readonly owns_interfaces: readonly string[];
  readonly participates_interfaces: readonly string[];
  readonly shared_with: Readonly<Record<string, readonly string[]>>;
  readonly collaborators: readonly string[];
  readonly escalates_to: string;
  readonly context_budget_tokens: number;
  readonly max_calls: number;
  readonly enabled: boolean;
  readonly status: RoleStatus;
  readonly supersedes: readonly string[];
  readonly superseded_by: string | null;
  readonly boundary: string | null;
  readonly requires_evidence: boolean;
  readonly writes_files: boolean;
  readonly owns_spec_sections: readonly string[];
  /** Hardcoded verification commands; a project layer may override them. */
  readonly verify_commands: readonly string[];
  /** Where stuck work goes. Distinct from escalates_to, which is for decisions. */
  readonly escalates_on_failure_to: string | null;
  /** Declared dependencies on capabilities that do not exist yet. */
  readonly blocked_on: readonly string[];
  /** True when the role must detect and pin the project stack before acting. */
  readonly stack_aware: boolean;

  /** Markdown body: the human role definition. */
  readonly body: string;
  /** Repo-relative path of the highest-precedence file that defined this role. */
  readonly file: string;
  /** Which layer set each key, lowest to highest precedence. For `se roles --explain`. */
  readonly provenance: Readonly<Record<string, LayerName>>;
  /** Content hash over the normalised definition. Part XVII 63. */
  readonly hash: string;
}

export type LayerName = "builtin" | "user" | "project";

export const LAYER_ORDER: readonly LayerName[] = ["builtin", "user", "project"];
