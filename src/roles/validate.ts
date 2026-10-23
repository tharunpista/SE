import type { Diagnostics } from "../util/diagnostics.ts";
import {
  ARTIFACT_KINDS, CLI_COMMANDS, DEPARTMENTS, INTERFACE_KINDS, MEMORY_SCOPES, suggest,
} from "./vocabulary.ts";
import type { MemoryScope, Role, Tier } from "./types.ts";

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Every key the schema permits. Source of the fail-closed unknown-key check. */
const KNOWN_KEYS = new Set([
  "schema_version", "id", "name", "department", "tier", "mission", "activation",
  "tools", "memory_scopes", "owns_artifacts", "contributes_artifacts",
  "owns_interfaces", "participates_interfaces", "shared_with",
  "collaborators", "escalates_to",
  "context_budget_tokens", "max_calls", "enabled", "status", "supersedes",
  "superseded_by", "boundary", "requires_evidence", "writes_files",
  "owns_spec_sections", "verify_commands", "escalates_on_failure_to",
  "stack_aware", "blocked_on",
]);

const REQUIRED_KEYS = [
  "schema_version", "id", "name", "department", "tier", "mission", "activation",
  "tools", "memory_scopes", "owns_artifacts", "owns_interfaces",
  "collaborators", "escalates_to", "context_budget_tokens", "max_calls", "enabled",
] as const;

interface Ctx {
  readonly file: string;
  readonly diags: Diagnostics;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function strArray(ctx: Ctx, key: string, v: unknown, fallback: string[] = []): string[] {
  if (v === undefined) return fallback;
  if (!isStringArray(v)) {
    ctx.diags.error({
      code: "role/type", file: ctx.file, key,
      message: `Expected a list of strings, received ${Array.isArray(v) ? "a list with non-string members" : typeof v}.`,
    });
    return fallback;
  }
  const dupes = v.filter((x, i) => v.indexOf(x) !== i);
  if (dupes.length > 0) {
    ctx.diags.error({
      code: "role/duplicate-entry", file: ctx.file, key,
      message: `Duplicate entries: ${[...new Set(dupes)].join(", ")}.`,
    });
  }
  return v;
}

function checkVocabulary(
  ctx: Ctx, key: string, values: readonly string[], allowed: Set<string>, label: string,
): void {
  for (const value of values) {
    if (!allowed.has(value)) {
      ctx.diags.error({
        code: "role/unknown-vocabulary-term", file: ctx.file, key,
        message: `"${value}" is not a known ${label}.${suggest(value, allowed)}`,
        hint: "Use a term from schemas/vocabulary.json, or add one in a reviewed change. The vocabulary is closed on purpose: every term is a potential ownership collision.",
      });
    }
  }
}

/**
 * Validate a merged role.
 *
 * Validation deliberately runs on the merged result, not on each layer: an
 * override layer is a patch and is expected to be incomplete on its own.
 * Validating layers individually would make the most common customisation --
 * changing a single key -- impossible.
 */
export function validateRole(
  file: string,
  fm: Record<string, unknown>,
  body: string,
  diags: Diagnostics,
): Omit<Role, "provenance" | "hash"> | null {
  const ctx: Ctx = { file, diags };
  const before = diags.errorCount;

  // Fail-closed on unknown keys. A misspelled "enabled" would otherwise
  // silently leave a role active, which is the worst possible failure mode.
  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) {
      diags.error({
        code: "role/unknown-key", file, key,
        message: `Unknown frontmatter key "${key}".${suggest(key, KNOWN_KEYS)}`,
        hint: "Unknown keys are errors, not warnings, by design.",
      });
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (fm[key] === undefined) {
      diags.error({
        code: "role/missing-key", file, key,
        message: `Required key "${key}" is missing.`,
      });
    }
  }

