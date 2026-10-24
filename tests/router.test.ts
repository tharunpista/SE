import { describe, expect, test } from "bun:test";
import { renderRouterSkill, ROUTER_SKILL_ID } from "../src/render/router.ts";
import { claudeSkillsAdapter } from "../src/render/agent-skills.ts";
import { resolveRoles } from "../src/roles/resolve.ts";
import type { Role } from "../src/roles/types.ts";

/*
 * The router exists because a roster of equally-reachable specialists routes an
 * unscoped request to whichever description matches the words, and "build me a
 * website" matches an implementer. These tests hold the two properties that
 * make it trustworthy: it is derived from the roster it ships with, and it
 * refuses to exist when it would name a receiver the host has not installed.
 */

const registry = resolveRoles(process.cwd());
const routable = registry.all.filter((r) => r.enabled && r.status === "active");
const byId = (id: string): Role => {
  const role = registry.byId.get(id);
  if (!role) throw new Error(`fixture expects role ${id} to exist`);
  return role;
};

const starters = routable.filter((r) => r.tier === "starter");

function frontmatter(contents: string): Record<string, string> {
  const end = contents.indexOf("\n---", 4);
  const out: Record<string, string> = {};
  for (const line of contents.slice(4, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

describe("the router is derived from the roster, never hand-maintained", () => {
  test("it lists only roles that are actually installed", () => {
    const roster = [byId("frontend-lead"), byId("requirements-engineer"), byId("qa-lead")];
    const contents = renderRouterSkill(roster)!.contents;

    expect(contents).toContain("`frontend-lead`");
    // A role outside the roster must not appear: naming it would route work to
    // a receiver this host cannot reach.
    expect(contents).not.toContain("`ios-application-engineer`");
  });

  test("the ownership index maps an artifact to the role that owns it", () => {
    const contents = renderRouterSkill([
      byId("backend-lead"),
      byId("requirements-engineer"),
    ])!.contents;
    expect(contents).toContain("| `api-endpoint` | `backend-lead` |");
    expect(contents).toContain("| `acceptance-criteria` | `requirements-engineer` |");
  });

  test("every artifact in the index is owned by a role in the roster", () => {
    const roster = starters;
    const contents = renderRouterSkill(roster)!.contents;
    const installed = new Set(roster.map((r) => r.id));

    const rows = [...contents.matchAll(/^\| `([a-z0-9-]+)` \| (.+) \|$/gm)];
    expect(rows.length).toBeGreaterThan(5);
    for (const [, , ownerCell] of rows) {
      for (const owner of [...ownerCell!.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!)) {
        expect(installed.has(owner)).toBe(true);
      }
    }
  });

  test("a role added to the roster changes the router in the same render", () => {
    const without = renderRouterSkill([byId("requirements-engineer"), byId("qa-lead")])!.contents;
    const with_ = renderRouterSkill([
      byId("requirements-engineer"),
      byId("qa-lead"),
      byId("database-engineer"),
    ])!.contents;
    expect(without).not.toContain("`database-engineer`");
    expect(with_).toContain("`database-engineer`");
  });
});

/*
 * Refusing to render is the important behaviour. A router that names
 * `requirements-engineer` on a host with no such agent reports work as routed
 * when nothing received it, which is worse than having no router at all.
 */
describe("the router refuses rather than naming an absent receiver", () => {
  test("no scoping role in the roster means no router", () => {
    expect(renderRouterSkill([byId("frontend-lead"), byId("backend-lead")])).toBeNull();
  });

  test("the orchestrator alone is enough, and becomes the scoper", () => {
    const rendered = renderRouterSkill([byId("chief-orchestrator"), byId("frontend-lead")]);
    expect(rendered).not.toBeNull();
    expect(rendered!.contents).toContain("goes to `chief-orchestrator`");
  });

  test("the requirements owner is preferred over the orchestrator when both exist", () => {
    const rendered = renderRouterSkill([
      byId("chief-orchestrator"),
      byId("requirements-engineer"),
    ])!;
    expect(rendered.contents).toContain("goes to `requirements-engineer`");
  });

  test("a single-role roster has nothing to route between", () => {
    expect(renderRouterSkill([byId("requirements-engineer")])).toBeNull();
  });
});

describe("the classifier keeps the unscoped request away from implementers", () => {
  const contents = renderRouterSkill(starters)!.contents;

  test("an unscoped build request is named explicitly, in the words users type", () => {
    for (const phrase of ["build me a website", "make an app", "create a dashboard"]) {
      expect(contents).toContain(phrase);
    }
  });

  test("it instructs against routing an unscoped request to an implementer", () => {
    expect(contents).toContain("Do **not** route this to an implementer");
  });

  test("stuck work routes to the investigator, not back to the role that got stuck", () => {
    expect(contents).toContain("`root-cause-investigator`");
  });

  /*
   * The guards matter more than the questions. A system that interrogates
   * before a throwaway page is abandoned, and then protects nobody.
   */
  test("asking is bounded, escapable, and never repeated", () => {
    expect(contents).toContain("at most five");
    expect(contents).toContain("Ask once");
    expect(contents).toContain('"Just build it" ends the protocol');
    expect(contents).toContain("Never ask when the work is cheap and reversible");
    expect(contents).toContain("Never ask what the repository answers");
  });

  test("every question carries the default it would otherwise assume", () => {
    // Without a stated default the operator must answer all five; with one they
    // can accept the set in a word.
    const rows = [...contents.matchAll(/^\| (Who uses it|Where does|Does it|Does it need).+\|$/gm)];
    expect(rows.length).toBe(5);
    for (const [row] of rows) expect(row.split("|").length).toBe(5);
  });

  test("assumptions are stated whether or not anything was asked", () => {
    expect(contents).toContain("State assumptions whether or not you asked");
  });
});

describe("the router ships with the skills it describes", () => {
  test("rendering a roster emits the router alongside the roles", () => {
    const rendered = claudeSkillsAdapter.render(starters);
    const paths = rendered.files.map((f) => f.path);
    expect(paths).toContain(`${ROUTER_SKILL_ID}/SKILL.md`);
    expect(paths).toContain("requirements-engineer/SKILL.md");
  });

  test("the router declares when_to_use, which the host folds into its tool description", () => {
    const rendered = claudeSkillsAdapter.render(starters);
    const router = rendered.files.find((f) => f.path === `${ROUTER_SKILL_ID}/SKILL.md`)!;
    const fm = frontmatter(router.contents);
    expect(fm["name"]).toBe(ROUTER_SKILL_ID);
    expect(fm["when_to_use"]).toContain("build me a website");
  });

  test("role skills carry when_to_use derived from their activation facts", () => {
    const rendered = claudeSkillsAdapter.render([byId("frontend-lead"), byId("requirements-engineer")]);
    const skill = rendered.files.find((f) => f.path === "frontend-lead/SKILL.md")!;
    const fm = frontmatter(skill.contents);
    expect(fm["when_to_use"]).toContain("Use when:");
    // Derived from the reviewed activation list, not invented by the renderer.
    expect(fm["when_to_use"]).toContain("user-facing surface");
  });

  test("`always` is not a routing fact and is excluded from when_to_use", () => {
    const rendered = claudeSkillsAdapter.render([byId("backend-lead"), byId("requirements-engineer")]);
    const fm = frontmatter(rendered.files.find((f) => f.path === "backend-lead/SKILL.md")!.contents);
    // backend-lead activates on "always" plus a real fact; only the fact is useful.
    expect(fm["when_to_use"]).not.toContain("always");
    expect(fm["when_to_use"]).toContain("server-side");
  });

  test("every emitted skill has valid, parseable frontmatter", () => {
    for (const file of claudeSkillsAdapter.render(starters).files) {
      expect(file.contents.startsWith("---\n")).toBe(true);
      const fm = frontmatter(file.contents);
      expect(fm["name"]).toBeDefined();
      expect(fm["description"]!.length).toBeGreaterThan(10);
    }
  });
});
