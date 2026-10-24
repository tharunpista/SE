#!/usr/bin/env bun
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  findCatalogueRoot,
  findProjectRoot,
  isCatalogueRoot,
  readGlobalConfig,
  seHome,
  writeGlobalConfig,
} from "./util/paths.ts";
import { resolveRoles } from "./roles/resolve.ts";
import { checkIntegrity } from "./roles/integrity.ts";
import type { OwnershipRow } from "./roles/integrity.ts";
import type { Registry } from "./roles/resolve.ts";
import { Diagnostics } from "./util/diagnostics.ts";
import { DEPARTMENTS, DEPARTMENT_EXPECTED_COUNTS, EXPECTED_ROLE_TOTAL, departmentLabel } from "./roles/vocabulary.ts";
import type { Role } from "./roles/types.ts";
import { ADAPTERS, findAdapter } from "./render/claude-code.ts";
import { renderRoleInstructions } from "./render/host.ts";
import { effectiveRoster, hostSites } from "./render/sites.ts";
import { cmdMemory } from "./memory/cli.ts";
import { closeRoster, isClosureMode } from "./roles/roster.ts";
import { checkTopics, findTopic, resolveTopic, suggestTopic, TOPICS, uncoveredRoles } from "./roles/topics.ts";
import {
  chooseBinDir,
  isOnPath,
  pathInstructions,
  shims,
  writeShims,
} from "./install.ts";

const USAGE = `se --- AI engineering organization and project-memory layer

usage: se <command> [options]

commands:
  validate                  Validate the catalogue. Exit 1 on any error.
  roles [--dept <name>]     List roles. --json, --markdown, --all
  role <id>                 Show one role, with per-key layer provenance.
  ownership [--artifact <k>] Show the artifact ownership matrix.
  departments               Show department counts against the specification.
  topics                    Show topics: role groups reachable by keyword.
  doctor                    Report environment and catalogue health.
  memory <subcommand>       Project memory: init, status, doctor, context,
                            sources, recall, remember. Run "se memory help".
  install                   Put "se" on PATH for every shell and register this
                            catalogue. Run this once after cloning.
                            --bin-dir <dir>  --add-path  --dry-run
  setup                     Register the catalogue, install the CLI, and enable
                            the starter roster in supported global client folders.
                            --add-path  --host <id>  --roster a,b,c  --all --force
  link [--path <dir>]       Register this catalogue so se works from anywhere.
                            --show   report what is registered
  where [--host <id>]       Report every directory the host reads for a session
                            rooted here, and which roles it will actually load.
  render --host <id>        Render a roster for a coding agent.
                            --dept <name>   whole department
                            --topic <name>  roles that own one job, across
                                            departments (se topics to list)
                            --roster a,b,c  explicit roles
                            --global        install for every project
                            --project <dir> the directory the host has open
                            --out <dir>  --dry-run  --all  --force  --merge
                            --merge updates selected files without removing other generated roles.
  agents enable             Install the starter roster globally in supported clients.
                            --host <id>  --roster a,b,c  --all  --force
  agents disable            Remove generated global agents; --host <id> for one.
  agents status             Show generated global agents in each client folder.

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
      /*
       * A repeated flag accumulates rather than overwriting, so `--source a
       * --source b` keeps both. Values are joined with a newline because no
       * flag value this CLI accepts contains one, which keeps the map's value
       * type a plain string and every existing consumer working unchanged.
       * Readers take the last line for a scalar flag, or every line for a
       * repeatable one.
       */
      const accumulate = (key: string, value: string): void => {
        const existing = flags.get(key);
        flags.set(key, typeof existing === "string" ? `${existing}\n${value}` : value);
      };

      const eq = a.indexOf("=");
      if (eq !== -1) accumulate(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          accumulate(a.slice(2), next);
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

/**
 * The catalogue root. Resolved from SE_CATALOGUE, then by walking up from the
 * cwd, then from the globally registered path -- so the command works from
 * inside the catalogue repository and from any other project alike.
 */
function requireRoot(): string {
  const root = findCatalogueRoot();
  if (!root) {
    console.error(
      "error: cannot find the role catalogue.\n\n" +
      "It is not above the current directory, and no catalogue is registered.\n" +
      "Register one once, from inside the catalogue repository:\n\n" +
      "  se link\n\n" +
      "Or point at it for this command: SE_CATALOGUE=/path/to/se-org",
    );
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

  /*
   * Topic integrity is checked here rather than in `checkIntegrity`, which is
   * shared by every command and by the test harness. Topics reference the
   * shipped catalogue by id, so running them against a partial catalogue -- a
   * fixture holding two invented roles, say -- reports all 136 memberships as
   * unknown and buries the finding the caller was actually looking for. That
   * failure mode has happened before with the catalogue-count checks, which is
   * why the harness carries an ignore list for them; this check is placed so it
   * never needs one.
   */
  checkTopics(registry.byId, diags);
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

  for (const department of DEPARTMENTS) {
    const section = roles
      .filter((role) => role.department === department)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    if (section.length === 0) continue;
    console.log(`\n${departmentLabel(department)} (${section.length})`);
    for (const r of section) {
      const marks = [
        r.tier === "starter" ? "*" : " ",
        r.enabled ? " " : "x",
        r.status === "deprecated" ? "D" : " ",
      ].join("");
      console.log(`${marks} ${r.id.padEnd(44)} ${r.name}`);
    }
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
      lines.push(`## ${departmentLabel(d)} (${inDept.length})`, "", "| id | name | tier | mission |", "|---|---|---|---|");
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
  console.log(`\n---\n${renderRoleInstructions(body)}`);
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


