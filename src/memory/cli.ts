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
  ensureRepoLocalMemoryGitignore,
  initProject,
  REPO_LOCAL_MEMORY_DIR,
  resolveMemoryLocation,
  resolveProject,
  type MemoryLocation,
  type ProjectIdentity,
} from "./project.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { describeClaim, recordClaim, type ClaimReport } from "./namespace.ts";
import { assembleContext, DEFAULT_CONTEXT_CHAR_BUDGET, hashProjectSource, MAX_CONTEXT_CHAR_BUDGET, readSourceCatalog } from "./context.ts";
import { listGenerations, manifestDir } from "./manifest.ts";
import { MemoryStore } from "./store.ts";
import {
  LIFECYCLE_PHASES,
  MEMORY_SCOPES,
  PHASE_RULES,
  type Evidence,
  type TrustTier,
  type LifecyclePhase,
  type MemoryScope,
  type WriteGrant,
  type WriteRequest,
  type WriteResult,
} from "./types.ts";

export const MEMORY_USAGE = `se memory --- project memory (Part XX)

usage: se memory <subcommand> [options]

subcommands:
  init [--id <id>]          Pin this project's memory namespace in .se/project.json.
                            Derived from the git remote when --id is omitted.
                            --local  keep private runtime records in ./memory
                                     (default is the user-level store)
  status                    Which project, which namespace, which generation.
  doctor                    Check every invariant (Part XX 80). Exit 1 on failure.
  brief                     Project identity plus all memory, for a session's
                            first turn. Always exits 0; safe in a hook.
                            --hook   read a SessionStart payload on stdin and
                                     answer in the host's hook format. Injects
                                     only for a new context window, never on
                                     resume, compact or fork.
  recall [topic]            Every live record, newest first, with freshness.
                            --limit <n>        at most n records
                            --budget <tokens>  stop at this size (default 4000)
                            --scope <scope>    only this scope
                            --type <type>      only this type
  remember "<summary>"      Write one record. Revision, source hashes, record id
                            and lifecycle phase are all resolved for you.
                            --id <record-id>   default: a slug of the summary
                            --type <type>      default: note
                            --body <text>      the detail behind the summary
                            --scope <scope>    default: project
                            --source <path>    file this describes; repeatable
                            --evidence "<cmd>:<exit>"  proof; repeatable
                            --owner <role-id>  default: operator
                            --task <task-id>   groups a run's records
                            --superseded-by <id>  retire this record for another
                            --dry-run          print the request, write nothing
  list                      List live record ids with status and revision.
  get <record-id>           Print one record, with freshness of its sources.
  sources                   List explicitly allowed local context sources.
  context --query <text>    Build bounded context with exact source provenance.
  put --file <path>         Write a record from a JSON file (the explicit form).
                            --phase <name>     lifecycle phase (default: outcome-recording)
                            --approve <who>    operator approval, required by promotion

options:
  --project <id>            Project namespace override. Otherwise resolved from
                            .se/project.json, Git remote, or package name.
  --memory-root <path>      Tier 0 root. Overrides the resolved placement.
                            Resolution: --memory-root, SE_MEMORY_ROOT,
                            <project>/memory if it exists, else ~/.se/memory.
  --max-chars <n>           Context output budget (default ${DEFAULT_CONTEXT_CHAR_BUDGET}; max ${MAX_CONTEXT_CHAR_BUDGET}).
  --json                    Machine-readable output.

Context reads only the local files explicitly listed in .se/sources.json. It
does not scan the repository, copy source files into memory, or return a file
containing secret-shaped values. Source files remain authoritative over memory.
`;

type Flags = ReadonlyMap<string, string | true>;

/** A scalar flag. A repeated one takes its last occurrence, as CLIs usually do. */
function flagString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (typeof value !== "string") return undefined;
  const lines = value.split("\n");
  return lines[lines.length - 1];
}

