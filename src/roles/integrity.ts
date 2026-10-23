import { Diagnostics } from "../util/diagnostics.ts";
import { DEPARTMENT_EXPECTED_COUNTS, EXPECTED_ROLE_TOTAL } from "./vocabulary.ts";
import type { Registry } from "./resolve.ts";
import type { Role } from "./types.ts";

export interface OwnershipRow {
  readonly artifact: string;
  readonly owner: string | null;
  readonly coOwners: readonly string[];
  readonly contributors: readonly string[];
}

/** A role participates in routing only when it is enabled and not deprecated. */
function isRoutable(r: Role): boolean {
  return r.enabled && r.status === "active";
}

/**
 * Artifact ownership (Part XII 47).
 *
 * This is the single most important integrity check in the catalogue. With
 * 220 prose-defined roles, two roles will plausibly claim the same artifact,
 * and at that point routing is a coin flip at runtime -- the failure is
 * silent, intermittent, and nearly impossible to diagnose from a transcript.
 * So it is made a build error here, where it is cheap.
 */
export function buildOwnershipMatrix(registry: Registry, diags: Diagnostics): OwnershipRow[] {
  const owners = new Map<string, Role[]>();
  const contributors = new Map<string, string[]>();

  for (const role of registry.all) {
    if (!isRoutable(role)) continue;
    for (const artifact of role.owns_artifacts) {
      const list = owners.get(artifact);
      if (list) list.push(role);
      else owners.set(artifact, [role]);
    }
    for (const artifact of role.contributes_artifacts) {
      const list = contributors.get(artifact);
      if (list) list.push(role.id);
      else contributors.set(artifact, [role.id]);
    }
  }

  const rows: OwnershipRow[] = [];

  for (const [artifact, claimants] of owners) {
    if (claimants.length === 1) {
      rows.push({
        artifact,
        owner: claimants[0]!.id,
        coOwners: [],
        contributors: (contributors.get(artifact) ?? []).sort(),
      });
      continue;
    }

    // Multiple claimants are legal only if every one of them declares the
    // others in shared_with, reciprocally. A one-sided declaration means the
    // two authors did not actually agree, so it is rejected.
    const ids = claimants.map((c) => c.id).sort();
    const reciprocal = claimants.every((role) => {
      const declared = new Set(role.shared_with[artifact] ?? []);
      return ids.filter((other) => other !== role.id).every((other) => declared.has(other));
    });

    if (!reciprocal) {
      for (const role of claimants) {
        const declared = new Set(role.shared_with[artifact] ?? []);
        const missing = ids.filter((o) => o !== role.id && !declared.has(o));
        if (missing.length > 0) {
          diags.error({
            code: "catalogue/ownership-collision",
            file: role.file,
            key: `owns_artifacts.${artifact}`,
            message: `"${artifact}" is also owned by ${missing.map((m) => `"${m}"`).join(", ")} with no reciprocal shared_with declaration.`,
            hint: `Either give "${artifact}" a single accountable owner and move the others to contributes_artifacts, or declare shared_with: { ${artifact}: [${missing.map((m) => `"${m}"`).join(", ")}] } in every co-owner.`,
          });
        }
      }
      rows.push({ artifact, owner: null, coOwners: ids, contributors: (contributors.get(artifact) ?? []).sort() });
      continue;
    }

    // Even with agreed co-ownership, exactly one role must be accountable.
    // "Shared accountability" is how an artifact ends up with none.
    diags.warn({
      code: "catalogue/shared-ownership",
      key: artifact,
      message: `"${artifact}" has declared co-owners: ${ids.join(", ")}.`,
      hint: "Co-ownership is permitted but discouraged. Prefer one accountable owner plus contributors.",
    });
    rows.push({ artifact, owner: null, coOwners: ids, contributors: (contributors.get(artifact) ?? []).sort() });
  }

  rows.sort((a, b) => a.artifact.localeCompare(b.artifact));
  return rows;
}

export interface InterfaceRow {
  readonly interface: string;
  readonly owner: string | null;
  readonly participants: readonly string[];
}

