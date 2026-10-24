import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEYS } from "../src/roles/validate.ts";
import { CAPABILITY_KINDS } from "../src/roles/vocabulary.ts";

/*
 * `schemas/role.schema.json` is published under a public `$id`, so anyone may
 * tool against it. Nothing in this repository consumed it, and it had quietly
 * drifted five keys behind the validator -- with `additionalProperties: false`,
 * meaning the published contract rejected all 191 roles in the repository that
 * declared it.
 *
 * The fix is not a one-off correction; it is this file. The hand-written
 * validator stays the implementation, and these tests fail the moment the
 * published schema stops describing it.
 */

const root = join(import.meta.dir, "..");

function roleSchema(): {
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
} {
  return JSON.parse(readFileSync(join(root, "schemas", "role.schema.json"), "utf8"));
}

function vocabulary(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "schemas", "vocabulary.json"), "utf8"));
}

describe("the published role schema describes the validator that is actually run", () => {
  test("every key the validator accepts is declared in the schema", () => {
    const declared = new Set(Object.keys(roleSchema().properties));
    const missing = [...KNOWN_KEYS].filter((k) => !declared.has(k)).sort();
    expect(missing).toEqual([]);
  });

  test("the schema declares no key the validator would reject as unknown", () => {
    const extra = Object.keys(roleSchema().properties)
      .filter((k) => !KNOWN_KEYS.has(k))
      .sort();
    expect(extra).toEqual([]);
  });

  /*
   * Fail-closed is the property that makes a typo an error rather than a
   * silently disabled role, and it is asserted rather than assumed: flipping it
   * to true would make the two checks above meaningless.
   */
  test("the schema stays fail-closed on unknown keys", () => {
    expect(roleSchema().additionalProperties).toBe(false);
  });

  test("required keys are a subset of declared keys", () => {
    const declared = new Set(Object.keys(roleSchema().properties));
    for (const key of roleSchema().required) expect(declared.has(key)).toBe(true);
  });
});

describe("closed vocabularies stay closed", () => {
  test("tools is constrained to the capability vocabulary, not left as a free string", () => {
    const tools = roleSchema().properties["tools"] as { items?: { $ref?: string } };
    expect(tools.items?.$ref).toBe("vocabulary.json#/capabilities");
  });

  test("every vocabulary a schema $ref points at exists", () => {
    const vocab = vocabulary();
    const refs = [...JSON.stringify(roleSchema()).matchAll(/vocabulary\.json#\/([a-z_]+)/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) expect(vocab[ref]).toBeDefined();
  });

  test("the capability vocabulary covers every capability the renderers map", () => {
    // The renderers are the consumers; a capability they can map but the
    // vocabulary forbids would be unusable, and the reverse is a silent drop.
    for (const capability of ["read-files", "search", "write-files", "run-shell", "run-tests"]) {
      expect(CAPABILITY_KINDS.has(capability)).toBe(true);
    }
  });
});
