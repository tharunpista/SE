import type { Role } from "../roles/types.ts";
import { departmentLabel } from "../roles/vocabulary.ts";

export interface RenderedFile {
  /** Path relative to the output root, forward-slashed. */
  readonly path: string;
  readonly contents: string;
}

export interface RenderResult {
  readonly files: readonly RenderedFile[];
  /** Capabilities a role declared that this host cannot provide. Never silent. */
  readonly unmapped: ReadonlyMap<string, readonly string[]>;
  /** Estimated tokens this host spends on always-loaded metadata. */
  readonly metadataTokens: number;
}

export interface HostAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Default output root, relative to the repo. */
  readonly defaultOut: string;
  /**
   * Absolute user-level output root, where the host looks for definitions that
   * apply to every project, or null when the host has no such location.
   *
   * Installing here makes the roster available everywhere, and charges its
   * always-loaded cost to every session in every project -- including ones
   * these roles have nothing to do with. That is a deliberate operator choice,
   * never the default.
   */
  readonly userOut: string | null;
  /**
   * Whether this host gives a file-writing role its own workspace (Part XV 53).
   *
   * Modelled per host rather than assumed, because reporting isolation that the
   * host does not provide tells the operator that parallel writers are safe
   * when they are not.
   */
  readonly providesWorkspaceIsolation: boolean;
  /**
   * Hard ceiling on always-loaded metadata tokens, or null when the host has
   * none. Exceeding it is a refusal, not a warning: the whole point of a
   * 220-role catalogue is that only the active roster is ever loaded.
   */
  readonly metadataTokenBudget: number | null;
  render(roles: readonly Role[], root?: string): RenderResult;
}

/**
 * Abstract capability -> concrete host tool.
 *
 * Role files declare capabilities, not host tool names, because the same role
 * must render for several hosts whose tool names differ and change. The
 * indirection is the only reason a role file written today still renders
 * correctly after a host renames a tool.
 */
export type CapabilityMap = Readonly<Record<string, readonly string[]>>;

/**
 * Token estimate. Deliberately a cheap approximation (~4 chars/token) rather
 * than a real tokenizer: the budget check needs to be conservative and
 * dependency-free, and being within ~15% is enough to keep a roster far away
 * from a host's ceiling. The estimate is rounded up, never down.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a host `description` from the role.
 *
 * This field is always loaded, for every rendered role, so it is the single
 * most expensive text in the system. It is written for delegation routing --
 * "use this when X" -- not as a summary for a human; the human-facing
 * definition is the body, which loads only when the role actually runs.
 */
export function routingDescription(role: Role, maxChars = 320): string {
  const trigger = role.activation
    .filter((a) => !/^always$/i.test(a.trim()))
    .slice(0, 2)
    .join("; ");

  // First sentence of the mission carries the responsibility.
  const firstSentence = role.mission.split(/(?<=\.)\s/)[0] ?? role.mission;
  // Native agent pickers are generally flat and alphabetically sorted. Put
  // the canonical section in the searchable description instead of changing
  // role ids or paths that users and handoffs already depend on.
  const parts = [`[${departmentLabel(role.department)}]`, firstSentence.trim()];
  if (trigger) parts.push(`Use for: ${trigger}.`);

  let out = parts.join(" ").replace(/\s+/g, " ").trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1).replace(/[\s,;:.]+\S*$/, "")}…`;
  }
  return out;
}

/**
 * Headings whose content exists to evaluate the role, not to instruct it while
 * it works. Matched on the wording the catalogue actually uses, with or without
 * the section number from origin-prompt 7.
 */
const EVAL_ONLY_HEADING = /^##\s+(?:16\.\s*)?(?:Acceptance tests?|Acceptance|Evaluation examples?)\b.*$/im;

/**
 * Remove the acceptance-test section from a rendered body.
 *
 * origin-prompt 7 requires every starter role to carry acceptance tests, and
 * Part XVIII requires them to be pinned and runnable -- but they are criteria
 * for judging the role, not instructions for performing the work. The rendered
 * body is loaded on every activation, so shipping them to the agent costs
 * tokens on every run and invites the agent to grade itself against the very
 * tests meant to grade it independently.
 *
 * The section stays in the role file, which is what the evaluation harness
 * reads. Failure modes (section 15) are deliberately *kept*: mitigations for
 * known failures change what the agent does, so they earn their tokens.
 */
export function stripEvalOnlySections(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const isHeading = /^##\s+/.test(line);
    if (isHeading) skipping = EVAL_ONLY_HEADING.test(line);
    if (!skipping) out.push(line);
  }

  // Collapse the trailing blank run the removal can leave behind.
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

/** Shared behavior rules for every loaded role definition and host adapter. */
export function renderRoleInstructions(body: string): string {
  return [
    stripEvalOnlySections(body),
    "",
    "## Execution contract",
    "",
    "- Confirm task, project, acceptance criteria and dependency state before acting. Live source and declared contracts win over memory and summaries.",
    "- With `se` and a terminal: start with `se memory context --query \"<task and area>\"` for bounded excerpts with line/hash provenance. Empty or failed retrieval: say so, read live source. This is local retrieval, not a whole-repo search.",
    "- Read manifests, lockfiles, CI config and existing conventions before choosing a package, command or architecture. Prefer installed dependencies. Never invent a package, command or tool result.",
    "- One accountable owner per artifact. A collaborator list is routing guidance, not proof this host can invoke another agent; if delegation is unavailable, return a handoff rather than claiming one was sent.",
    "- Every handoff names: task, project, sender, receiver, artifact path + revision, requested decision, acceptance criteria, checks with exact commands and exit codes (or why none apply), open risks, next owner. Delivery is not acceptance - the receiver accepts or names gaps.",
    "- Requirements, interface or ownership boundary changed? Stop dependent work and escalate. Never silently change another role's contract.",
    "- Report completed, verified, blocked and unverified separately. No `production-ready` without quality, security, operational and release evidence. No deploy or irreversible external action without explicit operator authorization.",
  ].join("\n");
}

/** Resolve declared capabilities to host tools, reporting what did not map. */
export function mapCapabilities(
  role: Role,
  map: CapabilityMap,
): { tools: string[]; unmapped: string[] } {
  const tools = new Set<string>();
  const unmapped: string[] = [];

  for (const capability of role.tools) {
    const mapped = map[capability];
    if (mapped === undefined) {
      unmapped.push(capability);
      continue;
    }
    for (const t of mapped) tools.add(t);
  }

  return { tools: [...tools].sort(), unmapped };
}
