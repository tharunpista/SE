/** Native project subagent renderer for OpenCode. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, routingDescription, stripEvalOnlySections } from "./host.ts";

function renderAgent(role: Role): RenderedFile {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(routingDescription(role))}`,
    "mode: subagent",
    ...(role.writes_files ? ["permission:", '  edit: "ask"', '  shell: "ask"'] : ["permission:", '  edit: "deny"', '  shell: "ask"']),
    "---",
    "",
  ];
  const body = [
    `<!-- GENERATED from se/agents/ by se render --host opencode. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Role id: ${role.id}`,
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "OpenCode permissions and the active session control actual tool access. The capability list is guidance; do not claim unavailable tools or verification.",
    "",
    stripEvalOnlySections(role.body),
    "",
  ].join("\n");
  return { path: `${role.id}.md`, contents: [...frontmatter, body].join("\n") };
}

export const opencodeAdapter: HostAdapter = {
  id: "opencode",
  displayName: "OpenCode subagents",
  defaultOut: ".opencode/agents",
  // OPENCODE_CONFIG_DIR replaces the config base. Otherwise honor XDG_CONFIG_HOME.
  userOut: join(
    process.env["OPENCODE_CONFIG_DIR"]
      ? resolve(process.env["OPENCODE_CONFIG_DIR"]!)
      : join(process.env["XDG_CONFIG_HOME"] ? resolve(process.env["XDG_CONFIG_HOME"]!) : join(homedir(), ".config"), "opencode"),
    "agents",
  ),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const files = [...roles].sort((a, b) => a.id.localeCompare(b.id)).map(renderAgent);
    const unmapped = new Map<string, readonly string[]>(
      roles.filter((role) => role.tools.length > 0).map((role) => [role.id, role.tools] as const),
    );
    return { files, unmapped, metadataTokens: estimateTokens(files.map((file) => file.contents).join("\n")) };
  },
};