export interface MemoryContext {
  readonly memoryRoot: string;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly identity: ProjectIdentity;
  readonly location: MemoryLocation;
  /** Which other directories have used this namespace, and whether that is deliberate. */
  readonly claim: ClaimReport;
}

export function resolveContext(
  repoRoot: string,
  flags: Flags,
  options: { readonly persistClaim?: boolean } = {},
): MemoryContext {
  // Global by default; repo-local when the project has opted in by having the
  // directory. Both are namespaced by project id, so the placement changes who
  // can see the memory, never which project it belongs to.
  const location = resolveMemoryLocation(repoRoot, { flag: flagString(flags, "memory-root") });

  // Part XX 23: resolved from reliable metadata or refused. The directory name
  // is not reliable metadata -- renaming the folder would silently start a new,
  // empty memory and orphan everything written before.
  const identity = resolveProject(repoRoot, { flag: flagString(flags, "project") });

  /*
   * Identity resolution stops a rename from orphaning memory; it does not stop
   * two unrelated projects agreeing on an id and sharing one store. Recording
   * the claiming directory is what makes that visible, so it happens on every
   * command rather than only in `status`: the warning is worthless if it only
   * appears where someone already went looking for it.
   */
  const claim = recordClaim({
    memoryRoot: location.root,
    projectId: identity.id,
    repoRoot,
    identitySource: identity.source,
    origin: identity.origin,
    ...(options.persistClaim === undefined ? {} : { persist: options.persistClaim }),
  });

  return { memoryRoot: location.root, projectId: identity.id, repoRoot, identity, location, claim };
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
          identity_source: ctx.identity.source,
          identity_origin: ctx.identity.origin ?? null,
          identity_pinned: ctx.identity.source === "config" || ctx.identity.source === "flag",
          namespace_status: ctx.claim.status,
          namespace_also_claimed_by: ctx.claim.others.map((o) => o.path),
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
      (ctx.location.source === "repo-local"
        ? " (private to this checkout; ignored by Git)"
        : ctx.location.source === "global"
          ? " (private to this user account)"
          : " (custom location; check its access and backup policy)"),
  );
  console.log(`memory root:  ${ctx.memoryRoot}`);
  // Who else uses this namespace. "this directory only" is the answer that lets
  // an operator trust that the records below belong to the project in front of
  // them, which is the whole question `status` exists to answer.
  const otherCount = ctx.claim.others.length;
  console.log(
    `namespace:    ` +
      (ctx.claim.status === "ambiguous"
        ? `AMBIGUOUS -- also used by ${otherCount} unrelated director${otherCount === 1 ? "y" : "ies"}; see the warning above`
        : ctx.claim.status === "shared"
          ? `shared with ${otherCount} other checkout${otherCount === 1 ? "" : "s"} of this project (deliberate)`
          : ctx.claim.status === "new"
            ? `this directory only (first use)`
            : `this directory only`),
  );
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
  const freshness = freshnessOf(ctx.repoRoot, record.source_refs);

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

/** A repeatable flag. `--source a --source b` collects both, in order. */
function flagList(flags: Flags, name: string): string[] {
  const value = flags.get(name);
  if (typeof value !== "string") return [];
  return value.split("\n").filter((v) => v.length > 0);
}

/**
 * Freshness of one source reference, relative to the working tree.
 * `missing` is distinct from `stale`: a deleted file and a changed file call
 * for different responses from whoever reads the record.
 */
function freshnessOf(
  repoRoot: string,
  refs: readonly { readonly path: string; readonly hash: string }[],
): { path: string; state: "current" | "stale" | "missing" | "unsafe" }[] {
  return refs.map((ref) => {
    const normalized = ref.path.replace(/\\/g, "/");
    if (isAbsolute(ref.path) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//") || normalized.split("/").includes("..")) {
      return { path: ref.path, state: "unsafe" as const };
    }
    try {
      const current = hashProjectSource(repoRoot, ref.path);
      return { path: ref.path, state: current.hash === ref.hash ? ("current" as const) : ("stale" as const) };
    } catch {
      const candidate = isAbsolute(ref.path) ? ref.path : join(repoRoot, ref.path);
      return { path: ref.path, state: existsSync(candidate) ? ("unsafe" as const) : ("missing" as const) };
    }
  });
}