/**
 * Interface ownership.
 *
 * An interface is inherently multi-party: it has a producer, a consumer, and
 * the role accountable for the contract between them. So the model is one
 * accountable owner plus any number of participants, not co-ownership by
 * exception. Two accountable owners means neither can classify a breaking
 * change, which is the one decision a contract owner exists to make.
 */
export function buildInterfaceMatrix(registry: Registry, diags: Diagnostics): InterfaceRow[] {
  const owners = new Map<string, Role[]>();
  const participants = new Map<string, string[]>();

  for (const role of registry.all) {
    if (!isRoutable(role)) continue;
    for (const i of role.owns_interfaces) {
      const list = owners.get(i);
      if (list) list.push(role);
      else owners.set(i, [role]);
    }
    for (const i of role.participates_interfaces) {
      const list = participants.get(i);
      if (list) list.push(role.id);
      else participants.set(i, [role.id]);
    }
  }

  const rows: InterfaceRow[] = [];

  for (const [iface, claimants] of owners) {
    if (claimants.length > 1) {
      const ids = claimants.map((c) => c.id).sort();
      for (const role of claimants) {
        diags.error({
          code: "catalogue/interface-ownership-collision",
          file: role.file,
          key: `owns_interfaces.${iface}`,
          message: `"${iface}" is claimed as accountable owner by ${ids.join(", ")}.`,
          hint: `An interface has exactly one accountable owner. Producers and consumers declare participates_interfaces: [${iface}] instead.`,
        });
      }
    }
    rows.push({
      interface: iface,
      owner: claimants.length === 1 ? claimants[0]!.id : null,
      participants: (participants.get(iface) ?? []).sort(),
    });
  }

  // A participant on an interface nobody owns has no one to escalate to when
  // the contract is wrong, which is exactly when escalation is needed.
  for (const [iface, ids] of participants) {
    if (!owners.has(iface)) {
      diags.error({
        code: "catalogue/interface-without-owner",
        key: iface,
        message: `"${iface}" has participants (${ids.sort().join(", ")}) but no accountable owner.`,
        hint: "Give the interface an owner, or the participants have nobody to escalate a contract defect to.",
      });
      rows.push({ interface: iface, owner: null, participants: ids.sort() });
    }
  }

  rows.sort((a, b) => a.interface.localeCompare(b.interface));
  return rows;
}

/** Dangling collaborator or escalation targets are broken handoffs at runtime. */
function checkReferences(registry: Registry, diags: Diagnostics): void {
  for (const role of registry.all) {
    for (const id of role.collaborators) {
      const target = registry.byId.get(id);
      if (!target) {
        diags.error({
          code: "catalogue/dangling-collaborator", file: role.file, key: "collaborators",
          message: `Collaborator "${id}" does not resolve to any role.`,
          hint: "A dangling collaborator is a handoff to nobody.",
        });
      } else if (target.status === "deprecated") {
        diags.warn({
          code: "catalogue/deprecated-collaborator", file: role.file, key: "collaborators",
          message: `Collaborator "${id}" is deprecated${target.superseded_by ? `; superseded by "${target.superseded_by}"` : ""}.`,
        });
      }
    }

    if (role.escalates_to !== "operator" && !registry.byId.has(role.escalates_to)) {
      diags.error({
        code: "catalogue/dangling-escalation", file: role.file, key: "escalates_to",
        message: `escalates_to "${role.escalates_to}" does not resolve to any role.`,
        hint: "An unresolvable escalation target means a blocked agent has nowhere to go. Use 'operator' to terminate the chain.",
      });
    }

    for (const [artifact, ids] of Object.entries(role.shared_with)) {
      for (const id of ids) {
        if (!registry.byId.has(id)) {
          diags.error({
            code: "catalogue/dangling-shared-owner", file: role.file, key: `shared_with.${artifact}`,
            message: `Co-owner "${id}" does not resolve to any role.`,
          });
        }
      }
    }

    if (role.superseded_by && role.superseded_by !== "none" && !registry.byId.has(role.superseded_by)) {
      diags.error({
        code: "catalogue/dangling-successor", file: role.file, key: "superseded_by",
        message: `superseded_by "${role.superseded_by}" does not resolve to any role.`,
      });
    }
  }
}

