import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../roles/types.ts";
import type { CapabilityMap, HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, mapCapabilities, renderRoleInstructions, routingDescription } from "./host.ts";
import { agentsMdAdapter } from "./agents-md.ts";
import { agentSkillsAdapter, claudeConfigDir, claudeSkillsAdapter } from "./agent-skills.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { codexAdapter } from "./codex.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorAdapter } from "./cursor.ts";
import { geminiCliAdapter } from "./gemini-cli.ts";
import { opencodeAdapter } from "./opencode.ts";
import { commandAvailable, resolveProjectFacts, type ProjectFacts } from "../project-facts.ts";

/**
 * Capability -> Claude Code tool names.
 *
 * Capabilities with no entry here are deliberately absent rather than
 * approximated. `memory-read`, `memory-write`, `escalate` and `task-graph`
 * are served by this project's own layer, not by a host tool; rendering them
 * as `Bash` would hand a role a shell it was never granted.
 */
export const CAPABILITIES: CapabilityMap = {
  "read-files": ["Read"],
  search: ["Grep", "Glob"],
  "write-files": ["Write", "Edit"],
  "run-shell": ["Bash"],
  "run-tests": ["Bash"],
  "invoke-agent": ["Agent"],
  "web-fetch": ["WebFetch"],
  "web-search": ["WebSearch"],
  "edit-notebook": ["NotebookEdit"],
  "track-todos": ["TodoWrite"],
  // Skill invocation: runs a named Claude Code skill in the current session
  "invoke-skill": ["Skill"],
  // Browser access — requires permissions-broker approval before use
  "browser-navigate": ["WebFetch"],
  "browser-read": ["WebFetch"],
  // MCP and external API access — declared so the renderer can warn; actual
  // grant is controlled by the host's MCP server registry and permissions-broker
  "mcp-connect": [],
  "external-api-call": ["WebFetch"],
};

/**
 * Host tools that modify files. Withheld from any role that declares
 * `writes_files: false`, whatever its capability list says.
 *
 * `Bash` is deliberately absent: it modifies files too, but a role that needs a
 * shell cannot be given a safe subset of one by this renderer. That containment
 * belongs to the host's permission layer, and a role declaring `run-shell` with
 * `writes_files: false` is therefore an unenforceable combination that
 * `validate` reports rather than silently appearing to honour.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit"]);

/** Capabilities this project serves itself; absence from the host is correct. */
export const INTERNAL_CAPABILITIES = new Set([
  "memory-read", "memory-write", "escalate", "task-graph",
  // Gated capabilities — declared in agent frontmatter, controlled by permissions-broker at runtime
  "mcp-connect", "install-dependency", "file-system-write",
]);

const DEPARTMENT_COLOR: Readonly<Record<string, string>> = {
  orchestration: "purple",
  "product-and-requirements": "blue",
  "design-and-ux": "pink",
  architecture: "cyan",
  frontend: "green",
  "backend-and-data": "blue",
  integration: "orange",
  "ai-and-agent-systems": "cyan",
  "quality-and-testing": "yellow",
  "security-and-privacy": "red",
  "platform-and-operations": "orange",
  "mobile-and-desktop": "green",
  "hardware-and-embedded": "yellow",
  "agent-platform-engineering": "purple",
  "documentation-and-support": "blue",
  "business-and-product-operations": "pink",
};

