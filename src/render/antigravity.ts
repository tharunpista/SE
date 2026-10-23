/** Native custom-agent renderer for Google Antigravity (IDE and CLI). */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, routingDescription, stripEvalOnlySections } from "./host.ts";

const TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  "read-files": ["view_file"],
  search: ["grep_search", "find_by_name"],
  "write-files": ["replace_file_content"],
  "run-shell": ["run_command"],
  "run-tests": ["run_command"],
  "invoke-agent": ["invoke_subagent"],
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderAgent(role: Role): RenderedFile {
  const tools = new Set<string>();
  for (const capability of role.tools) {
    if (role.writes_files === false && capability === "write-files") continue;
    for (const tool of TOOL_MAP[capability] ?? []) tools.add(tool);
  }

  // Do not grant a shell to a non-writer: Antigravity's run_command is not
  // read-only. Its sandbox is a host safety policy, not role-level isolation.
  if (role.writes_files === false) tools.delete("run_command");

  const frontmatter = [
    "---",
    `name: ${role.id}`,
    `description: ${yamlString(routingDescription(role))}`,
    "subagent: true",
    "mainAgent: true",
    "model: inherit",
    "commandExecutionPolicy: sandbox",
    ...(tools.size > 0 ? ["tools:", ...[...tools].sort().map((tool) => `  - ${tool}`)] : []),
    "---",
    "",
  ];

  const body = [
    `<!-- GENERATED from se/agents/ by se render --host antigravity. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "Use only the tools listed in this agent definition. A command tool is available only to roles that can write files; the sandbox is still controlled by the host.",
    "Do not claim a capability or verification step that the host does not provide.",
    "",
    stripEvalOnlySections(role.body),
    "",
  ].join("\n");

  return { path: `${role.id}.md`, contents: [...frontmatter, body].join("\n") };
}

export const antigravityAdapter: HostAdapter = {
  id: "antigravity",
  displayName: "Google Antigravity custom agents",
  defaultOut: ".agents/agents",
  userOut: join(homedir(), ".gemini", "config", "agents"),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const files = [...roles].sort((a, b) => a.id.localeCompare(b.id)).map(renderAgent);
    const unmapped = new Map<string, readonly string[]>(
      roles.map((role) => [
        role.id,
        role.tools.filter((capability) => TOOL_MAP[capability] === undefined),
      ] as const).filter(([, capabilities]) => capabilities.length > 0),
    );
    return {
      files,
      unmapped,
      metadataTokens: estimateTokens(files.map((file) => file.contents).join("\n")),
    };
  },
};
