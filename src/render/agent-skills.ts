/** Portable Agent Skills views of the role catalogue. */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Role } from "../roles/types.ts";
import { departmentLabel } from "../roles/vocabulary.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, renderRoleInstructions, routingDescription } from "./host.ts";

function renderSkill(role: Role): RenderedFile {
  const contents = [
    "---",
    `name: ${role.id}`,
    `description: ${JSON.stringify(routingDescription(role))}`,
    "---",
    "",
    `<!-- GENERATED from se/agents/ by se render. Role hash: ${role.hash} -->`,
    `# ${role.name}`,
    "",
    `Section: ${departmentLabel(role.department)}`,
    "",
    "This skill provides the role's specialist instructions in the current agent's context.",
    "It does not create an isolated subagent, enforce tool permissions, or provide a separate workspace.",
    "Use the host's native custom-agent integration when delegated execution or tool restrictions are required.",
    "",
    renderRoleInstructions(role.body),
    "",
  ].join("\n");
  return { path: `${role.id}/SKILL.md`, contents };
}

/** Claude Code's global config root can be changed per environment/profile. */
export function claudeConfigDir(): string {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

function skillAdapter(id: string, displayName: string, projectPath: string, userPath: string): HostAdapter {
  return {
    id,
    displayName,
    defaultOut: projectPath,
    userOut: isAbsolute(userPath) ? userPath : join(homedir(), userPath),
    providesWorkspaceIsolation: false,
    metadataTokenBudget: null,
    render(roles: readonly Role[]): RenderResult {
      const files = [...roles].sort((a, b) => a.id.localeCompare(b.id)).map(renderSkill);
      return {
        files,
        // Skills add instructions, not tools; the invoking host determines access.
        unmapped: new Map(),
        // Skill hosts discover only the name and description. The instruction
        // bodies are read only when a skill is invoked, so charging full file
        // sizes as always-loaded metadata would be misleading.
        metadataTokens: estimateTokens(roles.map(routingDescription).join("\n")),
      };
    },
  };
}

/** Shared project/global path supported by several coding-agent clients. */
export const agentSkillsAdapter = skillAdapter(
  "agent-skills", "Portable Agent Skills", ".agents/skills", join(".agents", "skills"),
);

/** Claude Code has a separate documented project/global skill directory. */
export const claudeSkillsAdapter = skillAdapter(
  "claude-skills", "Claude Code Agent Skills", ".claude/skills", join(claudeConfigDir(), "skills"),
);