/**
 * The phase a write belongs to, derived from what it is rather than asked for.
 *
 * Phases exist to gate writes (Part XX 75), but naming one is a protocol detail
 * that a caller with a sentence to record should not have to learn. Scope plus
 * the presence of evidence determines the phase unambiguously, so it is
 * derived, and `--phase` remains available to state one explicitly.
 */
function phaseForScope(scope: MemoryScope, hasEvidence: boolean): LifecyclePhase {
  if (scope === "role" || scope === "organization") return "promotion";
  if (scope === "project") return "outcome-recording";
  return hasEvidence ? "verification" : "execution";
}

/** `"bun test:0"` -> command evidence with exit code 0. A bare string is a note. */
function parseEvidence(raw: string, now: string): Evidence {
  const match = /^(.*):(\d+)$/.exec(raw);
  if (match) {
    return {
      kind: "command",
      detail: match[1]!,
      exit_code: Number(match[2]),
      recorded_at: now,
    };
  }
  return { kind: "operator", detail: raw, recorded_at: now };
}

/**
 * Lower-case, dash-separated, usable as a directory name.
 *
 * Truncation stops at a word boundary. A record id is the handle a human uses
 * to ask for a record again, and `...-and-must-mo` is not a handle anyone
 * reads, types or recognises.
 */
function slugRecordId(summary: string): string {
  const words = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);

  const parts: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length === 0 ? word.length : length + 1 + word.length;
    if (next > 48) break;
    parts.push(word);
    length = next;
  }

  // A single word longer than the limit still has to produce an id.
  return parts.join("-") || words[0]?.slice(0, 48) || "note";
}

/**
 * `se memory remember` --- one command, one record.
 *
 * `put --file` requires the caller to author a full write request, including the
 * live revision and a hash per source file. That is correct and it is also why
 * nothing uses it: an agent cannot reliably assemble it, and a refusal teaches
 * it to stop trying. This command computes the mechanical parts -- expected
 * revision, source hashes, record id, phase -- and leaves the caller only the
 * things it alone knows.
 *
 * Nothing about the protocol is relaxed. The same store, the same gates, the
 * same refusals. The difference is only that the easy path is now the correct
 * one.
 */
