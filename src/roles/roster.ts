/**
 * Roster closure: the roles a selection is missing in order to stand on its own.
 *
 * Kept out of cli.ts because the entry point runs on import, and this rule is
 * worth testing directly.
 */

import type { Registry } from "./resolve.ts";
import type { Role } from "./types.ts";
import { findTopic, resolveTopic, suggestTopic } from "./topics.ts";
import { DEPARTMENTS } from "./vocabulary.ts";

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


export interface RosterRequest {
  /** --roster a,b,c */
  readonly roster?: string | undefined;
  /** --topic <id> */
  readonly topic?: string | undefined;
  /** --dept <name> */
  readonly dept?: string | undefined;
  /** --all */
  readonly all?: boolean;
  readonly closure?: ClosureMode;
}

export type RosterSelection =
  | { readonly ok: true; readonly roles: readonly Role[]; readonly label: string; readonly added: readonly Role[] }
  | { readonly ok: false; readonly message: string; readonly exitCode: 1 | 2 };

/**
 * Resolve a roster request into roles.
 *
 * Shared by `se render` and `se agents enable`, which previously each had their
 * own selection code: render understood --dept and --topic, enable understood
 * only --roster and --all, and neither applied escalation closure in the other's
 * path. Two commands that both answer "which roles" must answer it the same
 * way, or the roster an operator installs globally differs from the one they
 * previewed.
 */
export function selectRoster(
  registry: Registry,
  request: RosterRequest,
): RosterSelection {
  const routable = registry.all.filter((r) => r.enabled && r.status === "active");
  let roles: readonly Role[];
  let label: string;

  if (request.roster !== undefined) {
    const wanted = request.roster.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = wanted.filter((id) => !registry.byId.has(id));
    if (missing.length > 0) {
      return { ok: false, message: `unknown role id(s): ${missing.join(", ")}`, exitCode: 2 };
    }
    roles = wanted.map((id) => registry.byId.get(id)!);
    label = `explicit roster (${wanted.length})`;
  } else if (request.topic !== undefined) {
    const topic = findTopic(request.topic);
    if (!topic) {
      return { ok: false, message: `unknown topic "${request.topic}".${suggestTopic(request.topic)}`, exitCode: 2 };
    }
    const { roles: members, missing } = resolveTopic(topic, registry.byId);
    if (missing.length > 0) {
      // Validation rejects this, so reaching it means the catalogue was edited
      // past the gate. Report rather than installing a partial topic.
      return { ok: false, message: `topic "${topic.id}" names unknown role(s): ${missing.join(", ")}`, exitCode: 1 };
    }
    const enabled = members.filter((r) => r.enabled && r.status === "active");
    // A topic is a set of specialists with no orchestrator, no requirements
    // owner and no verification among them, so the starter roster comes too.
    const starters = routable.filter((r) => r.tier === "starter" && !enabled.some((m) => m.id === r.id));
    roles = [...enabled, ...starters];
    label = `topic ${topic.id} (${enabled.length}) + starter roster (${starters.length})`;
  } else if (request.dept !== undefined) {
    if (!DEPARTMENTS.includes(request.dept)) {
      return { ok: false, message: `unknown department "${request.dept}".
known: ${DEPARTMENTS.join(", ")}`, exitCode: 2 };
    }
    const inDept = routable.filter((r) => r.department === request.dept);
    const starters = routable.filter((r) => r.tier === "starter" && r.department !== request.dept);
    roles = [...inDept, ...starters];
    label = `department ${request.dept} (${inDept.length}) + starter roster (${starters.length})`;
  } else if (request.all === true) {
    roles = routable;
    label = `entire catalogue (${routable.length})`;
  } else {
    roles = routable.filter((r) => r.tier === "starter");
    label = `starter roster (${roles.length})`;
  }

  if (roles.length === 0) {
    return { ok: false, message: "no roles selected. Nothing to render.", exitCode: 1 };
  }

  const added = closeRoster(roles, routable, request.closure ?? "escalation");
  if (added.length > 0) {
    roles = [...roles, ...added];
    label += ` + ${added.length} escalation target(s)`;
  }
  return { ok: true, roles, label, added };
}
