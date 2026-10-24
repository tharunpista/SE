/** Workspace custom-agent renderer for VS Code's Copilot and Local harnesses. */

import type { Role } from "../roles/types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, renderRoleInstructions, routingDescription } from "./host.ts";

const TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  "read-files": ["read"],
  search: ["search"],
  "write-files": ["edit"],
  "run-shell": ["execute"],
  "run-tests": ["execute"],
  "invoke-agent": ["agent"],
  "web-fetch": ["web"],
  "web-search": ["web"],
  "track-todos": ["todo"],
};

const INTERNAL_CAPABILITIES = new Set(["memory-read", "memory-write", "escalate", "task-graph"]);

function renderAgent(role: Role): RenderedFile {
  const tools = new Set<string>();
  for (const capability of role.tools) {
    const mapped = TOOL_MAP[capability];
    if (!mapped) continue;
    if (role.writes_files === false && capability === "write-files") continue;
    for (const tool of mapped) tools.add(tool);
  }

  // A read-only profile must not receive command execution: shells can write
  // files even when the role's prose says not to.
  if (!role.writes_files) {
    tools.delete("edit");
    tools.delete("runCommands");
    tools.delete("runTests");
  }

  const header = [
    "---",
    `name: ${JSON.stringify(role.id)}`,
    `description: ${JSON.stringify(routingDescription(role))}`,
    ...(tools.size > 0 ? [`tools: ${JSON.stringify([...tools].sort())}`] : []),
    "user-invocable: true",
    "---",
    "",
  ];
  const body = [
    `<!-- GENERATED from se/agents/ by se render --host copilot. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Role id: ${role.id}`,
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "Capabilities are mapped only where the VS Code harness has a documented tool alias. The harness and session permissions remain authoritative; do not claim a capability the selected session does not provide.",
    "",
    renderRoleInstructions(role.body),
    "",
  ].join("\n");
  return { path: `${role.id}.agent.md`, contents: [...header, body].join("\n") };
}

export const copilotAdapter: HostAdapter = {
  id: "copilot",
  displayName: "VS Code Copilot custom agents",
  defaultOut: ".github/agents",
  // GitHub Copilot's user-level agent folder. VS Code's Local harness has
  // profile-based storage; this location is for the Copilot harness.
  userOut: join(homedir(), ".copilot", "agents"),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const files = [...roles].sort((a, b) => a.id.localeCompare(b.id)).map(renderAgent);
    const unmapped = new Map<string, readonly string[]>();
    for (const role of roles) {
      const missing = role.tools.filter((capability) =>
        TOOL_MAP[capability] === undefined && !INTERNAL_CAPABILITIES.has(capability));
      if (missing.length > 0) unmapped.set(role.id, missing);
    }
    return { files, unmapped, metadataTokens: estimateTokens(files.map((file) => file.contents).join("\n")) };
  },
};
