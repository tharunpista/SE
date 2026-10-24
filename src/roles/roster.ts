/**
 * Roster closure: the roles a selection is missing in order to stand on its own.
 *
 * Kept out of cli.ts because the entry point runs on import, and this rule is
 * worth testing directly.
 */

import type { Role } from "./types.ts";

export type ClosureMode = "escalation" | "collaborators" | "none";

export function isClosureMode(value: string): value is ClosureMode {
  return value === "escalation" || value === "collaborators" || value === "none";
}

/**
 * The roles a roster is missing in order to be self-sufficient.
 *
 * A roster whose escalation targets are not installed is a roster where stuck
 * work has nowhere to go: the role names a receiver, the host has no such
 * agent, and the handoff is returned to an operator who never asked for it.
 * `escalates_to` and `escalates_on_failure_to` are therefore hard dependencies
 * and are pulled in by default.
 *
 * `collaborators` deliberately is not. It is routing metadata rather than
 * delegation -- the generated AGENTS.md says exactly that -- and closing over
 * it adds 21 roles to security-and-privacy and 27 to backend-and-data, roughly
 * doubling the roster and pushing it through the host's always-loaded metadata
 * budget. `--closure collaborators` asks for that set explicitly.
 *
 * Escalation closure runs to a fixed point, because one level is not enough: a
 * role pulled in to receive an escalation escalates somewhere itself, and
 * stopping after one pass leaves exactly the gap this function exists to close
 * (ai-and-agent-systems was still unreachable at one level). Termination is
 * guaranteed by the catalogue's own integrity rule that escalation cycles are
 * rejected, so the graph is acyclic and finite.
 *
 * Collaborator closure stays one level deep. It is already large, and a
 * transitive pass over routing metadata would pull in most of the catalogue.
 */
export function closeRoster(
  selected: readonly Role[],
  available: readonly Role[],
  mode: ClosureMode,
): Role[] {
  if (mode === "none") return [];

  const byId = new Map(available.map((r) => [r.id, r] as const));
  const chosen = new Set(selected.map((r) => r.id));
  const added: Role[] = [];

  // A work queue, so roles pulled in are themselves closed over.
  const queue: Role[] = [...selected];
  for (let i = 0; i < queue.length; i++) {
    const role = queue[i]!;
    const targets = [role.escalates_to, role.escalates_on_failure_to];
    // Collaborators are expanded only for the originally selected roles, never
    // for roles closure itself added, or the set grows without a useful bound.
    if (mode === "collaborators" && i < selected.length) targets.push(...role.collaborators);

    for (const id of targets) {
      // `operator` is the human, not a role, and resolves to no agent.
      if (!id || id === "operator" || chosen.has(id)) continue;
      const target = byId.get(id);
      if (!target) continue;
      chosen.add(id);
      added.push(target);
      queue.push(target);
    }
  }
  return added;
}
