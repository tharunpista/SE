/** Native local subagent renderer for Gemini CLI. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, renderRoleInstructions, routingDescription } from "./host.ts";

const TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  "read-files": ["read_file", "list_directory"],
  search: ["grep_search", "glob"],
  "write-files": ["write_file", "replace"],
  "run-shell": ["run_shell_command"],
  "run-tests": ["run_shell_command"],
};

function renderAgent(role: Role): { file: RenderedFile; unmapped: string[] } {
  const tools = new Set<string>();
  const unmapped: string[] = [];
  for (const capability of role.tools) {
    const mapped = TOOL_MAP[capability];
    if (!mapped) {
      unmapped.push(capability);
      continue;
    }
    if (!role.writes_files && (capability === "write-files" || capability === "run-shell" || capability === "run-tests")) {
      continue;
    }
    for (const tool of mapped) tools.add(tool);
  }

  const frontmatter = [
    "---",
    `name: ${JSON.stringify(role.id)}`,
    `description: ${JSON.stringify(routingDescription(role))}`,
    "kind: local",
    "model: inherit",
    `max_turns: ${role.max_calls}`,
    ...(tools.size > 0 ? ["tools:", ...[...tools].sort().map((tool) => `  - ${tool}`)] : []),
    "---",
    "",
  ];
  const body = [
    `<!-- GENERATED from se/agents/ by se render --host gemini-cli. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Role id: ${role.id}`,
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "The listed tools are the Gemini CLI tools mapped by this renderer. The parent session's policy remains authoritative. Do not claim a tool or verification step you did not use.",
    "",
    renderRoleInstructions(role.body),
    "",
  ].join("\n");
  return { file: { path: `${role.id}.md`, contents: [...frontmatter, body].join("\n") }, unmapped };
}

export const geminiCliAdapter: HostAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI subagents",
  defaultOut: ".gemini/agents",
  // GEMINI_CLI_HOME is the user's configuration root; .gemini is created below it.
  userOut: join(
    process.env["GEMINI_CLI_HOME"] ? resolve(process.env["GEMINI_CLI_HOME"]!) : homedir(),
    ".gemini", "agents",
  ),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const rendered = [...roles].sort((a, b) => a.id.localeCompare(b.id)).map(renderAgent);
    const unmapped = new Map<string, readonly string[]>(
      rendered.filter(({ unmapped: missing }) => missing.length > 0).map(({ file, unmapped: missing }) => [file.path.slice(0, -3), missing] as const),
    );
    const files = rendered.map(({ file }) => file);
    return { files, unmapped, metadataTokens: estimateTokens(files.map((file) => file.contents).join("\n")) };
  },
};
