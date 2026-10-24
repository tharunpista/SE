import { describe, expect, test } from "bun:test";
import { renderTopicSkills } from "../src/render/router.ts";
import { claudeSkillsAdapter } from "../src/render/agent-skills.ts";
import { checkTopics, findTopic, resolveTopic, TOPICS, uncoveredRoles } from "../src/roles/topics.ts";
import { resolveRoles } from "../src/roles/resolve.ts";
import { Diagnostics } from "../src/util/diagnostics.ts";
import type { Role } from "../src/roles/types.ts";

/*
 * A department is where a role reports. A topic is what an operator types.
 * "auth" is owned by five roles across three departments, so no department
 * selection and no role name reaches that set from the word someone used --
 * which is the entire reason this axis exists.
 */

const registry = resolveRoles(process.cwd());
const byId = registry.byId;
const role = (id: string): Role => {
  const r = byId.get(id);
  if (!r) throw new Error(`fixture expects role ${id}`);
  return r;
};

function frontmatter(contents: string): Record<string, string> {
  const end = contents.indexOf("\n---", 4);
  const out: Record<string, string> = {};
  for (const line of contents.slice(4, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

describe("the shipped topics are internally consistent", () => {
  test("the catalogue's own topics pass integrity with no findings", () => {
    const diags = new Diagnostics();
    checkTopics(byId, diags);
    expect(diags.sorted()).toEqual([]);
  });

  test("every topic names at least two roles, or it is not a group", () => {
    for (const topic of TOPICS) expect(topic.roles.length).toBeGreaterThan(1);
  });

  test("every topic role resolves to a real, active role", () => {
    for (const topic of TOPICS) {
      const { roles, missing } = resolveTopic(topic, byId);
      expect(missing).toEqual([]);
      for (const r of roles) {
        expect(r.enabled).toBe(true);
        expect(r.status).toBe("active");
      }
    }
  });

  test("no keyword is claimed by two topics", () => {
    const owner = new Map<string, string>();
    for (const topic of TOPICS) {
      for (const keyword of topic.keywords) {
        const k = keyword.toLowerCase().trim();
        expect(owner.get(k) ?? topic.id).toBe(topic.id);
        owner.set(k, topic.id);
      }
    }
  });

  test("topics cut across departments rather than restating them", () => {
    // A topic confined to one department would be a department by another name.
    const spanning = TOPICS.filter((t) => {
      const depts = new Set(resolveTopic(t, byId).roles.map((r) => r.department));
      return depts.size > 1;
    });
    expect(spanning.length).toBeGreaterThanOrEqual(TOPICS.length - 2);
  });

  test("auth spans three departments, which is the case departments cannot serve", () => {
    const depts = new Set(resolveTopic(findTopic("auth")!, byId).roles.map((r) => r.department));
    expect(depts.size).toBeGreaterThanOrEqual(3);
  });

  test("coverage is reported, not enforced", () => {
    // Reported by `se topics` rather than as a validation finding: a specialist
    // nobody arrives looking for by keyword is legitimately uncovered.
    const uncovered = uncoveredRoles(byId);
    expect(Array.isArray(uncovered)).toBe(true);
    const covered = new Set(TOPICS.flatMap((t) => t.roles));
    for (const id of uncovered) expect(covered.has(id)).toBe(false);
  });
});

describe("topic integrity rejects what would misroute work", () => {
  function check(topics: readonly unknown[]): string[] {
    // checkTopics reads the shipped TOPICS, so defects are asserted through the
    // real data above; here the rules themselves are exercised by construction.
    const diags = new Diagnostics();
    const map = new Map(byId);
    for (const t of topics as { roles: string[] }[]) {
      for (const id of t.roles) if (!map.has(id)) map.delete(id);
    }
    checkTopics(map, diags);
    return diags.sorted().map((d) => d.code);
  }

  test("removing a role a topic depends on produces topic/unknown-role", () => {
    const shrunk = new Map(byId);
    shrunk.delete("authorization-model-engineer");
    const diags = new Diagnostics();
    checkTopics(shrunk, diags);
    expect(diags.sorted().map((d) => d.code)).toContain("topic/unknown-role");
  });

  test("the finding names the topic and the role, so it is actionable", () => {
    const shrunk = new Map(byId);
    shrunk.delete("privacy-engineer");
    const diags = new Diagnostics();
    checkTopics(shrunk, diags);
    const d = diags.sorted().find((x) => x.code === "topic/unknown-role")!;
    expect(d.message).toContain("privacy-engineer");
    expect(d.key).toBeDefined();
  });

  test("an intact catalogue produces no findings", () => {
    expect(check([])).toEqual([]);
  });
});

describe("a topic skill carries the words an operator types", () => {
  const roster = resolveTopic(findTopic("auth")!, byId).roles;

  test("when_to_use lists the topic's keywords, which is what makes it reachable", () => {
    const fm = frontmatter(renderTopicSkills(roster)[0]!.contents);
    for (const keyword of ["auth", "login", "oauth", "rbac", "session"]) {
      expect(fm["when_to_use"]).toContain(keyword);
    }
  });

  test("it names every installed member with what that role owns", () => {
    const contents = renderTopicSkills(roster)[0]!.contents;
    for (const r of roster) expect(contents).toContain(`\`${r.id}\``);
    expect(contents).toContain("`authorization-model`");
  });

  test("a mission containing a pipe cannot break the generated table", () => {
    for (const file of renderTopicSkills(roster)) {
      for (const line of file.contents.split("\n")) {
        if (line.startsWith("| `")) expect(line.split("|").length).toBe(5);
      }
    }
  });

  /*
   * Presenting three of eight roles as the whole answer is the failure this
   * avoids: the operator cannot ask for a role they were never told exists.
   */
  test("absent members are named with the command that installs them", () => {
    const partial = [role("security-architect"), role("privacy-engineer")];
    const contents = renderTopicSkills(partial).find((f) => f.path === "topic-auth/SKILL.md")!.contents;
    expect(contents).toContain("Not installed in this roster");
    expect(contents).toContain("`authorization-model-engineer`");
    expect(contents).toContain("se render --topic auth");
  });

  test("a roster holding one member of a topic emits no topic skill", () => {
    const paths = renderTopicSkills([role("cryptography-key-management-engineer")]).map((f) => f.path);
    expect(paths).not.toContain("topic-auth/SKILL.md");
  });

  test("a roster holding none of a topic's roles emits no topic skill", () => {
    const paths = renderTopicSkills([role("ux-researcher"), role("visual-ui-designer")]).map((f) => f.path);
    expect(paths).not.toContain("topic-auth/SKILL.md");
  });
});

describe("topic skills ship with the roster", () => {
  test("rendering a topic roster emits its topic skill and its role skills", () => {
    const roster = resolveTopic(findTopic("database")!, byId).roles;
    const paths = claudeSkillsAdapter.render(roster).files.map((f) => f.path);
    expect(paths).toContain("topic-database/SKILL.md");
    expect(paths).toContain("database-migration-engineer/SKILL.md");
  });

  test("every generated skill name is unique, so none overwrites another", () => {
    const roster = registry.all.filter((r) => r.enabled && r.status === "active");
    const paths = claudeSkillsAdapter.render(roster).files.map((f) => f.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  test("topic skills do not collide with role skills of the same subject", () => {
    // `topic-frontend` and the role `frontend-lead` must remain distinct files.
    const roster = registry.all.filter((r) => r.enabled && r.status === "active");
    const paths = new Set(claudeSkillsAdapter.render(roster).files.map((f) => f.path));
    expect(paths.has("topic-frontend/SKILL.md")).toBe(true);
    expect(paths.has("frontend-lead/SKILL.md")).toBe(true);
  });
});