function yamlString(s: string): string {
  // Quote and escape so a mission containing a colon cannot break the
  // frontmatter. Claude Code skips a subagent whose frontmatter does not
  // parse, and -- critically -- does so without reporting it in the session,
  // so a quoting bug here is a silently missing role.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Stack discipline, loaded once per render rather than copied into each role
 * file. It is injected into the body, which loads only when the role runs, so
 * it costs nothing in always-loaded metadata.
 */
let stackDisciplineCache: string | null | undefined;
/**
 * Minimal-solution discipline, cached the same way and for the same reason as
 * stack discipline just above. Gated on `writes_files` rather than a new
 * per-role flag: every role that edits files already declares that, and 182
 * of 191 already say true, so a second flag would duplicate a fact the
 * catalogue already carries instead of adding a new one.
 */
let minimalSolutionCache: string | null | undefined;
/**
 * Project facts are read once per render, not once per role: 191 roles would
 * otherwise re-read the same manifest 191 times.
 */
let projectFactsCache: ProjectFacts | undefined;
function projectFacts(root: string): ProjectFacts {
  if (projectFactsCache === undefined) projectFactsCache = resolveProjectFacts(root);
  return projectFactsCache;
}

/**
 * Substitute `<project x command>` with the resolved command when one exists.
 * Unknown placeholders are returned untouched, so an unresolvable one stays
 * visible rather than becoming a plausible-looking wrong command.
 */
/*
 * Placeholders are written in prose, not as keys: `<project test command>`,
 * `<project mobile build command>`, `<project-native policy validation
 * command>`. An earlier version matched only a single word and so never even
 * attempted the multi-word majority -- 45 roles asked for policy validation
 * while this project had a `validate` script the whole time.
 *
 * So the inner words are reduced to the fact key they are asking for, and a
 * placeholder whose key has no fact is returned untouched. An honest
 * `<project build command>` in a project with no build script is the right
 * output; a plausible guess is not.
 */
const PLACEHOLDER_ALIASES: ReadonlyMap<string, string> = new Map([
  ["verification", "check"], ["policy validation", "validate"],
  ["schema validation", "validate"], ["schema validate", "validate"],
  ["mobile build", "build"], ["docs build", "build"],
  ["dependency audit", "audit"], ["secret scan", "secrets"],
]);

function resolveCommand(cmd: string, facts: ProjectFacts): string {
  return cmd.replace(/<(?:project-native|project)\s+([a-z][a-z \-]*?)(?:\s+command)?>/g, (whole, raw: string) => {
    const phrase = raw.trim();
    const want = PLACEHOLDER_ALIASES.get(phrase) ?? phrase;
    const hit = facts.facts.find((f) => f.key === want);
    return hit ? hit.value : whole;
  });
}

function stackDiscipline(root: string): string | null {
  if (stackDisciplineCache !== undefined) return stackDisciplineCache;
  const path = join(root, "se", "engineering", "stack-discipline.md");
  stackDisciplineCache = existsSync(path)
    ? readFileSync(path, "utf8").replace(/^#\s+/m, "## ").trim()
    : null;
  return stackDisciplineCache;
}

function minimalSolutionDiscipline(root: string): string | null {
  if (minimalSolutionCache !== undefined) return minimalSolutionCache;
  const path = join(root, "se", "engineering", "minimal-solution.md");
  minimalSolutionCache = existsSync(path)
    ? readFileSync(path, "utf8").replace(/^#\s+/m, "## ").trim()
    : null;
  return minimalSolutionCache;
}

/**
 * The role's operating footer: blocked-on notices, resolved verification
 * commands, domain failure modes, the stuck rule, boundary, evidence rule,
 * stack discipline, memory access and withheld capabilities.
 *
 * Extracted so `se hire` and the file renderer cannot diverge. They did once:
 * the hire payload was assembled from `renderRoleInstructions` alone and
 * silently shipped without failure modes or verification commands -- a role
 * that looked hired and carried none of the knowledge it was given.
 */
export function buildRoleFooter(
  role: Role,
  root: string,
  effectiveTools: readonly string[],
  genuinelyUnmapped: readonly string[],
  /**
   * Facts for the project being worked in. Omitted by the file renderer, which
   * renders into the project it was run from; supplied by `se hire`, where the
   * catalogue and the target project are different directories.
   */
  factsOverride?: ProjectFacts,
): string[] {
  const footer: string[] = ["", "---", ""];

  if (role.blocked_on.length > 0) {
    footer.push(
      `**Not yet available.** This role depends on ${role.blocked_on.join(", ")},`,
      "which is not implemented. Do not run those commands and do not treat their",
      "absence as a failure of the code you are working on. Where a check cannot",
      "run, report the work as completed with that check named as unverified.",
      "Never report it as verified.",
      "",
    );
  }

  if (role.verify_commands.length > 0) {
    /*
     * A placeholder is resolved here, against committed project metadata, if it
     * can be. 131 roles shipped `<project test command>` while package.json had
     * said the answer all along, so every one of them spent tool calls
     * rediscovering a constant -- and the ones that guessed reported a check
     * they never ran. Unresolvable placeholders are left visible with the
     * standing instruction to ask, which is cheap; a guess is not.
     */
    const facts = factsOverride ?? projectFacts(root);
    const resolved = role.verify_commands.map((c) => resolveCommand(c, facts));
    /*
     * Only a *project-command* placeholder is unresolved. A parameter
     * placeholder like `adb shell am kill <applicationId>` is the command's own
     * argument and is meant to stay: warning about it trains the reader to
     * ignore the warning, and the next genuinely missing command goes unnoticed.
     */
    const anyUnresolved = resolved.some((r) => /<(?:project-native|project)\s/.test(r));
    /*
     * Which of these can actually run here? A command naming an uninstalled
     * tool is the same defect as an unresolved placeholder: the role is handed a
     * gate it cannot execute, and then either reports a check it never ran or
     * drops it silently. Measured: eleven security roles name `semgrep` and
     * `gitleaks`, and neither was installed on the machine that rendered them.
     */
    const missing = new Set(resolved.filter((c) => !commandAvailable(c)));
    footer.push(
      "**Verification.** Record command + exit code for each:",
      "",
      ...resolved.map((c) => (missing.has(c) ? `- \`${c}\`  -- NOT INSTALLED here` : `- \`${c}\``)),
      "",
    );
    if (missing.size > 0) {
      footer.push(
        "A command marked NOT INSTALLED cannot run on this machine. Install it, or",
        "record that check as unverified by name. Do not substitute a different",
        "tool, and do not report the check as passed.",
        "",
      );
    }
    if (anyUnresolved) {
      footer.push(
        "Angle-bracket placeholders were not resolvable from the manifest: ask,",
        "do not guess, and never report a check you did not run.",
        "",
      );
    }
  }

  /*
   * Domain failure modes: the durable half of engineering knowledge.
   *
   * Framework APIs are deliberately absent from role definitions and read from
   * the lockfile at the moment of use (se/engineering/stack-discipline.md),
   * because a recalled signature is the largest source of confidently wrong
   * code. Failure modes are the opposite kind of fact: an N+1 query and a
   * session-fixation bug are still defects in five years, so they are written
   * down once and carried by the role that owns the area.
   */
  if (role.failure_modes.length > 0) {
    footer.push(
      "**Failure modes here** (defect -- guard). Check before reporting done.",
      "",
      ...role.failure_modes.map((f) => `- ${f.mode} -- ${f.guard}`),
      "",
    );
  }

  if (role.escalates_on_failure_to) {
    footer.push(
      `**Stuck after 2 attempts at one root cause: stop.** Hand to \`${role.escalates_on_failure_to}\`:`,
      "failing command + full output, what you tried and observed each time, last",
      "working state, suspected cause stated falsifiably. You get a diagnosis back",
      "and finish it yourself.",
      "",
    );
  }
  if (role.boundary) {
    footer.push(`**Boundary.** ${role.boundary}`, "");
  }
  if (role.requires_evidence) {
    footer.push(
      "**Evidence rule.** No `verified` without a recorded command and exit code.",
      "Checks that could not run are listed as unverified. Confidence is not evidence.",
      "",
    );
  }
  if (role.writes_files) {
    const ladder = minimalSolutionDiscipline(root);
    if (ladder) footer.push(ladder, "");
  }
  if (role.stack_aware) {
    const discipline = stackDiscipline(root);
    if (discipline) footer.push(discipline, "");
  }

  /*
   * Internal capabilities are served by the SE MCP server (`se` in mcpServers),
   * not by a host tool. The MCP tools are available to any role regardless of
   * whether it has a shell, so the access path is always the same.
   */
  const memoryCapabilities = role.tools.filter((t) => t === "memory-read" || t === "memory-write");
  if (memoryCapabilities.length > 0) {
    const canWrite = memoryCapabilities.includes("memory-write");
    footer.push(
      "**Project memory** (via SE MCP — `se` server, always available).",
      "Read before touching source: a record is hundreds of tokens, the files it",
      "summarises are thousands.",
      "",
      "- `se_memory_read({query?, scope?})` — newest-first, up to 20 records",
      "- `se_memory_read({query: \"<keyword>\"})` — filter by topic",
      "",
      "A record marked `stale` means its source changed: the live source wins.",
      "Never treat a stale summary as current.",
      "",
    );
    if (canWrite) {
      footer.push(
        `You may write **${role.memory_scopes.write.join(", ")}** scope:`,
        "",
        "- `se_memory_write({summary, owner, scope})` — session scope, no evidence needed",
        "- `se_memory_write({summary, owner, scope:\"project\", evidence_cmd, evidence_exit})` — project scope",
        "",
        "`accepted: false` means nothing was stored — read the `message` field.",
        "Never retry blindly; fix the reason first.",
        "",
      );
    }
  }

  if (role.tools.includes("escalate")) {
    footer.push(
      "**Two-attempt rule** (via SE MCP). After 2 failed attempts on the same",
      "root cause, escalate — do not keep trying:",
      "",
      "1. `se_attempt_inc({task_id, cause_id})` — increments counter; returns `{count, escalate}`",
      "2. When `escalate: true` → `se_escalate({task_id, reason, from_role})` and stop",
      "",
      "A cause_id is a short slug for the root cause, e.g. `missing-idempotency-key`.",
      "",
    );
  }

  if (role.tools.includes("task-graph")) {
    footer.push(
      "**Task graph** (via SE MCP). Track work atomically:",
      "",
      "- `se_task_create({owner, objective, criteria})` — returns `{task_id}`",
      "- `se_task_update({task_id, status, evidence_cmd?, evidence_exit?})` — statuses: queued|running|blocked|completed|escalated|cancelled",
      "- `se_task_get({task_id})` — full task with evidence history",
      "",
    );
  }

  if (genuinelyUnmapped.length > 0) {
    footer.push(
      `**Unavailable capabilities.** This role declares ${genuinelyUnmapped.join(", ")},`,
      "which this host cannot provide. Work that needs them must be escalated,",
      "not approximated.",
      "",
    );
  }

  return footer;
}

function renderRole(role: Role, root: string): { file: RenderedFile; unmapped: string[]; descriptionTokens: number } {
  const { tools, unmapped } = mapCapabilities(role, CAPABILITIES);
  const genuinelyUnmapped = unmapped.filter((c) => !INTERNAL_CAPABILITIES.has(c));
  // Claude Code loads every subagent description into every session. A compact
  // 180-character routes let all 191 active roles remain selectable without
  // loading their full bodies. The complete active roster fits under the 9k
  // project budget; the 30 deferred hardware roles are not emitted.
  const description = routingDescription(role, 180);

  const fm: string[] = [
    "---",
    `name: ${role.id}`,
    `description: ${yamlString(description)}`,
  ];

  /*
   * A role that declares no file writing must not receive Write or Edit.
   * This turns a prose constraint in the role definition into something the
   * host enforces -- the Chief Orchestrator physically cannot edit code.
   *
   * This filter is the enforcement. Mapping capabilities alone is not: a role
   * may declare the `write-files` capability and `writes_files: false`, and
   * that combination previously rendered Write and Edit while *also* skipping
   * `isolation: worktree` -- write tools with no isolated workspace, which is
   * strictly worse than either alone. `validate` now rejects the contradiction
   * at its source; this keeps the renderer safe even if a role slips through.
   */
  const effectiveTools = role.writes_files ? tools : tools.filter((t) => !WRITE_TOOLS.has(t));
  if (effectiveTools.length > 0) fm.push(`tools: ${effectiveTools.join(", ")}`);

  // max_calls is a budget in the specification; maxTurns is the host's
  // enforcement point for it.
  fm.push(`maxTurns: ${role.max_calls}`);

  // Part XV 53: every agent that writes files gets its own workspace, or
  // parallel writers corrupt each other with no error anywhere. Claude Code
  // provides this declaratively, so the requirement is satisfied by the host
  // rather than reimplemented.
  if (role.writes_files) fm.push("isolation: worktree");

  // Cross-session learning, scoped to the project, for roles that the
  // specification already permits to write project memory.
  if (role.memory_scopes.write.includes("project")) fm.push("memory: project");

  const color = DEPARTMENT_COLOR[role.department];
  if (color) fm.push(`color: ${color}`);

  fm.push("---", "");

  const header = [
    `<!-- GENERATED from ${role.file} by \`se render --host claude-code\`.`,
    `     Do not edit here; edits are overwritten. Role hash: ${role.hash} -->`,
    "",
  ];

  const footer = buildRoleFooter(role, root, effectiveTools, genuinelyUnmapped);

  return {
    file: {
      path: `${role.id}.md`,
      contents: [...fm, ...header, renderRoleInstructions(role.body), ...footer].join("\n"),
    },
    unmapped: genuinelyUnmapped,
    descriptionTokens: estimateTokens(description),
  };
}

export const claudeCodeAdapter: HostAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  defaultOut: ".claude/agents",

  // Claude Code reads user-level subagents from ~/.claude/agents, which apply
  // in every project. Project-level definitions of the same name win.
  userOut: join(claudeConfigDir(), "agents"),

  // Claude Code provisions a git worktree per agent declaratively.
  providesWorkspaceIsolation: true,

  /**
   * Claude Code warns at startup once the combined descriptions of custom
   * subagents exceed 15,000 tokens, and the warning is the mild symptom: a
   * large subagent tree also slows session start and crowds out context that
   * the actual task needs.
   *
   * The 9,000-token budget leaves headroom below the host warning threshold.
   * Compact descriptions keep all 191 active roles under this project's
   * 9,000-token budget; deferred roles are not routable or rendered.
   */
  metadataTokenBudget: 9000,

  render(roles: readonly Role[], root = process.cwd()): RenderResult {
    const files: RenderedFile[] = [];
    const unmapped = new Map<string, readonly string[]>();
    let metadataTokens = 0;

    // Sorted for deterministic output: an unstable render churns the diff
    // and makes a real change invisible among reorderings.
    for (const role of [...roles].sort((a, b) => a.id.localeCompare(b.id))) {
      const rendered = renderRole(role, root);
      files.push(rendered.file);
      metadataTokens += rendered.descriptionTokens;
      if (rendered.unmapped.length > 0) unmapped.set(role.id, rendered.unmapped);
    }

    return { files, unmapped, metadataTokens };
  },
};

export const ADAPTERS: readonly HostAdapter[] = [
  agentSkillsAdapter,
  antigravityAdapter,
  claudeCodeAdapter,
  claudeSkillsAdapter,
  codexAdapter,
  copilotAdapter,
  cursorAdapter,
  geminiCliAdapter,
  opencodeAdapter,
  agentsMdAdapter,
];

export function findAdapter(id: string): HostAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
