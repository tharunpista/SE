/**
 * The `AGENTS.md` convention: one instruction file, read by Codex, Copilot CLI,
 * Gemini CLI, Jules and others.
 *
 * This host is structurally different from Claude Code and the difference
 * matters more than the file format. Claude Code loads each role as a separate,
 * selectable subagent and routes to one by its description. A host that reads a
 * single instruction file has no selector: everything in the file is in context
 * for every request, all at once.
 *
 * Emitting 152 full role definitions into one file would therefore be actively
 * harmful -- it would load every specialist's instructions simultaneously, which
 * is both enormous and contradictory, since roles are written to disagree with
 * each other about scope on purpose.
 *
 * So this adapter emits a **routing index**, not a roster: who owns what, the
 * boundary that keeps them apart, and where the full definition lives. The
 * agent reads one role file when it needs one. That is the same
 * retrieval-before-reading discipline the memory layer applies to source.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens } from "./host.ts";

/** One line per role: enough to choose, not enough to act. */
function indexRow(role: Role): string {
  const mission = role.mission.replace(/\s+/g, " ").trim();
  const shortened = mission.length > 160 ? `${mission.slice(0, 157).trimEnd()}...` : mission;
  return `| \`${role.id}\` | ${role.department} | ${shortened} |`;
}

function renderIndex(roles: readonly Role[]): string {
  const byDepartment = new Map<string, Role[]>();
  for (const role of roles) {
    const list = byDepartment.get(role.department) ?? [];
    list.push(role);
    byDepartment.set(role.department, list);
  }

  const lines: string[] = [
    "<!-- GENERATED from se/agents/ by se render --host agents-md. Do not edit here; edits are overwritten. -->",
    "",
    "# Engineering roles",
    "",
    `This project defines ${roles.length} specialist roles. Each one has an owner, a`,
    "boundary, and a definition of done, and they are written to disagree about",
    "scope deliberately so that work lands with whoever is accountable for it.",
    "",
    "The full definitions live in the role catalogue, which is not necessarily",
    "inside this repository, so read them through the `se` command rather than by",
    "path. If `se` is not on PATH, ask the operator to run `se link` once.",
    "",
    "## How to use this file",
    "",
    "Do not adopt every role at once; they contradict each other by design.",
    "",
    "1. Identify which role owns the work from the table below.",
    "2. Read that one role in full: `se role <id>`.",
    "3. Follow it, including its non-responsibilities. Work outside your role's",
    "   boundary is handed over, not absorbed.",
    "4. Record evidence for every check you claim: a command and its exit code.",
    "   Your confidence is not evidence.",
    "",
    "If no role clearly owns the work, say so rather than picking the nearest one.",
    "A misrouted task is harder to recover than an unrouted one.",
    "",
    "**This file grants no tools.** Role definitions list the capabilities a role",
    "*needs*; what you actually have is whatever this host already permits. Where",
    "a role requires a capability you do not have, say so and hand the work over.",
    "Do not approximate it, and do not report a check you could not run.",
    "",
    "## Roles",
    "",
  ];

  for (const department of [...byDepartment.keys()].sort()) {
    const list = byDepartment.get(department)!.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    lines.push(`### ${department}`, "", "| role | department | mission |", "|---|---|---|");
    for (const role of list) lines.push(indexRow(role));
    lines.push("");
  }

  lines.push(
    "## Project memory",
    "",
    "Read memory before reading source: a record is a few hundred tokens, the",
    "files it summarises are thousands.",
    "",
    "```",
    "se memory status            # which project, which generation",
    "se memory list             # live records",
    "se memory get <record-id>  # one record, with the freshness of each source",
    "```",
    "",
    "A record marked `stale` describes source that has since changed. The live",
    "source wins, always. A write is only stored if the command reports",
    "`accepted`; a refusal returns the content with a named reason, and is never",
    "a reason to retry blindly.",
    "",
  );

  return lines.join("\n");
}

export const agentsMdAdapter: HostAdapter = {
  id: "agents-md",
  displayName: "AGENTS.md routing index (Codex, Copilot, Gemini CLI, OpenCode)",
  defaultOut: ".",

  /*
   * Deliberately null. There is no agreed user-level AGENTS.md location across
   * the tools that read it, and writing one to the home directory would apply
   * these instructions to every unrelated project on the machine. A guess here
   * would be silently wrong, which is the failure this project exists to avoid.
   */
  userOut: null,

  /*
   * An instruction file provisions nothing. A role marked as a file writer gets
   * no workspace here, so parallel writers are a real hazard on this host and
   * the render output must not suggest otherwise.
   */
  providesWorkspaceIsolation: false,

  /*
   * No budget, because the cost is not a roster of descriptions: it is one file
   * whose size is reported so the operator can see it. The index is a few
   * thousand tokens for the whole catalogue, against roughly ten thousand for
   * Claude Code's 152 always-loaded descriptions -- the saving comes from
   * emitting one line per role instead of a full definition.
   */
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const contents = renderIndex(roles);
    const file: RenderedFile = { path: "AGENTS.md", contents };

    /*
     * Empty, and not because nothing is unmapped: an instruction file grants no
     * tools at all, so strictly every capability is unavailable here. Reporting
     * that per role would print the same fact 152 times and bury the render
     * output, so the generated file states it once, to the agent that reads it
     * -- which is who needs to know.
     */
    return { files: [file], unmapped: new Map(), metadataTokens: estimateTokens(contents) };
  },
};

/** Where Claude Code's user-level agents live, for messaging in the CLI. */
export const CLAUDE_USER_AGENTS = join(homedir(), ".claude", "agents");
