import { describe, expect, test } from "bun:test";
import { closeRoster, isClosureMode } from "../src/roles/roster.ts";
import { resolveRoles } from "../src/roles/resolve.ts";
import type { Role } from "../src/roles/types.ts";

/*
 * "Select the frontend and the frontend works" is a claim about closure, not
 * about counting. A department installed without its escalation targets is a
 * set of specialists whose stuck work has no receiver -- the role names one,
 * the host has no such agent, and the handoff lands back on an operator who
 * never asked for it.
 */

const registry = resolveRoles(process.cwd());
const routable = registry.all.filter((r) => r.enabled && r.status === "active");
const starters = routable.filter((r) => r.tier === "starter");

function department(dept: string): Role[] {
  const inDept = routable.filter((r) => r.department === dept);
  return [...inDept, ...starters.filter((r) => r.department !== dept)];
}

/** Every escalation receiver a roster names, excluding the human operator. */
function escalationTargets(roles: readonly Role[]): Set<string> {
  const ids = new Set<string>();
  for (const role of roles) {
    for (const id of [role.escalates_to, role.escalates_on_failure_to]) {
      if (id && id !== "operator") ids.add(id);
    }
  }
  return ids;
}

describe("a selected department is self-sufficient after closure", () => {
  const departments = [...new Set(routable.map((r) => r.department))].sort();

  test("there is more than one department to check", () => {
    expect(departments.length).toBeGreaterThan(10);
  });

  for (const dept of departments) {
    test(`${dept}: every escalation target is installed`, () => {
      const base = department(dept);
      const closed = [...base, ...closeRoster(base, routable, "escalation")];
      const installed = new Set(closed.map((r) => r.id));

      const unreachable = [...escalationTargets(closed)].filter((id) => !installed.has(id)).sort();
      expect(unreachable).toEqual([]);
    });
  }
});

describe("closure adds what is needed and nothing else", () => {
  test("backend-and-data is missing two escalation targets without closure", () => {
    // Regression guard for the specific gap this was built to fix: the
    // department's roles escalate to architects that the starter roster does
    // not carry.
    const base = department("backend-and-data");
    expect(closeRoster(base, routable, "escalation").map((r) => r.id).sort()).toEqual([
      "data-architect",
      "security-architect",
    ]);
  });

  test("a roster that is already closed gains nothing", () => {
    const base = department("frontend");
    expect(closeRoster(base, routable, "escalation")).toEqual([]);
  });

  test("closure is idempotent: closing a closed roster is a no-op", () => {
    const base = department("backend-and-data");
    const once = [...base, ...closeRoster(base, routable, "escalation")];
    expect(closeRoster(once, routable, "escalation")).toEqual([]);
  });

  test("none disables closure entirely", () => {
    const base = department("backend-and-data");
    expect(closeRoster(base, routable, "none")).toEqual([]);
  });

  test("no role is added twice, even when several roles escalate to it", () => {
    const base = department("backend-and-data");
    const added = closeRoster(base, routable, "escalation").map((r) => r.id);
    expect(added.length).toBe(new Set(added).size);
  });

  test("the operator is never added as an agent", () => {
    for (const dept of ["frontend", "orchestration", "security-and-privacy"]) {
      const added = closeRoster(department(dept), routable, "escalation");
      expect(added.map((r) => r.id)).not.toContain("operator");
    }
  });

  /*
   * Collaborator closure is offered but not default, and this is the
   * measurement that decides it: it roughly doubles a roster, which is what
   * pushes a render through the host's always-loaded metadata budget.
   */
  test("collaborator closure is substantially larger, which is why it is opt-in", () => {
    const base = department("security-and-privacy");
    const esc = closeRoster(base, routable, "escalation").length;
    const col = closeRoster(base, routable, "collaborators").length;
    expect(col).toBeGreaterThan(esc + 10);
  });
});

describe("the closure flag is validated, not coerced", () => {
  test("known modes are accepted", () => {
    for (const mode of ["escalation", "collaborators", "none"]) {
      expect(isClosureMode(mode)).toBe(true);
    }
  });

  test("an unknown mode is rejected rather than silently defaulted", () => {
    for (const mode of ["", "ESCALATION", "all", "transitive"]) {
      expect(isClosureMode(mode)).toBe(false);
    }
  });
});
