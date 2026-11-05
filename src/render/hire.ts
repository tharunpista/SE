/**
 * `se hire <id>` -- assemble one specialist, at the moment it is needed.
 *
 * The alternative this replaces is keeping every role's routing description
 * resident so a model can choose between them. Measured on this catalogue that
 * is 16,730 tokens on *every* turn, against roughly 1,790 paid once for the one
 * role actually used. The roster was never the useful part; the chosen role is.
 *
 * Nothing here needs to "de-hire". A spawned subagent runs in its own context
 * and returns a report; the instructions assembled below never enter the
 * caller's context at all, so the cost ends when the task does. That is a
 * property of how the host spawns agents, not something this command arranges.
 */

import type { Role } from "../roles/types.ts";
import { mapCapabilities, renderRoleInstructions } from "./host.ts";
import { buildRoleFooter, CAPABILITIES, INTERNAL_CAPABILITIES, WRITE_TOOLS } from "./claude-code.ts";
import { resolveProjectFacts, renderFactsBlock, type ProjectFacts } from "../project-facts.ts";

export interface HirePayload {
  readonly role: string;
  readonly name: string;
  readonly department: string;
  /** Full instructions to hand a general-purpose agent as its prompt. */
  readonly prompt: string;
  /** Host tools the role declares, after the writes_files filter. */
  readonly tools: readonly string[];
  /** Capabilities this host cannot grant; the caller must not pretend otherwise. */
  readonly unmapped: readonly string[];
  readonly isolation: "worktree" | null;
  readonly max_turns: number;
  readonly context_budget_tokens: number;
  readonly escalates_to: string;
  readonly escalates_on_failure_to: string | null;
}

/**
 * Build the payload for one role.
 *
 * `facts` is passed in rather than resolved here so a caller hiring several
 * roles reads the manifest once.
 */
export function hire(role: Role, facts: ProjectFacts, catalogueRoot: string): HirePayload {
  const { tools, unmapped } = mapCapabilities(role, CAPABILITIES);
  const genuinelyUnmapped = unmapped.filter((c) => !INTERNAL_CAPABILITIES.has(c));

  /*
   * Same filter the renderer applies: a role declaring writes_files: false must
   * not receive Write or Edit even if it declares the capability. Repeating the
   * rule here rather than importing a shared helper would let the two drift, so
   * the constant is shared and the predicate is one line.
   */
  const effectiveTools = role.writes_files ? tools : tools.filter((t) => !WRITE_TOOLS.has(t));

  /*
   * The same footer the file renderer emits -- failure modes, resolved
   * verification commands, the stuck rule, evidence rule, stack discipline.
   * Built from the shared builder so a hired role and a rendered one cannot
   * carry different instructions.
   */
  const sections = [
    renderRoleInstructions(role.body),
    buildRoleFooter(role, catalogueRoot, effectiveTools, genuinelyUnmapped, facts).join("\n"),
    "",
    renderFactsBlock(facts),
  ];

  return {
    role: role.id,
    name: role.name,
    department: role.department,
    prompt: sections.filter((s) => s.length > 0).join("\n"),
    tools: effectiveTools,
    unmapped: genuinelyUnmapped,
    isolation: role.writes_files ? "worktree" : null,
    max_turns: role.max_calls,
    context_budget_tokens: role.context_budget_tokens,
    escalates_to: role.escalates_to,
    escalates_on_failure_to: role.escalates_on_failure_to,
  };
}

/**
 * Resolve the project's facts, then hire.
 *
 * The two roots are deliberately separate. Role definitions and the shared
 * engineering docs come from the *catalogue*; the verification commands must
 * come from the *project being worked in*. Conflating them resolved every
 * hire against the catalogue's own manifest, so a role hired into an npm
 * project was told to run `bun test` -- a command that does not exist there.
 * The bug was invisible while both happened to use the same runner.
 */
export function hireOne(role: Role, catalogueRoot: string, projectRoot: string): HirePayload {
  return hire(role, resolveProjectFacts(projectRoot), catalogueRoot);
}