/**
 * Register a catalogue root so every other command can find it from any
 * directory. This registers the source path; rendered client definitions are
 * separate copies and must be regenerated after catalogue updates.
 */
function cmdLink(flags: Args["flags"]): number {
  if (flags.has("show")) {
    const config = readGlobalConfig();
    if (!config) {
      console.log(`no catalogue registered (looked in ${join(seHome(), "config.json")})`);
      return 0;
    }
    const valid = isCatalogueRoot(config.catalogue_root);
    console.log(`catalogue:  ${config.catalogue_root}`);
    console.log(`config:     ${join(seHome(), "config.json")}`);
    console.log(`state:      ${valid ? "ok" : "MISSING -- the path no longer holds a catalogue"}`);
    return valid ? 0 : 1;
  }

  const target = typeof flags.get("path") === "string" ? (flags.get("path") as string) : process.cwd();
  const resolved = findCatalogueRoot(target);

  if (!resolved || !isCatalogueRoot(resolved)) {
    console.error(
      `error: ${target} is not a role catalogue.\n\n` +
      "Expected a directory containing se/agents/ beside a package.json.\n" +
      "Run this from inside the catalogue repository, or pass --path <dir>.",
    );
    return 2;
  }

  const path = writeGlobalConfig(resolved);
  console.log(`registered catalogue: ${resolved}`);
  console.log(`wrote ${path}`);
  console.log("");
  console.log("`se` now finds the role catalogue from any directory.");
  console.log("Rendered client agent files are copies; rerun `se agents enable` after updates.");
  return 0;
}

/**
 * The one command a fresh clone runs.
 *
 * It replaces a paragraph of per-machine PATH surgery that previously lived in
 * the documentation. That paragraph was the bug: the shims it described were
 * written by hand on one machine, so the command worked in the shell that
 * installed it and reported "command not found" everywhere else -- which looks,
 * from outside, exactly like the catalogue being broken.
 */