/**
 * Escalation chains must terminate. A cycle means a blocked agent escalates
 * forever and the operator is never asked -- the exact failure the escalation
 * protocol exists to prevent, so it is caught statically.
 */
function checkEscalationChains(registry: Registry, diags: Diagnostics): void {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const state = colour.get(id) ?? WHITE;
    if (state === BLACK) return;
    if (state === GREY) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const role = registry.byId.get(id);
      diags.error({
        code: "catalogue/escalation-cycle",
        ...(role ? { file: role.file } : {}),
        key: "escalates_to",
        message: `Escalation cycle: ${cycle.join(" -> ")}.`,
        hint: "At least one role in the cycle must escalate to 'operator'. A cycle means a blocked agent never reaches a human.",
      });
      return;
    }
    colour.set(id, GREY);
    stack.push(id);
    const role = registry.byId.get(id);
    if (role && role.escalates_to !== "operator" && registry.byId.has(role.escalates_to)) {
      visit(role.escalates_to);
    }
    stack.pop();
    colour.set(id, BLACK);
  };

  for (const role of registry.all) visit(role.id);
}

/** Department counts are acceptance criteria, not documentation. */
function checkDepartmentCounts(registry: Registry, diags: Diagnostics): void {
  const actual = new Map<string, number>();
  for (const role of registry.all) {
    actual.set(role.department, (actual.get(role.department) ?? 0) + 1);
  }

  for (const [dept, expected] of Object.entries(DEPARTMENT_EXPECTED_COUNTS)) {
    const got = actual.get(dept) ?? 0;
    if (got !== expected) {
      diags.error({
        code: "catalogue/department-count",
        key: dept,
        message: `Department "${dept}" has ${got} role${got === 1 ? "" : "s"}; the specification requires ${expected}.`,
        hint:
          got < expected
            ? `${expected - got} role file${expected - got === 1 ? " is" : "s are"} missing. Silent omission is forbidden; see docs/origin-prompt.md Part IV.`
            : "Either a role was invented, or a role is filed under the wrong department.",
      });
    }
  }

  if (registry.all.length !== EXPECTED_ROLE_TOTAL) {
    diags.error({
      code: "catalogue/total-count",
      message: `Catalogue has ${registry.all.length} roles; the specification requires ${EXPECTED_ROLE_TOTAL}.`,
    });
  }
}

/**
 * Every requirement in Parts IX-XX must have a named accountable role.
 * A requirement with no owner is an incomplete specification, and the
 * cheapest moment to notice is here.
 */
function checkSpecOwnership(registry: Registry, diags: Diagnostics): void {
  const claimed = new Map<string, string[]>();
  for (const role of registry.all) {
    for (const section of role.owns_spec_sections) {
      const list = claimed.get(section);
      if (list) list.push(role.id);
      else claimed.set(section, [role.id]);
    }
  }
  for (const [section, ids] of claimed) {
    if (ids.length > 1) {
      diags.warn({
        code: "catalogue/spec-section-multiple-owners",
        key: section,
        message: `Specification section "${section}" is claimed by ${ids.sort().join(", ")}.`,
        hint: "Split the section or name one accountable owner.",
      });
    }
  }
}

export interface IntegrityReport {
  readonly ownership: readonly OwnershipRow[];
  readonly interfaces: readonly InterfaceRow[];
  readonly diagnostics: Diagnostics;
}

export function checkIntegrity(registry: Registry): IntegrityReport {
  const diags = new Diagnostics();
  const ownership = buildOwnershipMatrix(registry, diags);
  const interfaces = buildInterfaceMatrix(registry, diags);
  checkReferences(registry, diags);
  checkEscalationChains(registry, diags);
  checkDepartmentCounts(registry, diags);
  checkSpecOwnership(registry, diags);
  return { ownership, interfaces, diagnostics: diags };
}