function cmdRemember(ctx: MemoryContext, positional: readonly string[], flags: Flags): number {
  const summary = positional[1];
  if (!summary || !summary.trim()) {
    console.error('error: se memory remember requires a summary, e.g. se memory remember "the API returns 409 on duplicate submit"');
    return 2;
  }

  const scopeFlag = flagString(flags, "scope") ?? "project";
  if (!(MEMORY_SCOPES as readonly string[]).includes(scopeFlag)) {
    console.error(`error: unknown scope "${scopeFlag}". One of: ${MEMORY_SCOPES.join(", ")}`);
    return 2;
  }
  const scope = scopeFlag as MemoryScope;

  const now = new Date().toISOString();
  const evidence = flagList(flags, "evidence").map((raw) => parseEvidence(raw, now));
  const phase = (flagString(flags, "phase") as LifecyclePhase | undefined) ?? phaseForScope(scope, evidence.length > 0);
  if (!(LIFECYCLE_PHASES as readonly string[]).includes(phase)) {
    console.error(`error: unknown phase "${phase}". One of: ${LIFECYCLE_PHASES.join(", ")}`);
    return 2;
  }

  /*
   * Report the two gates that a caller can satisfy before the store refuses
   * them, because a refusal here can name the exact flag that fixes it while
   * the store can only name the rule. The store still enforces both: this is a
   * better message, not a substitute check.
   */
  const rule = PHASE_RULES[phase];
  if (rule.requires_evidence && evidence.length === 0) {
    console.error(`error: a ${scope}-scope record is written in phase "${phase}", which requires evidence.`);
    console.error("");
    console.error("  attach what proves it:");
    console.error('    --evidence "bun test:0"        a command and its exit code');
    console.error('    --evidence "reviewed with the operator"');
    console.error("");
    console.error("  or keep it to this session, where evidence is not required:");
    console.error("    --scope session");
    return 2;
  }
  if (rule.requires_approval && !flagString(flags, "approve")) {
    console.error(`error: phase "${phase}" writes beyond this project and requires operator approval.`);
    console.error("  an agent cannot grant it: --approve <who>");
    return 2;
  }

  const sources = flagList(flags, "source").map((rel) => hashProjectSource(ctx.repoRoot, rel));

  const recordId = flagString(flags, "id") ?? slugRecordId(summary);
  const s = store(ctx);

  // The caller should never have to look this up, and getting it wrong is the
  // most common cause of a refusal that reads like a bug.
  const live = s.liveManifest()?.entries[recordId];
  const expectedRevision = live?.revision ?? 0;

  const body = flagString(flags, "body");
  const task = flagString(flags, "task");
  const trust = flagString(flags, "trust");
  const supersededBy = flagString(flags, "superseded-by");
  const supersedes = flagString(flags, "supersedes");

  /*
   * Retiring a record is the common case of a status change, and it always
   * names a successor (Part XX 74). Inferring `superseded` from the presence of
   * `--superseded-by` means the caller states the fact rather than the fact and
   * the bookkeeping that follows from it.
   */
  const statusFlag =
    flagString(flags, "status") ?? (supersededBy ? "superseded" : live ? live.status : "active");

  const request: WriteRequest = {
    record_id: recordId,
    scope,
    type: flagString(flags, "type") ?? "note",
    status: statusFlag as WriteRequest["status"],
    summary: summary.trim(),
    ...(body === undefined ? {} : { body }),
    source_refs: sources,
    evidence,
    owner: flagString(flags, "owner") ?? "operator",
    expected_revision: expectedRevision,
    ...(trust === undefined ? {} : { trust_tier: trust as TrustTier }),
    ...(task === undefined ? {} : { task_id: task }),
    ...(supersededBy === undefined ? {} : { superseded_by: supersededBy }),
    ...(supersedes === undefined ? {} : { supersedes }),
  };

  if (flags.has("dry-run")) {
    console.log(JSON.stringify({ phase, grant_scope: scope, request }, null, 2));
    console.log("");
    console.log("dry run: nothing was written.");
    return 0;
  }

  const grant: WriteGrant = {
    phase,
    write_targets: [recordId],
    scopes: [scope],
    owner: request.owner,
    ...(flagString(flags, "approve") ? { approved_by: flagString(flags, "approve")! } : {}),
  };

  return reportWrite(s.put(request, grant), flags);
}

/**
 * `se memory recall` --- the whole live store in one call, newest first.
 *
 * Retrieval was three commands: list, then get per id, then compare hashes by
 * hand. Nothing reads memory that way, so in practice nothing read memory. This
 * returns every live record with its freshness already resolved, bounded by a
 * token budget so it can be injected into a context window without measuring it
 * first.
 */