function cmdInstall(flags: Args["flags"]): number {
  const catalogue = findCatalogueRoot();
  if (!catalogue || !isCatalogueRoot(catalogue)) {
    console.error(
      "error: run this from inside the catalogue repository.\n\n" +
      "`se install` records where the catalogue lives, so it has to be run from\n" +
      "within it at least once:\n\n" +
      "  git clone <repo> se-org\n" +
      "  cd se-org\n" +
      "  bun install\n" +
      "  bun run src/cli.ts install",
    );
    return 2;
  }

  // The running interpreter, not the string "bun". A winget or scoop install of
  // bun sits in a directory that is not itself reliably on PATH, so a shim that
  // only says `bun` works in the shell that ran the install and fails in the
  // next one.
  const bunPath = process.execPath;
  const explicit = typeof flags.get("bin-dir") === "string" ? (flags.get("bin-dir") as string) : undefined;
  const { dir, reason } = chooseBinDir(explicit);

  console.log(`catalogue:  ${catalogue}`);
  console.log(`bun:        ${bunPath}`);
  console.log(`bin dir:    ${dir}   (${reason})`);
  console.log("");

  if (flags.has("dry-run")) {
    for (const shim of shims(catalogue, bunPath)) console.log(`would write ${join(dir, shim.name)}`);
    console.log(`would write ${join(seHome(), "config.json")}`);
    return 0;
  }

  const written = writeShims(dir, catalogue, bunPath);
  for (const w of written) {
    const note = w.state === "refused-foreign"
      ? "REFUSED -- not generated by se; left untouched"
      : w.state;
    console.log(`${note.padEnd(12)} ${w.path}   (${w.shells})`);
  }

  const foreign = written.filter((w) => w.state === "refused-foreign");
  if (foreign.length === written.length) {
    console.error(
      `\nerror: every shim name in ${dir} is already taken by a file se did not\n` +
      "write, and overwriting another program's launcher is not something this\n" +
      "command will do silently. Choose another directory:\n\n" +
      "  se install --bin-dir <dir>",
    );
    return 1;
  }

  const configPath = writeGlobalConfig(catalogue);
  console.log(`written      ${configPath}   (catalogue registration)`);

  const onPath = isOnPath(dir);
  if (!onPath && flags.has("add-path")) {
    const added = addToUserPath(dir);
    console.log("");
    if (added.ok) {
      console.log(`added ${dir} to your user PATH (${added.detail}).`);
      console.log("Open a new terminal for it to take effect; this one keeps the old PATH.");
    } else {
      console.error(`warning: could not add it automatically: ${added.detail}`);
      console.error("");
      for (const line of pathInstructions(dir)) console.error(line);
    }
  } else if (!onPath) {
    console.log("");
    console.log(`${dir} is NOT on your PATH, so \`se\` will not be found yet.`);
    console.log("");
    for (const line of pathInstructions(dir)) console.log(line);
  } else {
    console.log("");
    console.log("`se` is now on PATH in every shell. Verify from another directory:");
    console.log("");
    console.log("  se where");
  }

  console.log("");
  console.log("Then enable the global starter roster for supported coding clients:");
  console.log("");
  console.log("  se agents enable                        # install in all supported clients");
  console.log("  se agents status                        # verify global installation");
  return 0;
}

/**
 * Persist a directory onto the user's PATH. Opt-in via `--add-path`, because it
 * edits the environment outside this process and outlives it.
 */
