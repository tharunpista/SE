/** Native project/user subagent renderer for Cursor. */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, routingDescription, stripEvalOnlySections } from "./host.ts";

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function renderAgent(role: Role): RenderedFile {
  const frontmatter = [
    "---",
    `name: ${role.id}`,
    `description: ${quoteYaml(routingDescription(role))}`,
    "model: inherit",
    ...(!role.writes_files ? ["readonly: true"] : []),
    "---",
    "",
  ];
  const body = [
    `<!-- GENERATED from se/agents/ by se render --host cursor. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "This host does not enforce the role's declared tool list. The role inherits the tools and permissions available in the Cursor session.",
    "Do not claim a capability or verification step that the current session does not provide.",
    "",
    stripEvalOnlySections(role.body),
    "",
  ].join("\n");
  return { path: `${role.id}.md`, contents: [...frontmatter, body].join("\n") };
}

export const cursorAdapter: HostAdapter = {
  id: "cursor",
  displayName: "Cursor subagents",
  defaultOut: ".cursor/agents",
  userOut: join(homedir(), ".cursor", "agents"),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const files = roles.map(renderAgent);
    const unmapped = new Map<string, readonly string[]>(
      roles.filter((r) => r.tools.length > 0).map((r) => [r.id, r.tools] as const),
    );
    return {
      files,
      unmapped,
      metadataTokens: estimateTokens(files.map((f) => f.contents).join("\n")),
    };
  },
};