function cmdRecall(ctx: MemoryContext, positional: readonly string[], flags: Flags): number {
  const topic = positional[1]?.toLowerCase();
  const s = store(ctx);
  const live = s.liveManifest();

  if (!live || Object.keys(live.entries).length === 0) {
    if (flags.has("json")) console.log(JSON.stringify({ project_id: ctx.projectId, records: [] }, null, 2));
    else console.log(`no memory for project "${ctx.projectId}" yet.`);
    return 0;
  }

  const scopeFilter = flagString(flags, "scope");
  const typeFilter = flagString(flags, "type");

  const records = Object.keys(live.entries)
    .map((id) => s.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter((r) => (scopeFilter ? r.scope === scopeFilter : true))
    .filter((r) => (typeFilter ? r.type === typeFilter : true))
    .filter((r) =>
      topic
        ? [r.record_id, r.summary, r.body ?? "", r.type].join("\n").toLowerCase().includes(topic)
        : true,
    )
    // Active before superseded, then newest first: a reader who stops early
    // should have stopped on the least useful records, not the most recent.
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.written_at < b.written_at ? 1 : -1;
    });

  const limit = Number(flagString(flags, "limit") ?? "0");
  const budget = Number(flagString(flags, "budget") ?? "4000");
  const selected: typeof records = [];
  let spent = 0;

  for (const record of records) {
    if (limit > 0 && selected.length >= limit) break;
    // ~4 characters per token is close enough to hold a budget; the point is a
    // bound that exists, not a measurement that is exact.
    const cost = Math.ceil((record.summary.length + (record.body?.length ?? 0) + 120) / 4);
    if (selected.length > 0 && spent + cost > budget) break;
    selected.push(record);
    spent += cost;
  }

  const omitted = records.length - selected.length;

  if (flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          project_id: ctx.projectId,
          generation: live.generation,
          namespace_status: ctx.claim.status,
          returned: selected.length,
          omitted,
          records: selected.map((r) => ({
            record_id: r.record_id,
            revision: r.revision,
            status: r.status,
            scope: r.scope,
            type: r.type,
            summary: r.summary,
            body: r.body ?? null,
            owner: r.owner,
            trust_tier: r.trust_tier,
            written_at: r.written_at,
            freshness: freshnessOf(ctx.repoRoot, r.source_refs),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`# Project memory --- ${ctx.projectId} (generation ${live.generation})`);
  console.log("");
  for (const record of selected) {
    const freshness = freshnessOf(ctx.repoRoot, record.source_refs);
    const stale = freshness.filter((f) => f.state !== "current");
    console.log(
      `## ${record.record_id}  [${record.status}]  ${record.scope}/${record.type}` +
        (stale.length > 0 ? `  -- STALE` : ""),
    );
    console.log(record.summary);
    if (record.body) {
      console.log("");
      console.log(record.body);
    }
    if (record.source_refs.length > 0) {
      console.log("");
      console.log(`sources: ${freshness.map((f) => `${f.path} (${f.state})`).join(", ")}`);
    }
    if (stale.length > 0) {
      console.log("note: the source changed since this was written; read the source, not this.");
    }
    console.log("");
  }
  if (omitted > 0) {
    console.log(`(${omitted} further record(s) omitted by the ${budget}-token budget; raise it with --budget)`);
  }
  return 0;
}

/**
 * `se memory brief` --- what a session needs to know before its first turn.
 *
 * This is the command a SessionStart hook runs, and it is shaped by that:
 *
 *   - It names the project and where the identity came from, because an agent
 *     resuming after a week has no idea which of several projects it is in, and
 *     the operator has no idea which one it picked.
 *   - It reports an ambiguous namespace inline rather than on stderr, since a
 *     hook's stderr is not read by anyone and that warning is the one thing
 *     here that can make every record below it wrong.
 *   - It always exits 0. A session must start even when memory is unreadable;
 *     failing the hook would make a broken store look like a broken install.
 */
/**
 * Session sources at which injecting memory is worth its tokens.
 *
 * `resume`, `compact` and `fork` all continue a conversation that already
 * carries the brief, so re-injecting pays for the same records twice and
 * displaces the conversation it was meant to inform. Only a genuinely new
 * context window gets one.
 */
const INJECT_AT_SOURCE = new Set(["startup", "clear"]);

/**
 * `--hook`: read the host's SessionStart payload from stdin and answer in the
 * shape it expects.
 *
 * Kept inside the command rather than in a shell wrapper so the decision about
 * *when* injection is worth its cost is tested, not duplicated per host.
 *
 * Three refusals are deliberate and silent: a non-new session source, an
 * unparseable payload, and any error at all. A hook that fails loudly on
 * session start breaks every session in the project, which is a far worse
 * outcome than a session without memory. Exit is always 0.
 */
function cmdBriefHook(ctx: MemoryContext, flags: Flags): number {
  let source = "startup";
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw.length > 0) {
      const payload = JSON.parse(raw) as { source?: unknown };
      if (typeof payload.source === "string") source = payload.source;
    }
  } catch {
    // No payload, or not JSON. Treat as a new session rather than refusing:
    // a host that calls the hook without one still deserves its memory.
  }

  if (!INJECT_AT_SOURCE.has(source)) {
    // Nothing to say. An empty object is a valid no-op response.
    console.log("{}");
    return 0;
  }

  const captured: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void captured.push(args.join(" "));
  try {
    cmdBrief(ctx, flags);
  } catch (cause) {
    captured.push(`Project memory could not be read: ${(cause as Error).message}`);
  } finally {
    console.log = log;
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: captured.join("\n"),
      },
    }),
  );
  return 0;
}

