/** Native custom-subagent renderer for Codex CLI and the Codex IDE clients. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Role } from "../roles/types.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, renderRoleInstructions, routingDescription } from "./host.ts";

function renderAgent(role: Role): RenderedFile {
  const instructions = [
    `# ${role.name}`,
    "",
    `Role id: ${role.id}`,
    `Department: ${role.department}`,
    `Declared capabilities: ${role.tools.join(", ") || "none"}`,
    "",
    "This host inherits the parent session's tools, model provider, permissions, and sandbox.",
    "The role's capability list is guidance; this file cannot enforce per-role tool restrictions.",
    "Do not claim a capability or verification step that the parent session does not provide.",
    "",
    renderRoleInstructions(role.body),
  ].join("\n");

  // JSON string literals are valid TOML basic strings and preserve arbitrary
  // Markdown, including quotes and triple-quote sequences, without TOML injection.
  const contents = [
    `# GENERATED from se/agents/ by se render --host codex. Role hash: ${role.hash}`,
    `name = ${JSON.stringify(role.id)}`,
    `description = ${JSON.stringify(routingDescription(role))}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
  ].join("\n");

  return { path: `${role.id}.toml`, contents };
}

export const codexAdapter: HostAdapter = {
  id: "codex",
  displayName: "Codex custom subagents",
  defaultOut: ".codex/agents",
  // Codex CLI and IDE share CODEX_HOME when a user selects a custom profile.
  userOut: join(process.env["CODEX_HOME"] ? resolve(process.env["CODEX_HOME"]!) : join(homedir(), ".codex"), "agents"),
  providesWorkspaceIsolation: false,
  metadataTokenBudget: null,

  render(roles: readonly Role[]): RenderResult {
    const files = roles.map(renderAgent);
    return {
      files,
      // Codex agents inherit the parent session's tools. Role capabilities
      // cannot be mapped to a per-agent allowlist here, but they are not
      // unavailable tools; the generated instructions state this limitation.
      unmapped: new Map(),
      metadataTokens: estimateTokens(files.map((f) => f.contents).join("\n")),
    };
  },
};
