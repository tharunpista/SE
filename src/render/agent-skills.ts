/** Portable Agent Skills views of the role catalogue. */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Role } from "../roles/types.ts";
import { departmentLabel } from "../roles/vocabulary.ts";
import type { HostAdapter, RenderResult, RenderedFile } from "./host.ts";
import { estimateTokens, renderRoleInstructions, routingDescription } from "./host.ts";
import { renderRouterSkill, renderTopicSkills } from "./router.ts";

/**
 * `when_to_use` is a routing field the host folds into the skill's tool
 * description, and `activation` is already the catalogue's answer to the same
 * question: the project facts under which this role applies. Deriving one from
 * the other keeps a single reviewed source rather than inventing a second,
 * which would drift the moment either was edited.
 *
 * `paths` is deliberately not emitted. It *restricts* a skill to files matching
 * a glob, so a wrong or over-narrow pattern makes a role unreachable while the
 * operator is working anywhere else -- a silent loss of a specialist, which is
 * the failure mode this project exists to avoid. It belongs in role frontmatter,
 * per role, reviewed, not guessed per department by a renderer.
 */
function whenToUse(role: Role): string | null {
  const facts = role.activation.map((a) => a.trim()).filter((a) => a.length > 0 && a !== "always");
  if (facts.length === 0) return null;
  return `Use when: ${facts.join("; ")}.`;
}

function renderSkill(role: Role): RenderedFile {
  const when = whenToUse(role);
  const contents = [
    "---",
    `name: ${role.id}`,
    `description: ${JSON.stringify(routingDescription(role))}`,
    ...(when === null ? [] : [`when_to_use: ${JSON.stringify(when)}`]),
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

      /*
       * The router is emitted alongside the roles, from the same roster, so its
       * routing table and ownership index can never describe a roster other
       * than the one actually installed. It returns null when the roster has no
       * role that owns scoping, because a router naming a receiver the host has
       * not installed would report work as routed when it was not.
       */
      const router = renderRouterSkill(roles);
      if (router) files.push(router);

      /*
       * Topic skills: one per group of roles that share a job, carrying the
       * words an operator types. A department is where a role reports; a topic
       * is what someone asks about, and only the latter is reachable from a
       * keyword.
       */
      files.push(...renderTopicSkills(roles));

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
