#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./util/paths.ts";
import { resolveRoles } from "./roles/resolve.ts";
import { checkIntegrity } from "./roles/integrity.ts";
import type { OwnershipRow } from "./roles/integrity.ts";
import type { Registry } from "./roles/resolve.ts";
import { Diagnostics } from "./util/diagnostics.ts";
import { DEPARTMENTS, DEPARTMENT_EXPECTED_COUNTS, EXPECTED_ROLE_TOTAL } from "./roles/vocabulary.ts";
import type { Role } from "./roles/types.ts";
import { ADAPTERS, findAdapter } from "./render/claude-code.ts";

const USAGE = `se --- AI engineering organization and project-memory layer

usage: se <command> [options]

commands:
  validate                  Validate the catalogue. Exit 1 on any error.
  roles [--dept <name>]     List roles. --json, --markdown, --all
  role <id>                 Show one role, with per-key layer provenance.
  ownership [--artifact <k>] Show the artifact ownership matrix.
  departments               Show department counts against the specification.
  doctor                    Report environment and catalogue health.
  render --host <id>        Render a roster for a coding agent.
                            --dept <name>   whole department
                            --roster a,b,c  explicit roles
                            --out <dir>  --dry-run  --all  --force

options:
  --json                    Machine-readable output.
  --no-color                Disable colour (also honours NO_COLOR).
`;

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(a.slice(2), next);
          i++;
        } else flags.set(a.slice(2), true);
      }
    } else positional.push(a);
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function useColor(flags: Args["flags"]): boolean {
  if (flags.has("no-color") || process.env["NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

function requireRoot(): string {
  const root = findRepoRoot();
  if (!root) {
    console.error("error: not inside an se repository (looked for package.json beside an se/ directory).");
    process.exit(2);
  }
  return root;
}

/** Load the catalogue and run every integrity check. Shared by most commands. */
function loadCatalogue(root: string) {
  const registry = resolveRoles(root);
  const integrity = checkIntegrity(registry);
  registry.diagnostics.absorb(integrity.diagnostics);
  return { registry, ownership: integrity.ownership, diags: registry.diagnostics };
}

/**
 * Generated artifacts must match the roles they are derived from.
 *
 * Previously only CI caught this, so `se validate` would pass locally with a
 * stale inventory and the ownership matrix could silently misstate who owns
 * what -- which is exactly the document a reviewer consults to find out.
 */
function checkGeneratedCurrent(root: string, registry: Registry, ownership: readonly OwnershipRow[], diags: Diagnostics): void {
  const expected: Array<[string, string]> = [
    ["se/agents/role-inventory.md", renderInventory(registry)],
    ["se/agents/ownership-matrix.md", renderOwnership(ownership)],
  ];
  for (const [rel, want] of expected) {
    const abs = join(root, rel);
    const have = existsSync(abs)
      ? readFileSync(abs, "utf8").split("\r\n").join("\n").trimEnd()
      : null;
    if (have === null) {
      diags.error({
        code: "generated/missing", file: rel,
        message: "Generated file is missing.",
        hint: "Run: bun run gen",
      });
    } else if (have !== want.trimEnd()) {
      diags.error({
        code: "generated/stale", file: rel,
        message: "Generated file does not match the role files it is derived from.",
        hint: "Run: bun run gen. Never edit it by hand; a stale ownership matrix misstates who owns what to the next reviewer who reads it.",
      });
    }
  }
}

function cmdValidate(root: string, flags: Args["flags"]): number {
  const { registry, ownership, diags } = loadCatalogue(root);
  checkGeneratedCurrent(root, registry, ownership, diags);

  if (flags.has("json")) {
    console.log(JSON.stringify({
      ok: diags.ok,
      roles: registry.all.length,
      expected: EXPECTED_ROLE_TOTAL,
      errors: diags.errorCount,
      warnings: diags.warningCount,
      diagnostics: diags.sorted(),
    }, null, 2));
    return diags.ok ? 0 : 1;
  }

  if (diags.items.length > 0) console.log(diags.format({ color: useColor(flags) }));

  const enabled = registry.all.filter((r) => r.enabled && r.status === "active").length;
  console.log(
    `\n${diags.ok ? "PASS" : "FAIL"}  ${registry.all.length}/${EXPECTED_ROLE_TOTAL} roles ` +
    `(${enabled} routable) · ${diags.errorCount} error${diags.errorCount === 1 ? "" : "s"} · ` +
    `${diags.warningCount} warning${diags.warningCount === 1 ? "" : "s"}`,
  );
  return diags.ok ? 0 : 1;
}

function cmdRoles(root: string, flags: Args["flags"]): number {
  const { registry, diags } = loadCatalogue(root);
  const dept = flags.get("dept");
  const showAll = flags.has("all");

  let roles: readonly Role[] = registry.all;
  if (!showAll) roles = roles.filter((r) => r.status === "active");
  if (typeof dept === "string") {
    if (!DEPARTMENTS.includes(dept)) {
      console.error(`error: unknown department "${dept}".\nknown: ${DEPARTMENTS.join(", ")}`);
      return 2;
    }
    roles = roles.filter((r) => r.department === dept);
  }

  if (flags.has("json")) {
    console.log(JSON.stringify(roles, null, 2));
    return 0;
  }

  if (flags.has("markdown")) {
    console.log(renderInventory(registry, roles));
    return 0;
  }

  for (const r of roles) {
    const marks = [
      r.tier === "starter" ? "*" : " ",
      r.enabled ? " " : "x",
      r.status === "deprecated" ? "D" : " ",
    ].join("");
    console.log(`${marks} ${r.id.padEnd(44)} ${r.department}`);
  }
  if (!flags.has("quiet")) {
    console.error(`
${roles.length} role${roles.length === 1 ? "" : "s"} (* starter, x disabled, D deprecated)`);
    if (!diags.ok) console.error(`warning: catalogue has ${diags.errorCount} error(s); run \`se validate\`.`);
  }
  return 0;
}

function renderInventory(registry: Registry, only?: readonly Role[]): string {
  const roles = only ?? registry.all.filter((r) => r.status === "active");
  {
    const lines = [
      "<!-- GENERATED by `se roles --markdown`. Do not edit by hand; edits are overwritten. -->",
      "",
      "# Role inventory",
      "",
      `${roles.length} roles across ${DEPARTMENTS.length} departments.`,
      "",
    ];
    for (const d of DEPARTMENTS) {
      const inDept = roles.filter((r) => r.department === d);
      if (inDept.length === 0) continue;
      lines.push(`## ${d} (${inDept.length})`, "", "| id | name | tier | mission |", "|---|---|---|---|");
      for (const r of inDept) {
        lines.push(`| \`${r.id}\` | ${r.name} | ${r.tier} | ${r.mission.replace(/\|/g, "\\|")} |`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}

function cmdRole(root: string, args: Args): number {
  const id = args.positional[0];
  if (!id) {
    console.error("error: se role <id>");
    return 2;
  }
  const { registry } = loadCatalogue(root);
  const role = registry.byId.get(id);
  if (!role) {
    console.error(`error: no role with id "${id}". Try \`se roles\`.`);
    return 1;
  }
  if (args.flags.has("json")) {
    console.log(JSON.stringify(role, null, 2));
    return 0;
  }

  const { body, provenance, ...meta } = role;
  console.log(`# ${role.name}  (${role.id})\n`);
  for (const [k, v] of Object.entries(meta)) {
    const layer = provenance[k];
    const from = layer && layer !== "builtin" ? `   [overridden by ${layer} layer]` : "";
    console.log(`${k.padEnd(24)} ${JSON.stringify(v)}${from}`);
  }
  console.log(`\n---\n${body}`);
  return 0;
}

function cmdOwnership(root: string, flags: Args["flags"]): number {
  const { ownership, diags } = loadCatalogue(root);
  const filter = flags.get("artifact");
  const rows = typeof filter === "string" ? ownership.filter((r) => r.artifact === filter) : ownership;

  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return diags.ok ? 0 : 1;
  }
  if (flags.has("markdown")) {
    console.log(renderOwnership(rows));
    return 0;
  }
  for (const r of rows) {
    console.log(`${r.artifact.padEnd(34)} ${r.owner ?? `(unowned: ${r.coOwners.join(", ")})`}`);
  }
  console.error(`
${rows.length} artifact kind(s) claimed`);
  return 0;
}

function renderOwnership(rows: readonly OwnershipRow[]): string {
  {
    const lines = [
      "<!-- GENERATED by `se ownership --markdown`. Do not edit by hand. -->",
      "",
      "# Ownership matrix",
      "",
      "Exactly one role is accountable per artifact kind. Others contribute.",
      "",
      "| artifact | accountable owner | co-owners | contributors |",
      "|---|---|---|---|",
    ];
    for (const r of rows) {
      lines.push(
        `| \`${r.artifact}\` | ${r.owner ? `\`${r.owner}\`` : "**none**"} | ` +
        `${r.coOwners.map((c) => `\`${c}\``).join(", ") || "—"} | ` +
        `${r.contributors.map((c) => `\`${c}\``).join(", ") || "—"} |`,
      );
    }
    return lines.join("\n");
  }
}

function cmdDepartments(root: string, flags: Args["flags"]): number {
  const { registry } = loadCatalogue(root);
  const counts = new Map<string, number>();
  for (const r of registry.all) counts.set(r.department, (counts.get(r.department) ?? 0) + 1);

  const rows = DEPARTMENTS.map((d) => ({
    department: d,
    actual: counts.get(d) ?? 0,
    expected: DEPARTMENT_EXPECTED_COUNTS[d] ?? 0,
  }));
  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  let ok = true;
  for (const r of rows) {
    const delta = r.actual - r.expected;
    if (delta !== 0) ok = false;
    const mark = delta === 0 ? "ok  " : delta < 0 ? "MISS" : "OVER";
    console.log(`${mark} ${r.department.padEnd(34)} ${String(r.actual).padStart(3)} / ${r.expected}`);
  }
  const total = rows.reduce((a, r) => a + r.actual, 0);
  console.log(`${ok ? "ok  " : "FAIL"} ${"TOTAL".padEnd(34)} ${String(total).padStart(3)} / ${EXPECTED_ROLE_TOTAL}`);
  return ok ? 0 : 1;
}

function cmdDoctor(root: string, flags: Args["flags"]): number {
  const { registry, diags } = loadCatalogue(root);
  const starter = registry.all.filter((r) => r.tier === "starter");
  const writers = registry.all.filter((r) => r.writes_files && r.enabled);

  const report = {
    root,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    roles: registry.all.length,
    expected: EXPECTED_ROLE_TOTAL,
    starter_roster: starter.length,
    parallel_writers: writers.length,
    errors: diags.errorCount,
    warnings: diags.warningCount,
  };
  if (flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(18)} ${v}`);
    if (writers.length > 1) {
      console.log(
        `\nnote: ${writers.length} enabled roles write files. Running them in parallel ` +
        "requires isolated workspaces, or they must be serialized (Part XV 53).",
      );
    }
  }
  return diags.ok ? 0 : 1;
}


function cmdRender(root: string, flags: Args["flags"]): number {
  const hostId = typeof flags.get("host") === "string" ? (flags.get("host") as string) : "claude-code";
  const adapter = findAdapter(hostId);
  if (!adapter) {
    console.error(`error: unknown host "${hostId}".
known: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    return 2;
  }

  const { registry, diags } = loadCatalogue(root);

  // Rendering a catalogue with per-file errors would emit broken agent
  // definitions that Claude Code silently skips. Refuse instead.
  const perFile = diags.sorted().filter((d) => d.code.startsWith("role/"));
  if (perFile.length > 0) {
    console.error(diags.format({ color: useColor(flags) }));
    console.error("\nerror: refusing to render while role files have errors.");
    return 1;
  }

  // The default is the starter roster, not the catalogue. A full-catalogue
  // render exceeds the host's always-loaded metadata budget, which is the
  // whole reason roster selection exists.
  const routable = registry.all.filter((r) => r.enabled && r.status === "active");
  const dept = flags.get("dept");
  const rosterFlag = flags.get("roster");

  let selected: readonly Role[];
  let selectionLabel: string;

  if (typeof rosterFlag === "string") {
    const wanted = rosterFlag.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = wanted.filter((id) => !registry.byId.has(id));
    if (missing.length > 0) {
      console.error(`error: unknown role id(s): ${missing.join(", ")}`);
      return 2;
    }
    selected = wanted.map((id) => registry.byId.get(id)!);
    selectionLabel = `explicit roster (${wanted.length})`;
  } else if (typeof dept === "string") {
    if (!DEPARTMENTS.includes(dept)) {
      console.error(`error: unknown department "${dept}".
known: ${DEPARTMENTS.join(", ")}`);
      return 2;
    }
    // Selecting a department brings the starter roster with it. A department
    // on its own has no orchestrator, no contract owner and no verification,
    // so it would be a set of specialists with nobody sequencing them.
    const inDept = routable.filter((r) => r.department === dept);
    const starters = routable.filter((r) => r.tier === "starter" && r.department !== dept);
    selected = [...inDept, ...starters];
    selectionLabel = `department ${dept} (${inDept.length}) + starter roster (${starters.length})`;
  } else if (flags.has("all")) {
    selected = routable;
    selectionLabel = `entire catalogue (${routable.length})`;
  } else {
    selected = routable.filter((r) => r.tier === "starter");
    selectionLabel = `starter roster (${selected.length})`;
  }

  if (selected.length === 0) {
    console.error("error: no roles selected. Nothing to render.");
    return 1;
  }

  const result = adapter.render(selected, root);
  const budget = adapter.metadataTokenBudget;
  const overBudget = budget !== null && result.metadataTokens > budget;

  if (overBudget && !flags.has("force")) {
    console.error(
      `error: ${selected.length} roles would add about ${result.metadataTokens} tokens of\n` +
      `always-loaded metadata to every ${adapter.displayName} session, over the\n` +
      `${budget} token budget.\n\n` +
      "Every rendered role costs context in every session, whether it is used\n" +
      "or not. Render the roster you actually need, not the catalogue.\n\n" +
      `  se render --host ${adapter.id}            # starter roster only\n` +
      `  se render --host ${adapter.id} --force    # proceed anyway\n`,
    );
    return 1;
  }

  const outDir = typeof flags.get("out") === "string" ? (flags.get("out") as string) : adapter.defaultOut;
  const absOut = join(root, outDir);

  if (flags.has("dry-run")) {
    for (const f of result.files) console.log(`${outDir}/${f.path}`);
  } else {
    mkdirSync(absOut, { recursive: true });

    // Remove previously generated files that no longer correspond to a
    // selected role. Without this, disabling a role in a local override
    // layer leaves its agent definition behind and the host keeps offering a
    // role the project has deliberately switched off.
    let removed = 0;
    for (const existing of readdirSync(absOut).filter((n) => n.endsWith(".md"))) {
      const abs = join(absOut, existing);
      if (result.files.some((f) => f.path === existing)) continue;
      if (!readFileSync(abs, "utf8").includes("GENERATED from se/agents/")) continue; // never touch hand-written files
      rmSync(abs);
      removed++;
    }

    for (const f of result.files) writeFileSync(join(absOut, f.path), f.contents, "utf8");
    console.log(`rendered ${result.files.length} role(s) to ${outDir}/${removed > 0 ? `  (removed ${removed} stale)` : ""}`);
  }

  console.log(
    `selection ${selectionLabel}`,
  );
  console.log(
    `host ${adapter.displayName} · ~${result.metadataTokens} metadata tokens` +
    (budget !== null ? ` / ${budget} budget${overBudget ? " (FORCED OVER)" : ""}` : ""),
  );

  const writers = selected.filter((r) => r.writes_files);
  if (writers.length > 0) {
    console.log(`${writers.length} role(s) render with isolation: worktree (Part XV 53).`);
  }

  if (result.unmapped.size > 0) {
    console.log("\ncapabilities this host cannot provide:");
    for (const [id, caps] of result.unmapped) console.log(`  ${id}: ${caps.join(", ")}`);
  }
  return 0;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case "validate":    return cmdValidate(requireRoot(), args.flags);
    case "roles":       return cmdRoles(requireRoot(), args.flags);
    case "role":        return cmdRole(requireRoot(), args);
    case "ownership":   return cmdOwnership(requireRoot(), args.flags);
    case "departments": return cmdDepartments(requireRoot(), args.flags);
    case "doctor":      return cmdDoctor(requireRoot(), args.flags);
    case "render":      return cmdRender(requireRoot(), args.flags);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`error: unknown command "${args.command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