function cmdBrief(ctx: MemoryContext, flags: Flags): number {
  const lines: string[] = [];
  try {
    const s = store(ctx);
    const live = s.liveManifest();

    lines.push(`Project: ${ctx.projectId} (identity: ${ctx.identity.source}${ctx.identity.origin ? `, from ${ctx.identity.origin}` : ""})`);
    lines.push(`Memory:  ${ctx.memoryRoot}`);

    if (ctx.claim.status === "ambiguous") {
      lines.push("");
      lines.push(
        `WARNING: the namespace "${ctx.projectId}" is also used by ${ctx.claim.others.length} unrelated ` +
          `director${ctx.claim.others.length === 1 ? "y" : "ies"} ` +
          `(${ctx.claim.others.map((o) => o.path).join(", ")}). ` +
          `Records below may belong to a different project. Do not trust them until an operator ` +
          `pins this project with \`se memory init --id <stable-id>\`.`,
      );
    }

    if (!live || Object.keys(live.entries).length === 0) {
      lines.push("");
      lines.push("No project memory yet. Record a decision when one is made:");
      lines.push('  se memory remember "<what was decided>" --evidence "<command>:<exit>"');
      console.log(lines.join("\n"));
      return 0;
    }

    const count = Object.keys(live.entries).length;
    lines.push(`Records: ${count} live at generation ${live.generation}`);
    lines.push("");
    lines.push("Read these before reading source: a record is a few hundred tokens, the");
    lines.push("files it summarises are thousands. A record marked STALE describes source");
    lines.push("that has since changed, and the live source always wins.");
    console.log(lines.join("\n"));
    console.log("");
    return cmdRecall(ctx, ["recall"], flags);
  } catch (cause) {
    // Never fail a session over memory. Say what broke and let work continue.
    console.log(lines.join("\n"));
    console.log("");
    console.log(`Project memory could not be read: ${(cause as Error).message}`);
    console.log("Run `se memory doctor` before relying on it.");
    return 0;
  }
}

/** One reporting path for every write, so no caller invents a success message. */
function reportWrite(result: WriteResult, flags: Flags): number {
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

  return reportWrite(store(ctx).put(request, grant), flags);
}

function cmdSources(ctx: MemoryContext): number {
  try {
    const catalog = readSourceCatalog(ctx.repoRoot);
    console.log(JSON.stringify({
      schema_version: catalog.schema_version,
      catalog_path: join(ctx.repoRoot, ".se", "sources.json"),
      project_id: ctx.projectId,
      sources: catalog.sources,
      note: "Only explicitly listed local files are eligible for context retrieval. Source contents stay in the project and are not copied into memory.",
    }, null, 2));
    return 0;
  } catch (cause) {
    console.error(`error: ${(cause as Error).message}`);
    return 2;
  }
}

