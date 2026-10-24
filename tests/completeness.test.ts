import { describe, expect, test } from "bun:test";
import {
  bodyWordCount,
  checkCompleteness,
  completenessFindings,
  MIN_BODY_WORDS,
  QUARANTINE,
  REQUIRED_CONCEPTS,
} from "../src/roles/completeness.ts";
import { resolveRoles } from "../src/roles/resolve.ts";
import { Diagnostics } from "../src/util/diagnostics.ts";

/*
 * The catalogue reached 191/191 by count while 30 roles were template fill.
 * Every gate passed them: CI checked for a 40-word floor and the absence of
 * TODO markers, and a 260-word role that says nothing specific clears both.
 * These tests hold the replacement honest -- that it catches the unfinished
 * roles, that it does not fire on the finished ones, and that the backlog
 * cannot grow.
 */

const registry = resolveRoles(process.cwd());
const all = registry.all.map((role) => ({
  id: role.id,
  file: role.file,
  body: role.body,
  ...(role.boundary ? { boundary: role.boundary } : {}),
  ...(role.verify_commands === undefined ? {} : { verifyCommands: role.verify_commands }),
}));

const FINISHED_BODY = [
  "## Mission",
  "A body long enough to clear the floor. ".repeat(55),
  "## Non-responsibilities",
  "- Does not own the neighbouring concern (Some Other Role).",
  "## Definition of done",
  "Every claim carries a command and its exit code.",
].join("\n\n");

function input(overrides: Partial<(typeof all)[number]> = {}) {
  return {
    id: "fixture-role",
    file: "se/agents/orchestration/fixture-role.md",
    body: FINISHED_BODY,
    boundary: "Owns X, not Y. The Neighbour Role owns Y.",
    verifyCommands: ["<project test command>"],
    ...overrides,
  };
}

describe("the rule fires on exactly what is unfinished", () => {
  test("a role meeting the bar produces no findings", () => {
    expect(completenessFindings(input())).toEqual([]);
  });

  test("boilerplate sections from the bulk batch are rejected", () => {
    const body = FINISHED_BODY + "\n\n## Role-specific operating procedure\n\nSomething generic.";
    const codes = completenessFindings(input({ body })).map((f) => f.code);
    expect(codes).toContain("role/template-section");
  });

  test("a body under the floor is rejected, and the floor is the thinnest finished role", () => {
    const codes = completenessFindings(input({ body: "## Mission\n\n## Non-responsibilities\n\n## Definition of done\n\nshort" })).map((f) => f.code);
    expect(codes).toContain("role/body-too-thin");
    expect(MIN_BODY_WORDS).toBeGreaterThan(300);
  });

  test("a boundary that names no neighbour is rejected", () => {
    const codes = completenessFindings(
      input({ boundary: "Owns the scoped responsibility described in the mission. Adjacent roles retain authority." }),
    ).map((f) => f.code);
    expect(codes).toContain("role/generic-boundary");
  });

  test("a placeholder verification command is rejected", () => {
    const codes = completenessFindings(
      input({ verifyCommands: ["<project-native verification command>"] }),
    ).map((f) => f.code);
    expect(codes).toContain("role/placeholder-verify-command");
  });

  test("a real project-shaped verification command is accepted", () => {
    expect(
      completenessFindings(input({ verifyCommands: ["<project test command> --filter docs"] })),
    ).toEqual([]);
  });

  test("each required concept is reported when absent", () => {
    for (const concept of REQUIRED_CONCEPTS) {
      const body = REQUIRED_CONCEPTS.filter((c) => c !== concept)
        .map((c) => `## ${c.name}`)
        .join("\n\n") + "\n\n" + "filler word ".repeat(400);
      const finding = completenessFindings(input({ body })).find((f) => f.code === "role/missing-sections");
      expect(finding?.message).toContain(concept.name);
    }
  });

  /*
   * The finished catalogue uses three structural variants. Requiring literal
   * headings failed 35 complete roles, so the concepts accept synonyms; this
   * is the test that stopped the rule being a house-style assertion.
   */
  test("an earlier structural variant is accepted, not failed for its wording", () => {
    const body = [
      "## Mission",
      "filler word ".repeat(400),
      "## Boundaries",
      "- Does not own the neighbour's concern.",
      "## Definition of done",
      "Evidence recorded.",
    ].join("\n\n");
    expect(completenessFindings(input({ body }))).toEqual([]);
  });

  test("a numbered sixteen-section role is accepted", () => {
    const body = [
      "## 2. Mission",
      "filler word ".repeat(400),
      "## 5. Explicit non-responsibilities",
      "- Not the neighbour's work.",
      "## 13. Definition of done",
      "Evidence recorded.",
    ].join("\n\n");
    expect(completenessFindings(input({ body }))).toEqual([]);
  });
});

describe("the real catalogue, measured", () => {
  test("no role outside the quarantine fails the bar", () => {
    const diags = new Diagnostics();
    checkCompleteness(all, diags);
    const errors = diags.sorted().filter((d) => d.severity === "error");
    expect(errors.map((d) => `${d.key}: ${d.code}`)).toEqual([]);
  });

  test("every quarantined id is a role that really exists", () => {
    for (const id of QUARANTINE) expect(registry.byId.has(id)).toBe(true);
  });

  /*
   * The quarantine is a debt register. If an entry no longer corresponds to a
   * defect the remaining count is a lie, so clearing a role and forgetting to
   * delist it is itself an error.
   */
  test("no quarantined role has quietly been finished without being delisted", () => {
    const diags = new Diagnostics();
    const { cleared } = checkCompleteness(all, diags);
    expect(cleared).toEqual([]);
  });

  test("the backlog may only shrink", () => {
    const diags = new Diagnostics();
    const { outstanding } = checkCompleteness(all, diags);
    // Tighten this number as roles are finished; it must never be raised.
    expect(outstanding.length).toBeLessThanOrEqual(QUARANTINE.length);
  });

  test("finished roles are substantially longer than the floor, not scraping it", () => {
    const quarantined = new Set<string>(QUARANTINE);
    const finished = all.filter((r) => !quarantined.has(r.id)).map((r) => bodyWordCount(r.body));
    const median = finished.sort((a, b) => a - b)[Math.floor(finished.length / 2)]!;
    expect(median).toBeGreaterThan(MIN_BODY_WORDS * 1.4);
  });
});