  if (fm["schema_version"] !== undefined && fm["schema_version"] !== 1) {
    diags.error({
      code: "role/unsupported-schema-version", file, key: "schema_version",
      message: `Unsupported schema_version ${JSON.stringify(fm["schema_version"])}; this build understands 1.`,
      hint: "Run `se migrate` rather than editing the version by hand. An unknown version must fail loudly, never be guessed at.",
    });
  }

  const id = fm["id"];
  if (typeof id === "string" && !ID_RE.test(id)) {
    diags.error({
      code: "role/invalid-id", file, key: "id",
      message: `Role id "${id}" must be lower-case kebab-case.`,
      hint: "Ids are permanent. They are never renamed; retire a role with status: deprecated instead.",
    });
  }

  const department = fm["department"];
  if (typeof department === "string" && !DEPARTMENTS.includes(department)) {
    diags.error({
      code: "role/unknown-department", file, key: "department",
      message: `"${department}" is not a known department.${suggest(department, DEPARTMENTS)}`,
    });
  }

  const tier = fm["tier"];
  if (tier !== undefined && tier !== "starter" && tier !== "catalogue") {
    diags.error({
      code: "role/invalid-tier", file, key: "tier",
      message: `tier must be "starter" or "catalogue", received ${JSON.stringify(tier)}.`,
    });
  }

  const mission = fm["mission"];
  if (typeof mission === "string" && mission.trim().length < 24) {
    diags.error({
      code: "role/mission-too-short", file, key: "mission",
      message: "Mission is too short to be meaningful.",
      hint: "If the mission cannot be stated in a sentence, the role is not bounded and probably should not exist.",
    });
  }

  const activation = strArray(ctx, "activation", fm["activation"]);
  if (fm["activation"] !== undefined && activation.length === 0) {
    diags.error({
      code: "role/no-activation", file, key: "activation",
      message: "A role must declare at least one activation condition.",
      hint: "Activating a role requires a project fact, not a hunch.",
    });
  }
  if (tier === "catalogue" && activation.some((a) => /^always$/i.test(a.trim()))) {
    diags.error({
      code: "role/catalogue-always-active", file, key: "activation",
      message: "A catalogue role may not declare \"always\" as an activation condition.",
      hint: "Only starter-roster roles are active by default; everything else needs a triggering fact.",
    });
  }

  let read: MemoryScope[] = [];
  let write: MemoryScope[] = [];
  const ms = fm["memory_scopes"];
  if (ms !== undefined) {
    if (ms === null || typeof ms !== "object" || Array.isArray(ms)) {
      diags.error({
        code: "role/type", file, key: "memory_scopes",
        message: "memory_scopes must be a mapping with 'read' and 'write' lists.",
      });
    } else {
      const o = ms as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k !== "read" && k !== "write") {
          diags.error({
            code: "role/unknown-key", file, key: `memory_scopes.${k}`,
            message: `Unknown key "${k}" under memory_scopes; only 'read' and 'write' are permitted.`,
          });
        }
      }
      if (o["read"] === undefined) {
        diags.error({
          code: "role/missing-key", file, key: "memory_scopes.read",
          message: "memory_scopes.read is required. Access is deny-by-default: an absent scope is unreadable.",
        });
      }
      if (o["write"] === undefined) {
        diags.error({
          code: "role/missing-key", file, key: "memory_scopes.write",
          message: "memory_scopes.write is required; use an empty list for a read-only role.",
        });
      }
      read = strArray(ctx, "memory_scopes.read", o["read"]) as MemoryScope[];
      write = strArray(ctx, "memory_scopes.write", o["write"]) as MemoryScope[];
      checkVocabulary(ctx, "memory_scopes.read", read, MEMORY_SCOPES, "memory scope");
      checkVocabulary(ctx, "memory_scopes.write", write, MEMORY_SCOPES, "memory scope");

