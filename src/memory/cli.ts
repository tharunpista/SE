/**
 * `se memory <subcommand>`.
 *
 * Every subcommand reports what it actually did. A read reports freshness and
 * the generation it read, and a write reports the store's own `accepted` flag
 * rather than the absence of an exception -- Part XX 79's rule is that the
 * system never claims a write persisted unless the publish completed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AmbiguousProjectError,
  initProject,
  REPO_LOCAL_MEMORY_DIR,
  resolveMemoryLocation,
  resolveProject,
  type MemoryLocation,
  type ProjectIdentity,
} from "./project.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { hashContent, listGenerations, manifestDir } from "./manifest.ts";
import { MemoryStore } from "./store.ts";
import { LIFECYCLE_PHASES, type LifecyclePhase, type WriteGrant, type WriteRequest } from "./types.ts";

export const MEMORY_USAGE = `se memory --- project memory (Part XX)

usage: se memory <subcommand> [options]

subcommands:
  init [--id <id>]          Pin this project's memory namespace in .se/project.json.
                            Derived from the git remote when --id is omitted.
                            --local  keep the store inside the project, so it can
                                     be committed and shared (default is global)
  status                    Generation, record count, and store location.
  doctor                    Check every invariant (Part XX 80). Exit 1 on failure.
  list                      List live record ids with status and revision.
  get <record-id>           Print one record, with freshness of its sources.
  put --file <path>         Write a record from a JSON file.
                            --phase <name>     lifecycle phase (default: outcome-recording)
                            --approve <who>    operator approval, required by promotion

options:
  --project <id>            Project namespace. Defaults to the repository directory name.
  --memory-root <path>      Tier 0 root. Overrides the resolved placement.
                            Resolution: --memory-root, SE_MEMORY_ROOT,
                            <project>/memory if it exists, else ~/.se/memory.
  --json                    Machine-readable output.
`;

type Flags = ReadonlyMap<string, string | true>;

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export interface MemoryContext {
  readonly memoryRoot: string;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly identity: ProjectIdentity;
  readonly location: MemoryLocation;
}

export function resolveContext(repoRoot: string, flags: Flags): MemoryContext {
  // Global by default; repo-local when the project has opted in by having the
  // directory. Both are namespaced by project id, so the placement changes who
  // can see the memory, never which project it belongs to.
  const location = resolveMemoryLocation(repoRoot, { flag: flagString(flags, "memory-root") });

  // Part XX 23: resolved from reliable metadata or refused. The directory name
  // is not reliable metadata -- renaming the folder would silently start a new,
  // empty memory and orphan everything written before.
  const identity = resolveProject(repoRoot, { flag: flagString(flags, "project") });

  return { memoryRoot: location.root, projectId: identity.id, repoRoot, identity, location };
}

function store(ctx: MemoryContext): MemoryStore {
  return new MemoryStore({ memoryRoot: ctx.memoryRoot, projectId: ctx.projectId });
}

function cmdStatus(ctx: MemoryContext, flags: Flags): number {
  const generations = listGenerations(manifestDir(ctx.memoryRoot, ctx.projectId));
  const s = store(ctx);
  const live = s.liveManifest();

  if (flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          project_id: ctx.projectId,
          memory_root: ctx.memoryRoot,
          generation: live?.generation ?? -1,
          generations: generations.length,
          records: live ? Object.keys(live.entries).length : 0,
          committed_at: live?.committed_at ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`project:      ${ctx.projectId}`);
  // Where the identity came from matters: a `git-remote` identity is stable but
  // unpinned, so it changes if the remote changes.
  console.log(
    `identity:     ${ctx.identity.source}` +
      (ctx.identity.origin ? ` (${ctx.identity.origin})` : "") +
      (ctx.identity.source === "git-remote" || ctx.identity.source === "package-name"
        ? " -- not pinned; run `se memory init` to commit it"
        : ""),
  );
  console.log(
    `store:        ${ctx.location.source}` +
      (ctx.location.committable
        ? " (inside the project; commit it to share with the team)"
        : " (personal; not shared, not reviewed)"),
  );
  console.log(`memory root:  ${ctx.memoryRoot}`);
  if (!live) {
    console.log(`generation:   none -- this project has no memory yet`);
    return 0;
  }
  console.log(`generation:   ${live.generation} (${generations.length} in the chain)`);
  console.log(`records:      ${Object.keys(live.entries).length} live`);
  console.log(`committed:    ${live.committed_at}`);
  return 0;
}

function cmdDoctor(ctx: MemoryContext, flags: Flags): number {
  const report = runDoctor({
    memoryRoot: ctx.memoryRoot,
    projectId: ctx.projectId,
    sourceRoot: ctx.repoRoot,
  });

  if (flags.has("json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));

  // A failing invariant is a build failure, not a logged warning (Part XX 80).
  return report.ok ? 0 : 1;
}

function cmdList(ctx: MemoryContext, flags: Flags): number {
  const s = store(ctx);
  const live = s.liveManifest();
  if (!live) {
    if (flags.has("json")) console.log("[]");
    else console.log("no records");
    return 0;
  }

  const rows = Object.entries(live.entries)
    .map(([id, entry]) => ({
      record_id: id,
      revision: entry.revision,
      status: entry.status,
      scope: entry.scope,
      type: entry.type,
    }))
    .sort((a, b) => (a.record_id < b.record_id ? -1 : 1));

  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  const width = Math.max(9, ...rows.map((r) => r.record_id.length));
  console.log(`${"record".padEnd(width)}  rev  status      scope         type`);
  for (const r of rows) {
    console.log(
      `${r.record_id.padEnd(width)}  ${String(r.revision).padStart(3)}  ` +
        `${r.status.padEnd(10)}  ${r.scope.padEnd(12)}  ${r.type}`,
    );
  }
  return 0;
}

function cmdGet(ctx: MemoryContext, recordId: string | undefined, flags: Flags): number {
  if (!recordId) {
    console.error("error: se memory get requires a record id");
    return 2;
  }
  const s = store(ctx);
  const record = s.get(recordId);
  if (!record) {
    console.error(`error: no live record "${recordId}" in project "${ctx.projectId}"`);
    return 1;
  }

  // Part XX 76: a returned record carries its freshness, so an agent can see
  // that the only relevant record describes source that has since changed.
  const freshness = record.source_refs.map((ref) => {
    const path = join(ctx.repoRoot, ref.path);
    if (!existsSync(path)) return { path: ref.path, state: "missing" as const };
    const actual = hashContent(readFileSync(path, "utf8"));
    return { path: ref.path, state: actual === ref.hash ? ("current" as const) : ("stale" as const) };
  });

  if (flags.has("json")) {
    console.log(JSON.stringify({ record, freshness }, null, 2));
    return 0;
  }

  console.log(`${record.record_id} v${record.revision}  [${record.status}]  ${record.scope}/${record.type}`);
  console.log(`owner:     ${record.owner}`);
  console.log(`trust:     ${record.trust_tier}`);
  console.log(`written:   ${record.written_at}`);
  if (record.superseded_by) console.log(`superseded by: ${record.superseded_by}`);
  console.log("");
  console.log(record.summary);
  if (record.body) {
    console.log("");
    console.log(record.body);
  }
  if (freshness.length > 0) {
    console.log("");
    console.log("sources:");
    for (const f of freshness) console.log(`  ${f.state.padEnd(8)} ${f.path}`);
    if (freshness.some((f) => f.state !== "current")) {
      console.log("");
      console.log("note: live source supersedes any memory summary about it (Part XX 71).");
    }
  }
  return 0;
}

function cmdPut(ctx: MemoryContext, flags: Flags): number {
  const file = flagString(flags, "file");
  if (!file) {
    console.error("error: se memory put requires --file <path> containing a JSON write request");
    return 2;
  }
  const path = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(path)) {
    console.error(`error: ${path} does not exist`);
    return 2;
  }

  let request: WriteRequest;
  try {
    request = JSON.parse(readFileSync(path, "utf8")) as WriteRequest;
  } catch (cause) {
    console.error(`error: ${path} is not valid JSON: ${(cause as Error).message}`);
    return 2;
  }

  const phaseFlag = flagString(flags, "phase") ?? "outcome-recording";
  if (!(LIFECYCLE_PHASES as readonly string[]).includes(phaseFlag)) {
    console.error(`error: unknown phase "${phaseFlag}". One of: ${LIFECYCLE_PHASES.join(", ")}`);
    return 2;
  }

  const approve = flagString(flags, "approve");
  const grant: WriteGrant = {
    phase: phaseFlag as LifecyclePhase,
    write_targets: [request.record_id],
    scopes: [request.scope],
    owner: request.owner,
    ...(approve ? { approved_by: approve } : {}),
  };

  const result = store(ctx).put(request, grant);

  if (flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
    return result.accepted ? 0 : 1;
  }

  if (result.accepted) {
    console.log(
      result.deduplicated
        ? `unchanged: ${result.record_id} is already at revision ${result.revision} ` +
            `(identical content; no new revision created)`
        : `accepted: ${result.record_id} revision ${result.revision} at generation ${result.generation}`,
    );
    return 0;
  }

  // Part XX 79: never a false success, and never a silent loss of the content.
  console.error(`REFUSED [${result.code}] ${result.record_id}`);
  console.error(`  ${result.message}`);
  if (result.conflicting_revision !== undefined) {
    console.error(`  live revision is ${result.conflicting_revision}`);
  }
  console.error("");
  console.error("  the submitted content was not stored and is reproduced here:");
  console.error(
    JSON.stringify(result.surfaced, null, 2)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  return 1;
}

function cmdInit(repoRoot: string, flags: Flags): number {
  try {
    const result = initProject(repoRoot, flagString(flags, "id"));

    // Opting in to the committed placement is creating the directory. Keeping
    // the choice in the file tree rather than in configuration means a reviewer
    // can see it, and a clone inherits it without reading any config.
    if (flags.has("local")) {
      const local = join(repoRoot, REPO_LOCAL_MEMORY_DIR);
      mkdirSync(local, { recursive: true });
      if (!existsSync(join(local, ".gitkeep"))) {
        writeFileSync(join(local, ".gitkeep"), "", "utf8");
      }
      console.log(`using repo-local memory: ${local}`);
      console.log("Commit it. Tier 0 is plain diffable JSON on purpose (Part XX 70).");
      console.log("");
    }

    if (flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(
      result.created
        ? `wrote ${result.path}`
        : `${result.path} already pins this project; left unchanged`,
    );
    console.log(`project id:   ${result.identity.id}`);
    console.log(`label:        ${result.identity.label}`);
    if (result.identity.origin) console.log(`derived from: ${result.identity.origin}`);
    if (result.created) {
      console.log("");
      console.log("Commit this file. A project id that differs per checkout is the");
      console.log("problem it solves: memory written under one id is unreachable under another.");
    }
    return 0;
  } catch (cause) {
    console.error(`error: ${(cause as Error).message}`);
    return 2;
  }
}

export function cmdMemory(repoRoot: string, positional: readonly string[], flags: Flags): number {
  const sub = positional[0];

  // `init` and `help` are the two subcommands that must work *before* an
  // identity exists, so they are dispatched ahead of resolution.
  if (sub === "init") return cmdInit(repoRoot, flags);
  if (sub === undefined || sub === "help") {
    console.log(MEMORY_USAGE);
    return 0;
  }

  let ctx: MemoryContext;
  try {
    ctx = resolveContext(repoRoot, flags);
  } catch (cause) {
    if (cause instanceof AmbiguousProjectError) {
      console.error(`error: ${cause.message}`);
      return 2;
    }
    console.error(`error: ${(cause as Error).message}`);
    return 2;
  }

  switch (sub) {
    case "status":
      return cmdStatus(ctx, flags);
    case "doctor":
      return cmdDoctor(ctx, flags);
    case "list":
      return cmdList(ctx, flags);
    case "get":
      return cmdGet(ctx, positional[1], flags);
    case "put":
      return cmdPut(ctx, flags);
    default:
      console.error(`error: unknown memory subcommand "${sub}"\n\n${MEMORY_USAGE}`);
      return 2;
  }
}