function cmdContext(ctx: MemoryContext, flags: Flags): number {
  const query = flagString(flags, "query");
  if (!query) {
    console.error('error: se memory context requires --query "what you are building or need to change"');
    return 2;
  }
  const budgetText = flagString(flags, "max-chars");
  const maxChars = budgetText === undefined ? DEFAULT_CONTEXT_CHAR_BUDGET : Number(budgetText);
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > MAX_CONTEXT_CHAR_BUDGET) {
    console.error(`error: --max-chars must be an integer between 500 and ${MAX_CONTEXT_CHAR_BUDGET}`);
    return 2;
  }
  try {
    const context = assembleContext({
      repoRoot: ctx.repoRoot,
      projectId: ctx.projectId,
      query,
      store: store(ctx),
      maxChars,
    });
    console.log(JSON.stringify(context));
    return 0;
  } catch (cause) {
    console.error(`error: ${(cause as Error).message}`);
    return 2;
  }
}

function cmdInit(repoRoot: string, flags: Flags): number {
  try {
    const result = initProject(repoRoot, flagString(flags, "id"));

    // Opting in to checkout-local private placement is creating the directory.
    if (flags.has("local")) {
      const local = join(repoRoot, REPO_LOCAL_MEMORY_DIR);
      mkdirSync(local, { recursive: true });
      if (!existsSync(join(local, ".gitkeep"))) {
        writeFileSync(join(local, ".gitkeep"), "", "utf8");
      }
      const ignore = ensureRepoLocalMemoryGitignore(repoRoot);
      console.log(`using repo-local memory: ${local}`);
      console.log(`${ignore.changed ? "wrote" : "kept"} ${ignore.path} (runtime records are excluded from Git)`);
      console.log("Runtime records stay ignored by Git. Curate and review any knowledge before sharing it.");
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
    // Context assembly is pure: even advisory namespace access metadata is not written.
    ctx = resolveContext(repoRoot, flags, { persistClaim: sub !== "context" });
  } catch (cause) {
    /*
     * In hook mode a resolution failure is not an error, it is "no memory
     * here". The hook is installed globally and therefore fires in every
     * directory, most of which are not projects: a home directory, a scratch
     * folder, a clone with no manifest or remote. Printing the seven-line
     * identity refusal at every session start in every such directory is how
     * an operator learns to disable the hook.
     *
     * So: answer with the empty no-op, say nothing, exit 0. `se memory status`
     * run by hand still explains the refusal in full, which is where someone
     * who wants to enable memory here will look.
     */
    if (flags.has("hook")) {
      console.log("{}");
      return 0;
    }
    if (cause instanceof AmbiguousProjectError) {
      console.error(`error: ${cause.message}`);
      return 2;
    }
    console.error(`error: ${(cause as Error).message}`);
    return 2;
  }

  /*
   * On stderr, before the command runs. An ambiguous namespace means the
   * records about to be read or written may belong to a different project, and
   * that has to be said even when stdout is being piped into another tool.
   */
  for (const line of describeClaim(ctx.claim, ctx.repoRoot)) console.error(line);

  // A namespace collision makes historical records unsafe as project context.
  if (sub === "context" && ctx.claim.status === "ambiguous") {
    console.error("error: refusing to assemble memory context from an ambiguous project namespace; pin a unique id with `se memory init --id <stable-id>`.");
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
    case "sources":
      return cmdSources(ctx);
    case "context":
      return cmdContext(ctx, flags);
    case "brief":
      return flags.has("hook") ? cmdBriefHook(ctx, flags) : cmdBrief(ctx, flags);
    case "recall":
      return cmdRecall(ctx, positional, flags);
    case "remember":
      try {
        return cmdRemember(ctx, positional, flags);
      } catch (cause) {
        console.error(`error: ${(cause as Error).message}`);
        return 2;
      }
    case "put":
      return cmdPut(ctx, flags);
    default:
      console.error(`error: unknown memory subcommand "${sub}"\n\n${MEMORY_USAGE}`);
      return 2;
  }
}