function addToUserPath(dir: string): { ok: boolean; detail: string } {
  try {
    if (process.platform === "win32") {
      // The user-scoped registry value, not the machine one: no elevation, and
      // no chance of corrupting a system PATH.
      const script =
        "$d = $env:SE_ADD_DIR; " +
        "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
        "if ($p -split ';' -notcontains $d) { " +
        "[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User'); " +
        "'added' } else { 'already present' }";
      const proc = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, SE_ADD_DIR: dir },
      });
      const out = new TextDecoder().decode(proc.stdout).trim();
      if (proc.exitCode !== 0) {
        return { ok: false, detail: new TextDecoder().decode(proc.stderr).trim() || `exit ${proc.exitCode}` };
      }
      return { ok: true, detail: `user environment: ${out}` };
    }

    const profile = join(homedir(), ".profile");
    const line = `export PATH="${dir}:$PATH"`;
    const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
    if (existing.includes(line)) return { ok: true, detail: "~/.profile already had it" };
    writeFileSync(profile, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`, "utf8");
    return { ok: true, detail: "appended to ~/.profile" };
  } catch (cause) {
    return { ok: false, detail: (cause as Error).message };
  }
}

/**
 * Answer "why can't the session I am sitting in see my roles?" in one command.
 *
 * `se render` can only report where it wrote. That is a different question from
 * which directory the host will read, and when the two differ a successful
 * render is invisible -- the failure this command exists to make legible.
 */
function cmdWhere(root: string, flags: Args["flags"]): number {
  const hostId = typeof flags.get("host") === "string" ? (flags.get("host") as string) : "claude-code";
  const adapter = findAdapter(hostId);
  if (!adapter) {
    console.error(`error: unknown host "${hostId}".\nknown: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    return 2;
  }

  const { registry } = loadCatalogue(root);
  const projectRoot = resolveProjectTarget(flags);
  const sites = hostSites(adapter, projectRoot, registry.all);
  const roster = effectiveRoster(sites);
  const known = new Set(registry.all.map((r) => r.id));

  if (flags.has("json")) {
    console.log(JSON.stringify({
      host: adapter.id,
      cwd: process.cwd(),
      project_root: projectRoot,
      catalogue_root: root,
      sites,
      loaded: [...roster.keys()].sort(),
    }, null, 2));
    return 0;
  }

  console.log(`host             ${adapter.displayName}`);
  console.log(`cwd              ${process.cwd()}`);
  console.log(`project root     ${projectRoot}`);
  console.log(`catalogue root   ${root}`);
  console.log("");

  for (const site of sites) {
    const label = site.kind === "project"
      ? "project-level (this project only)"
      : "user-level (every project)";
    console.log(`${site.dir}`);
    console.log(`  ${label}`);
    if (!site.exists) {
      console.log("  absent -- nothing installed here");
    } else {
      const stale = site.generated.filter((d) => d.stale);
      const orphan = site.generated.filter((d) => !known.has(d.roleId));
      console.log(`  ${site.generated.length} rendered role(s)` +
        (stale.length > 0 ? `, ${stale.length} STALE` : "") +
        (orphan.length > 0 ? `, ${orphan.length} no longer in the catalogue` : "") +
        (site.foreign.length > 0 ? `, ${site.foreign.length} hand-written (never touched)` : ""));
      for (const d of stale) console.log(`    stale   ${d.roleId} -- the role has changed since it was rendered`);
      for (const d of orphan) console.log(`    orphan  ${d.roleId} -- no such role in the catalogue now`);
    }
    console.log("");
  }

  if (roster.size === 0) {
    console.log("No roles are installed for this host, so a session rooted here loads none.");
    console.log("");
    console.log(`  se render --host ${adapter.id}            # into ${projectRoot}`);
    if (adapter.userOut) console.log(`  se render --host ${adapter.id} --global   # for every project`);
    return 1;
  }

  console.log(`A session rooted at ${projectRoot} loads ${roster.size} role(s):`);
  for (const [id, site] of [...roster].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${id.padEnd(30)} from ${site.kind}-level`);
  }

  if (adapter.id === "claude-code") {
    console.log("");
    console.log("In Claude Code, `/agents` lists these definitions. `/list-agents` is a");
    console.log("different command: it lists other running sessions you can message, and");
    console.log("says nothing about whether a roster is installed.");
    console.log("A running session does not pick up new files -- restart it, or run `/agents`.");
  }
  return 0;
}

/**
 * The directory the host has open, which is the only directory whose
 * project-level definitions it will read.
 *
 * `--project` exists because the inferred answer -- nearest ancestor with
 * `package.json` or `.git` -- is a guess. It is usually right and silently wrong
 * in the cases that matter: a session opened in a subdirectory, or in a
 * directory that is not a project at all.
 */
function resolveProjectTarget(flags: Args["flags"]): string {
  const explicit = flags.get("project");
  if (typeof explicit === "string") return isAbsolute(explicit) ? explicit : join(process.cwd(), explicit);
  return findProjectRoot();
}

/**
 * `se topics` --- the keyword routing axis, listed.
 *
 * Departments answer "where does this role report". Topics answer "I have an
 * auth problem, who owns it", which is the question an operator actually has
 * and the one a department listing cannot answer.
 */
function cmdTopics(root: string, flags: Args["flags"]): number {
  const { registry } = loadCatalogue(root);
  const uncovered = uncoveredRoles(registry.byId);

  if (flags.has("json")) {
    console.log(JSON.stringify({
      topics: TOPICS.map((t) => ({ ...t, installed_roles: resolveTopic(t, registry.byId).roles.map((r) => r.id) })),
      uncovered_roles: uncovered,
    }, null, 2));
    return 0;
  }

  const wanted = typeof flags.get("topic") === "string" ? (flags.get("topic") as string) : null;
  if (wanted) {
    const topic = findTopic(wanted);
    if (!topic) {
      console.error(`error: unknown topic "${wanted}".${suggestTopic(wanted)}`);
      return 2;
    }
    const { roles } = resolveTopic(topic, registry.byId);
    console.log(`${topic.label}  (se render --topic ${topic.id})`);
    console.log(`  ${topic.purpose}`);
    console.log("");
    console.log(`  keywords: ${topic.keywords.join(", ")}`);
    console.log("");
    for (const role of roles) console.log(`  ${role.id.padEnd(42)} ${role.department}`);
    return 0;
  }

  console.log(`${TOPICS.length} topics. A topic groups the roles that own one job, across departments.`);
  console.log("");
  for (const topic of TOPICS) {
    const { roles } = resolveTopic(topic, registry.byId);
    console.log(`${topic.id.padEnd(14)} ${String(roles.length).padStart(2)} roles  ${topic.label}`);
    console.log(`${" ".repeat(14)}           ${topic.keywords.slice(0, 6).join(", ")}...`);
  }
  console.log("");
  console.log(`Install one:  se render --host claude-code --topic <id>`);
  console.log(`Detail:       se topics --topic <id>`);
  if (uncovered.length > 0) {
    console.log("");
    console.log(`${uncovered.length} active role(s) belong to no topic and are reachable by name only.`);
  }
  return 0;
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
  const topicFlag = flags.get("topic");

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
  } else if (typeof topicFlag === "string") {
    const topic = findTopic(topicFlag);
    if (!topic) {
      console.error(`error: unknown topic "${topicFlag}".${suggestTopic(topicFlag)}`);
      return 2;
    }
    const { roles: members, missing } = resolveTopic(topic, registry.byId);
    if (missing.length > 0) {
      // Validation rejects this, so reaching it means the catalogue was edited
      // past the gate. Report rather than silently installing a partial topic.
      console.error(`error: topic "${topic.id}" names unknown role(s): ${missing.join(", ")}`);
      return 1;
    }
    const enabled = members.filter((r) => r.enabled && r.status === "active");
    // The starter roster comes too: a topic is a set of specialists with no
    // orchestrator, no requirements owner and no verification among them.
    const starters = routable.filter((r) => r.tier === "starter" && !enabled.some((m) => m.id === r.id));
    selected = [...enabled, ...starters];
    selectionLabel = `topic ${topic.id} (${enabled.length}) + starter roster (${starters.length})`;
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

  /*
   * Escalation closure.
   *
   * A roster whose escalation targets are not installed is a roster where stuck
   * work has nowhere to go: the role names a receiver, the host has no such
   * agent, and the handoff block is returned to an operator who did not ask for
   * it. `escalates_to` and `escalates_on_failure_to` are hard dependencies for
   * that reason, and they are pulled in automatically.
   *
   * `collaborators` deliberately is not. It is routing metadata, not
   * delegation -- the generated AGENTS.md says so in as many words -- and
   * closing over it costs 21 extra roles for security-and-privacy and 27 for
   * backend-and-data, roughly doubling the roster and pushing it through the
   * host's always-loaded metadata budget. `--closure collaborators` asks for
   * that set explicitly; nothing imposes it.
   */
  const closureFlag = typeof flags.get("closure") === "string" ? (flags.get("closure") as string) : "escalation";
  if (!isClosureMode(closureFlag)) {
    console.error(`error: unknown --closure "${closureFlag}". One of: escalation, collaborators, none`);
    return 2;
  }

  const added = closeRoster(selected, routable, closureFlag);
  if (added.length > 0) {
    selected = [...selected, ...added];
    selectionLabel += ` + ${added.length} escalation target(s)`;
    console.log(
      `added for closure: ${added.map((r) => r.id).sort().join(", ")}\n` +
        `  selected roles escalate to these; without them stuck work has no receiver.`,
    );
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

  /*
   * Three different roots are in play, and conflating any two of them is a
   * silent bug once the CLI is installed globally:
   *
   *   root          where the roles are read from (the catalogue)
   *   installRoot   the project being worked on, where output belongs
   *   adapter.userOut  the host's user-level location, for --global
   *
   * Anchoring output on `root` would write a project's agents into the
   * catalogue repository. When the cwd is inside the catalogue itself -- the
   * common case while developing it -- the two coincide and nothing changes.
   */
  const installRoot = resolveProjectTarget(flags);
  const outFlag = typeof flags.get("out") === "string" ? (flags.get("out") as string) : null;

  if (flags.has("global") && outFlag) {
    console.error("error: --global and --out are alternatives; pass one.");
    return 2;
  }

  let outDir: string;
  let absOut: string;

  if (flags.has("global")) {
    if (adapter.userOut === null) {
      console.error(
        `error: ${adapter.displayName} has no user-level location, so --global is not\n` +
        "available for it. There is no agreed path for this host, and writing to a\n" +
        "guessed one would either be ignored or apply to every unrelated project.\n\n" +
        `Render it into a project instead: se render --host ${adapter.id}`,
      );
      return 2;
    }
    absOut = adapter.userOut;
    outDir = absOut;
  } else {
    outDir = outFlag ?? adapter.defaultOut;
    absOut = isAbsolute(outDir) ? outDir : join(installRoot, outDir);
  }

  if (flags.has("dry-run")) {
    for (const f of result.files) console.log(`${outDir}/${f.path}`);
  } else {
    try {
      mkdirSync(absOut, { recursive: true });
    } catch (cause) {
      console.error(`error: cannot create output directory ${absOut}: ${(cause as NodeJS.ErrnoException).message}`);
      return 1;
    }

    // Refuse name collisions before cleanup or writes. A generated agent must
    // never silently replace a hand-authored host definition, especially
    // AGENTS.md which may contain the project's primary instructions.
    for (const file of result.files) {
      const target = join(absOut, file.path);
      try {
        if (existsSync(target) && !readFileSync(target, "utf8").includes("GENERATED from se/agents/")) {
          console.error(`error: refusing to overwrite hand-written file ${target}`);
          console.error("Move it, choose another --out directory, or explicitly remove it yourself.");
          return 1;
        }
      } catch (cause) {
        console.error(`error: cannot inspect ${target}: ${(cause as NodeJS.ErrnoException).message}`);
        return 1;
      }
    }

    // Preflight every changed output before replacing files or pruning the old
    // roster. Windows clients often hold generated files open; discover that
    // conflict up front so one locked file cannot cause a half-updated roster.
    const pendingWrites: typeof result.files[number][] = [];
    for (const file of result.files) {
      const target = join(absOut, file.path);
      try {
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target)) {
          if (readFileSync(target, "utf8").replace(/\r\n?/g, "\n") === file.contents.replace(/\r\n?/g, "\n")) continue;
          const fd = openSync(target, "r+");
          closeSync(fd);
        } else {
          accessSync(dirname(target), constants.W_OK);
        }
        pendingWrites.push(file);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        console.error(`error: cannot update generated file ${target}${code ? ` (${code})` : ""}.`);
        console.error("Close the client or editor holding it, check directory permissions, and rerun the render command.");
        return 1;
      }
    }

    let removed = 0;
    let existingFiles: string[] = [];
    if (!flags.has("merge")) {
      // Replacement mode removes generated files no longer in the selected
      // roster. Merge mode refreshes a subset without uninstalling other roles.
      const collectFiles = (dir: string, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) collectFiles(join(dir, entry.name), rel);
          else if (entry.isFile() && /\.(?:md|toml)$/.test(entry.name)) existingFiles.push(rel);
        }
      };
      collectFiles(absOut);
    }

    for (const f of pendingWrites) {
      const target = join(absOut, f.path);
      try {
        writeFileSync(target, f.contents, "utf8");
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        console.error(`error: write failed for ${target}${code ? ` (${code})` : ""}; some earlier files may already be updated.`);
        console.error("Close the client or editor holding the file, then rerun the render command to converge the roster.");
        return 1;
      }
    }

    // Prune stale generated files only after all selected output was written.
    // A cleanup failure leaves stale definitions, but never destroys the old
    // roster before the replacement has been installed.
    for (const existing of existingFiles) {
      const abs = join(absOut, existing);
      if (result.files.some((f) => f.path === existing)) continue;
      try {
        if (!readFileSync(abs, "utf8").includes("GENERATED from se/agents/")) continue;
        rmSync(abs);
        removed++;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        console.error(`error: rendered files updated, but stale file cleanup failed for ${abs}${code ? ` (${code})` : ""}.`);
        return 1;
      }
    }
    const renderNote = flags.has("merge")
      ? "  (merged; other generated roles preserved)"
      : removed > 0
        ? `  (removed ${removed} stale)`
        : "";
    console.log(`rendered ${result.files.length} role(s) to ${outDir}/${renderNote}`);
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
    console.log(
      adapter.providesWorkspaceIsolation
        ? `${writers.length} role(s) render with isolation: worktree (Part XV 53).`
        : `warning: ${writers.length} role(s) write files, and ${adapter.displayName} provides no\n` +
          `  workspace isolation. Part XV 53 wants one workspace per writer; on this host\n` +
          `  that is not enforced, so parallel writers can corrupt each other silently.`,
    );
  }

  if (result.unmapped.size > 0) {
    console.log("\ncapabilities this host cannot provide:");
    for (const [id, caps] of result.unmapped) console.log(`  ${id}: ${caps.join(", ")}`);
  }
  return 0;
}

/** Select a safe roster once for the aggregate global install command. */
function cmdAgents(root: string, args: Args): number {
  const action = args.positional[0] ?? "help";
  const hostFlag = args.flags.get("host");
  const chosen = typeof hostFlag === "string"
    ? [findAdapter(hostFlag)]
    : ADAPTERS.filter((adapter) => adapter.userOut !== null);
  if (chosen.some((adapter) => adapter === undefined)) {
    console.error(`error: unknown host "${hostFlag}".\nknown: ${ADAPTERS.filter((a) => a.userOut).map((a) => a.id).join(", ")}`);
    return 2;
  }
  const adapters = chosen.filter((adapter) => adapter?.userOut !== null) as typeof ADAPTERS[number][];
  if (adapters.length === 0) {
    console.error("error: no selected host has a supported global agent directory.");
    return 2;
  }

  if (action === "status") {
    for (const adapter of adapters) {
      const site = hostSites(adapter, "", [])[1]!;
      console.log(`${adapter.id.padEnd(16)} ${site.generated.length} generated  ${site.dir}`);
      if (site.foreign.length) console.log(`                  ${site.foreign.length} hand-written file(s), left untouched`);
    }
    return 0;
  }

  if (action === "disable") {
    let removed = 0;
    for (const adapter of adapters) {
      const dir = adapter.userOut!;
      if (!existsSync(dir)) continue;
      const files: string[] = [];
      const visit = (at: string, prefix = "") => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) visit(join(at, entry.name), rel);
          else if (entry.isFile() && /\.(?:md|toml)$/.test(entry.name)) files.push(rel);
        }
      };
      visit(dir);
      for (const rel of files) {
        const path = join(dir, rel);
        if (readFileSync(path, "utf8").includes("GENERATED from se/agents/")) {
          rmSync(path);
          removed++;
        }
      }
    }
    console.log(`removed ${removed} generated definition(s); hand-written files were left untouched`);
    return 0;
  }

  if (action !== "enable") {
    console.error('usage: se agents <enable|disable|status> [--host <id>] [--roster a,b,c] [--all] [--force]');
    return 2;
  }
  const { registry, diags } = loadCatalogue(root);
  const roleErrors = diags.sorted().filter((d) => d.code.startsWith("role/"));
  if (roleErrors.length) {
    console.error(diags.format({ color: useColor(args.flags) }));
    console.error("error: refusing global install while role files have errors.");
    return 1;
  }
  const routable = registry.all.filter((r) => r.enabled && r.status === "active");
  const rosterFlag = args.flags.get("roster");
  let selected: readonly Role[];
  if (typeof rosterFlag === "string") {
    const ids = rosterFlag.split(",").map((id) => id.trim()).filter(Boolean);
    const missing = ids.filter((id) => !registry.byId.has(id));
    if (missing.length) { console.error(`error: unknown role id(s): ${missing.join(", ")}`); return 2; }
    selected = ids.map((id) => registry.byId.get(id)!);
  } else selected = args.flags.has("all") ? routable : routable.filter((r) => r.tier === "starter");
  if (!selected.length) { console.error("error: selected roster is empty."); return 1; }

  // Preflight every host before the first write so a foreign-file conflict or
  // metadata ceiling cannot leave a half-installed global roster.
  for (const adapter of adapters) {
    const rendered = adapter.render(selected, root);
    if (adapter.metadataTokenBudget !== null && rendered.metadataTokens > adapter.metadataTokenBudget && !args.flags.has("force")) {
      console.error(`error: ${adapter.id} roster is ~${rendered.metadataTokens} metadata tokens, over its ${adapter.metadataTokenBudget} budget; use --roster or --force.`);
      return 1;
    }
    try {
      mkdirSync(adapter.userOut!, { recursive: true });
    } catch (cause) {
      console.error(`error: cannot prepare ${adapter.id} output directory ${adapter.userOut}: ${(cause as NodeJS.ErrnoException).message}`);
      return 1;
    }
    for (const file of rendered.files) {
      const target = join(adapter.userOut!, file.path);
      try {
        if (existsSync(target)) {
          const current = readFileSync(target, "utf8");
          if (!current.includes("GENERATED from se/agents/")) {
            console.error(`error: refusing to overwrite hand-written file ${target}`);
            return 1;
          }
          if (current.replace(/\r\n?/g, "\n") !== file.contents.replace(/\r\n?/g, "\n")) {
            const fd = openSync(target, "r+");
            closeSync(fd);
          }
        } else {
          mkdirSync(dirname(target), { recursive: true });
          accessSync(dirname(target), constants.W_OK);
        }
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        console.error(`error: cannot update ${adapter.id} generated file ${target}${code ? ` (${code})` : ""}.`);
        console.error("Close the client or editor holding it, check directory permissions, and rerun agents enable.");
        return 1;
      }
    }
  }
  for (const adapter of adapters) {
    const result = cmdRender(root, new Map([...args.flags, ["host", adapter.id], ["global", true]]));
    if (result !== 0) return result;
  }
  console.log("Global roster installed. Restart or refresh each client to load it; choose roles in that client's own agent picker.");
  return 0;
}

/** One-command first install for a fresh clone. */
function cmdSetup(root: string, args: Args): number {
  const installResult = cmdInstall(args.flags);
  if (installResult !== 0) return installResult;
  return cmdAgents(root, { ...args, positional: ["enable"] });
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case "validate":    return cmdValidate(requireRoot(), args.flags);
    case "roles":       return cmdRoles(requireRoot(), args.flags);
    case "role":        return cmdRole(requireRoot(), args);
    case "ownership":   return cmdOwnership(requireRoot(), args.flags);
    case "departments": return cmdDepartments(requireRoot(), args.flags);
    case "topics":      return cmdTopics(requireRoot(), args.flags);
    case "doctor":      return cmdDoctor(requireRoot(), args.flags);
    case "memory":      return cmdMemory(findProjectRoot(), args.positional, args.flags);
    case "install":     return cmdInstall(args.flags);
    case "link":        return cmdLink(args.flags);
    case "where":       return cmdWhere(requireRoot(), args.flags);
    case "render":      return cmdRender(requireRoot(), args.flags);
    case "agents":      return cmdAgents(requireRoot(), args);
    case "setup":       return cmdSetup(requireRoot(), args);
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
