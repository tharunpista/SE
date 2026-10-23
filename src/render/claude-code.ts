import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../roles/types.ts";
import type { CapabilityMap, HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, mapCapabilities, routingDescription, stripEvalOnlySections } from "./host.ts";
import { agentsMdAdapter } from "./agents-md.ts";
import { agentSkillsAdapter, claudeConfigDir, claudeSkillsAdapter } from "./agent-skills.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { codexAdapter } from "./codex.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorAdapter } from "./cursor.ts";
import { geminiCliAdapter } from "./gemini-cli.ts";
import { opencodeAdapter } from "./opencode.ts";

/**
 * Capability -> Claude Code tool names.
 *
 * Capabilities with no entry here are deliberately absent rather than
 * approximated. `memory-read`, `memory-write`, `escalate` and `task-graph`
 * are served by this project's own layer, not by a host tool; rendering them
 * as `Bash` would hand a role a shell it was never granted.
 */
const CAPABILITIES: CapabilityMap = {
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
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit"]);

/** Capabilities this project serves itself; absence from the host is correct. */
const INTERNAL_CAPABILITIES = new Set([
  "memory-read", "memory-write", "escalate", "task-graph",
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
function stackDiscipline(root: string): string | null {
  if (stackDisciplineCache !== undefined) return stackDisciplineCache;
  const path = join(root, "se", "engineering", "stack-discipline.md");
  stackDisciplineCache = existsSync(path)
    ? readFileSync(path, "utf8").replace(/^#\s+/m, "## ").trim()
    : null;
  return stackDisciplineCache;
}

function renderRole(role: Role, root: string): { file: RenderedFile; unmapped: string[]; descriptionTokens: number } {
  const { tools, unmapped } = mapCapabilities(role, CAPABILITIES);
  const genuinelyUnmapped = unmapped.filter((c) => !INTERNAL_CAPABILITIES.has(c));
  const description = routingDescription(role);

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
    footer.push(
      "**Verification.** Record the command and its exit code for each check:",
      "",
      ...role.verify_commands.map((c) => `- \`${c}\``),
      "",
      "A placeholder in angle brackets means the project supplies the real",
      "command. Find it in the project manifest or scripts; if it is not there,",
      "ask rather than guessing, and never report a check you did not run.",
      "",
    );
  }

  if (role.escalates_on_failure_to) {
    footer.push(
      `**When stuck.** After **two** failed attempts at the same root cause, stop.`,
      `Do not attempt a third. Hand over to \`${role.escalates_on_failure_to}\` with:`,
      "the exact failing command and its full output; what you attempted and what",
      "you observed after each attempt; the last known working state; and your",
      "suspected cause stated so it can be falsified. Two failed fixes mean the",
      "model of the problem is wrong, and a third attempt from the same model is a",
      "coin flip. You will get a diagnosis back and finish the work yourself.",
      "",
    );
  }
  if (role.boundary) {
    footer.push(`**Boundary.** ${role.boundary}`, "");
  }
  if (role.requires_evidence) {
    footer.push(
      "**Evidence rule.** You may not report work as verified without recorded",
      "evidence carrying an exit code. If the required checks could not run, say",
      "so explicitly and list what remains unverified. Your confidence is not",
      "evidence.",
      "",
    );
  }
  if (role.stack_aware) {
    const discipline = stackDiscipline(root);
    if (discipline) footer.push(discipline, "");
  }

  /*
   * `memory-read` and `memory-write` are served by this project, not by a host
   * tool, so they map to nothing in CAPABILITIES. Mapping them to `Bash` would
   * hand a role a shell it never declared. But a capability that resolves to
   * nothing and is never mentioned is indistinguishable, from inside the agent,
   * from having no memory at all -- which is how a role ends up re-reading
   * source it has already summarised.
   *
   * So the access path is stated explicitly, and stated honestly: the layer is
   * reached through the CLI, which needs a shell. A role that declares memory
   * capabilities without one cannot reach memory on this host, and is told so
   * rather than left to discover it.
   */
  const memoryCapabilities = role.tools.filter((t) => t === "memory-read" || t === "memory-write");
  if (memoryCapabilities.length > 0) {
    const canWrite = memoryCapabilities.includes("memory-write");
    if (effectiveTools.includes("Bash")) {
      footer.push(
        "**Project memory.** Read it *before* reading source: a record is a few",
        "hundred tokens, the files it summarises are thousands. Memory is reached",
        "through the CLI, and the project is resolved automatically.",
        "",
        "- `se memory status` --- which project, which generation",
        "- `se memory list` --- live records with status and revision",
        "- `se memory get <record-id>` --- one record, with the freshness of each source",
        "",
        "A record marked `stale` describes source that has since changed: the live",
        "source wins, always. Never treat a summary as current without checking it.",
        "",
      );
      if (canWrite) {
        footer.push(
          `You may write ${role.memory_scopes.write.join(", ")} scope. Writes go through`,
          "`se memory put --file <json>` and are **refused** unless the phase, scope,",
          "evidence and expected revision all check out. A refusal returns your content",
          "with a named reason; it is never a silent loss, and never a reason to retry",
          "blindly. `accepted: false` means nothing was stored.",
          "",
        );
      }
    } else {
      footer.push(
        `**Project memory is unreachable for you.** You declare ${memoryCapabilities.join(", ")},`,
        "but this host serves memory through the `se memory` CLI and you have no",
        "shell. Do not pretend to remember across sessions, and do not claim a",
        "record was written. Hand work that needs memory to a role that can reach",
        "it, or ask the operator to run the command.",
        "",
      );
    }
  }

  if (genuinelyUnmapped.length > 0) {
    footer.push(
      `**Unavailable capabilities.** This role declares ${genuinelyUnmapped.join(", ")},`,
      "which this host cannot provide. Work that needs them must be escalated,",
      "not approximated.",
      "",
    );
  }

  return {
    file: {
      path: `${role.id}.md`,
      contents: [...fm, ...header, stripEvalOnlySections(role.body), ...footer].join("\n"),
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
   * The budget here is deliberately well below that ceiling. A 220-role
   * catalogue rendered whole would blow through it, which is precisely why
   * roster selection exists -- only the active roster is ever rendered.
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