      for (const scope of write) {
        if (!read.includes(scope)) {
          diags.error({
            code: "role/write-without-read", file, key: "memory_scopes",
            message: `Role may write "${scope}" but not read it.`,
            hint: "Blind writes clobber records: the write protocol requires reading the current revision first (Part XX 72).",
          });
        }
      }
    }
  }

  const owns_artifacts = strArray(ctx, "owns_artifacts", fm["owns_artifacts"]);
  const contributes_artifacts = strArray(ctx, "contributes_artifacts", fm["contributes_artifacts"]);
  const owns_interfaces = strArray(ctx, "owns_interfaces", fm["owns_interfaces"]);
  const participates_interfaces = strArray(ctx, "participates_interfaces", fm["participates_interfaces"]);
  checkVocabulary(ctx, "owns_artifacts", owns_artifacts, ARTIFACT_KINDS, "artifact kind");
  checkVocabulary(ctx, "contributes_artifacts", contributes_artifacts, ARTIFACT_KINDS, "artifact kind");
  checkVocabulary(ctx, "owns_interfaces", owns_interfaces, INTERFACE_KINDS, "interface kind");
  checkVocabulary(ctx, "participates_interfaces", participates_interfaces, INTERFACE_KINDS, "interface kind");

  for (const i of participates_interfaces) {
    if (owns_interfaces.includes(i)) {
      diags.error({
        code: "role/owns-and-participates", file, key: "participates_interfaces",
        message: `"${i}" is listed in both owns_interfaces and participates_interfaces.`,
        hint: "Accountable ownership already implies participation. An interface has exactly one accountable owner and any number of participants.",
      });
    }
  }

  for (const a of contributes_artifacts) {
    if (owns_artifacts.includes(a)) {
      diags.error({
        code: "role/owns-and-contributes", file, key: "contributes_artifacts",
        message: `"${a}" is listed in both owns_artifacts and contributes_artifacts.`,
        hint: "Ownership already implies contribution. Listing both makes the accountable owner ambiguous.",
      });
    }
  }

  const shared_with: Record<string, string[]> = {};
  const sw = fm["shared_with"];
  if (sw !== undefined) {
    if (sw === null || typeof sw !== "object" || Array.isArray(sw)) {
      diags.error({
        code: "role/type", file, key: "shared_with",
        message: "shared_with must be a mapping of artifact kind to role ids.",
      });
    } else {
      for (const [artifact, ids] of Object.entries(sw as Record<string, unknown>)) {
        if (!ARTIFACT_KINDS.has(artifact)) {
          diags.error({
            code: "role/unknown-vocabulary-term", file, key: `shared_with.${artifact}`,
            message: `"${artifact}" is not a known artifact kind.${suggest(artifact, ARTIFACT_KINDS)}`,
          });
        }
        if (!owns_artifacts.includes(artifact)) {
          diags.error({
            code: "role/shared-without-ownership", file, key: `shared_with.${artifact}`,
            message: `shared_with declares co-ownership of "${artifact}" but the role does not list it in owns_artifacts.`,
            hint: "Declare the ownership you are sharing, or remove the shared_with entry.",
          });
        }
        shared_with[artifact] = strArray(ctx, `shared_with.${artifact}`, ids);
      }
    }
  }

  const collaborators = strArray(ctx, "collaborators", fm["collaborators"]);
  for (const c of collaborators) {
    if (!ID_RE.test(c)) {
      diags.error({
        code: "role/invalid-id", file, key: "collaborators",
        message: `Collaborator "${c}" is not a valid role id.`,
      });
    }
    if (typeof id === "string" && c === id) {
      diags.error({
        code: "role/self-collaborator", file, key: "collaborators",
        message: "A role may not list itself as a collaborator.",
      });
    }
  }

  const escalates_to = fm["escalates_to"];
  if (typeof escalates_to === "string") {
    if (escalates_to !== "operator" && !ID_RE.test(escalates_to)) {
      diags.error({
        code: "role/invalid-id", file, key: "escalates_to",
        message: `escalates_to must be a role id or "operator", received "${escalates_to}".`,
      });
    }
    if (escalates_to === id) {
      diags.error({
        code: "role/self-escalation", file, key: "escalates_to",
        message: "A role may not escalate to itself.",
        hint: "Self-escalation is an infinite loop at runtime; terminate the chain at another role or at 'operator'.",
      });
    }
  }

  /*
   * A role must not declare a file-writing capability while declaring that it
   * does not write files. The two are read by different consumers -- the
   * renderer maps `tools` to host tools, and gates workspace isolation on
   * `writes_files` -- so the contradiction previously produced the worst
   * available outcome: Write and Edit granted, with no isolated workspace,
   * because the same false flag that failed to withhold the tools also skipped
   * `isolation: worktree`.
   *
   * Rejected here, at the single source of truth, rather than compensated for
   * in each consumer.
   */
  if (fm["writes_files"] === false) {
    const declaredTools = strArray(ctx, "tools", fm["tools"]);
    const writeCapabilities = declaredTools.filter(
      (t) => t === "write-files" || t === "edit-notebook",
    );
    if (writeCapabilities.length > 0) {
      diags.error({
        code: "role/contradictory-write-declaration", file, key: "writes_files",
        message:
          `Role declares writes_files: false but lists the file-writing capability ` +
          `${writeCapabilities.join(", ")}.`,
        hint:
          "Pick one: set writes_files: true if the role genuinely edits files (it then also " +
          "gets an isolated workspace), or drop the capability. A read-only declaration that " +
          "carries write tools is the one combination that grants write access without isolation.",
      });
    }
  }

  // Hardcoded per role, overridable by the project layer. A role that has to
  // infer its own verification command gets it wrong on any non-standard
  // project, and then reports success it never checked.
  const verify_commands = strArray(ctx, "verify_commands", fm["verify_commands"]);
  if (fm["requires_evidence"] !== false && verify_commands.length === 0 && fm["writes_files"] === true) {
    diags.error({
      code: "role/no-verify-commands", file, key: "verify_commands",
      message: "A role that writes files and requires evidence must declare at least one verification command.",
      hint: "Evidence means a recorded command and exit code. Without a declared command the role has no way to produce one.",
    });
  }

  // A verification command naming an se subcommand that does not exist would
  // fail with a usage error, and the role would read that exit code as a
  // failure of the code under test. Either the command exists, or the role
  // declares the gap in blocked_on and nobody mistakes it for working.
  const blocked_on = strArray(ctx, "blocked_on", fm["blocked_on"]);
  for (const cmd of verify_commands) {
    const m = /^"?se\s+([a-z][a-z-]*)/.exec(cmd.trim());
    if (!m) continue;
    const sub = m[1]!;
    if (CLI_COMMANDS.has(sub)) continue;
    if (blocked_on.some((b) => b === `se ${sub}` || b.startsWith(`se ${sub} `))) continue;
    diags.error({
      code: "role/unimplemented-verify-command", file, key: "verify_commands",
      message: `"se ${sub}" is not an implemented command.${suggest(sub, CLI_COMMANDS)}`,
      hint: `Point at a command that exists, or declare the gap: blocked_on: ["se ${sub}"]. A role that runs a nonexistent command reads the usage error as a test failure.`,
    });
  }

  // Where to go when stuck, which is a different question from where to go
  // for a decision. Conflating them sends a technical dead end to the
  // operator as if it were a product question.
  const onFailure = fm["escalates_on_failure_to"];
  if (onFailure !== undefined) {
    if (typeof onFailure !== "string" || (onFailure !== "operator" && !ID_RE.test(onFailure))) {
      diags.error({
        code: "role/invalid-id", file, key: "escalates_on_failure_to",
        message: `escalates_on_failure_to must be a role id or "operator", received ${JSON.stringify(onFailure)}.`,
      });
    } else if (onFailure === id) {
      diags.error({
        code: "role/self-escalation", file, key: "escalates_on_failure_to",
        message: "A role cannot hand its own stuck work back to itself.",
        hint: "That is the retry loop the three-strike rule exists to break.",
      });
    }
  }

  const budget = fm["context_budget_tokens"];
  if (
    budget !== undefined &&
    (typeof budget !== "number" || !Number.isInteger(budget) || budget < 2000 || budget > 400000)
  ) {
    diags.error({
      code: "role/invalid-budget", file, key: "context_budget_tokens",
      message: `context_budget_tokens must be an integer between 2000 and 400000, received ${JSON.stringify(budget)}.`,
      hint: "Budgets are enforced before invocation. An absent or absurd budget is an uncapped bill.",
    });
  }

  const maxCalls = fm["max_calls"];
  if (
    maxCalls !== undefined &&
    (typeof maxCalls !== "number" || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
  ) {
    diags.error({
      code: "role/invalid-max-calls", file, key: "max_calls",
      message: `max_calls must be an integer between 1 and 100, received ${JSON.stringify(maxCalls)}.`,
    });
  }

  for (const key of ["enabled", "requires_evidence", "writes_files"] as const) {
    const v = fm[key];
    if (v !== undefined && typeof v !== "boolean") {
      diags.error({
        code: "role/type", file, key,
        message: `${key} must be a boolean, received ${typeof v}.`,
      });
    }
  }

  const status = fm["status"] ?? "active";
  if (status !== "active" && status !== "deprecated") {
    diags.error({
      code: "role/invalid-status", file, key: "status",
      message: `status must be "active" or "deprecated", received ${JSON.stringify(status)}.`,
    });
  }
  const superseded_by = fm["superseded_by"];
  if (status === "deprecated" && typeof superseded_by !== "string") {
    diags.error({
      code: "role/deprecated-without-successor", file, key: "superseded_by",
      message: "A deprecated role must name its replacement in superseded_by.",
      hint: "Use the value \"none\" only when the responsibility genuinely no longer exists.",
    });
  }

  if (body.trim().length === 0) {
    diags.error({
      code: "role/empty-body", file,
      message: "Role file has no body. Frontmatter with no definition is a placeholder.",
    });
  }
  const todo = /\b(TODO|TBD|FIXME|XXX)\b/.exec(body);
  if (todo) {
    diags.error({
      code: "role/placeholder-text", file,
      message: `Body contains placeholder marker "${todo[0]}".`,
      hint: "Placeholders are rejected by design. A role too vague to define is evidence the role does not belong in the inventory.",
    });
  }

  if (diags.errorCount > before) return null;

  return {
    schema_version: 1,
    id: id as string,
    name: fm["name"] as string,
    department: department as string,
    tier: tier as Tier,
    mission: (mission as string).trim(),
    activation,
    tools: strArray(ctx, "tools", fm["tools"]),
    memory_scopes: { read, write },
    owns_artifacts,
    contributes_artifacts,
    owns_interfaces,
    participates_interfaces,
    shared_with,
    collaborators,
    escalates_to: escalates_to as string,
    context_budget_tokens: budget as number,
    max_calls: maxCalls as number,
    enabled: fm["enabled"] as boolean,
    status: status as "active" | "deprecated",
    supersedes: strArray(ctx, "supersedes", fm["supersedes"]),
    superseded_by: typeof superseded_by === "string" ? superseded_by : null,
    boundary: typeof fm["boundary"] === "string" ? fm["boundary"] : null,
    requires_evidence: (fm["requires_evidence"] as boolean | undefined) ?? true,
    writes_files: (fm["writes_files"] as boolean | undefined) ?? false,
    owns_spec_sections: strArray(ctx, "owns_spec_sections", fm["owns_spec_sections"]),
    verify_commands,
    escalates_on_failure_to: typeof onFailure === "string" ? onFailure : null,
    blocked_on,
    stack_aware: (fm["stack_aware"] as boolean | undefined) ?? false,
    body,
    file,
  };
}

export { KNOWN_KEYS, REQUIRED_KEYS };
