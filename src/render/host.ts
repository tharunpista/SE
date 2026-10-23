import type { Role } from "../roles/types.ts";

export interface RenderedFile {
  /** Path relative to the output root, forward-slashed. */
  readonly path: string;
  readonly contents: string;
}

export interface RenderResult {
  readonly files: readonly RenderedFile[];
  /** Capabilities a role declared that this host cannot provide. Never silent. */
  readonly unmapped: ReadonlyMap<string, readonly string[]>;
  /** Estimated tokens this host spends on always-loaded metadata. */
  readonly metadataTokens: number;
}

export interface HostAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Default output root, relative to the repo. */
  readonly defaultOut: string;
  /**
   * Hard ceiling on always-loaded metadata tokens, or null when the host has
   * none. Exceeding it is a refusal, not a warning: the whole point of a
   * 220-role catalogue is that only the active roster is ever loaded.
   */
  readonly metadataTokenBudget: number | null;
  render(roles: readonly Role[], root?: string): RenderResult;
}

/**
 * Abstract capability -> concrete host tool.
 *
 * Role files declare capabilities, not host tool names, because the same role
 * must render for several hosts whose tool names differ and change. The
 * indirection is the only reason a role file written today still renders
 * correctly after a host renames a tool.
 */
export type CapabilityMap = Readonly<Record<string, readonly string[]>>;

/**
 * Token estimate. Deliberately a cheap approximation (~4 chars/token) rather
 * than a real tokenizer: the budget check needs to be conservative and
 * dependency-free, and being within ~15% is enough to keep a roster far away
 * from a host's ceiling. The estimate is rounded up, never down.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a host `description` from the role.
 *
 * This field is always loaded, for every rendered role, so it is the single
 * most expensive text in the system. It is written for delegation routing --
 * "use this when X" -- not as a summary for a human; the human-facing
 * definition is the body, which loads only when the role actually runs.
 */
export function routingDescription(role: Role, maxChars = 320): string {
  const trigger = role.activation
    .filter((a) => !/^always$/i.test(a.trim()))
    .slice(0, 2)
    .join("; ");

  // First sentence of the mission carries the responsibility.
  const firstSentence = role.mission.split(/(?<=\.)\s/)[0] ?? role.mission;
  const parts = [firstSentence.trim()];
  if (trigger) parts.push(`Use for: ${trigger}.`);

  let out = parts.join(" ").replace(/\s+/g, " ").trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1).replace(/[\s,;:.]+\S*$/, "")}…`;
  }
  return out;
}

/** Resolve declared capabilities to host tools, reporting what did not map. */
export function mapCapabilities(
  role: Role,
  map: CapabilityMap,
): { tools: string[]; unmapped: string[] } {
  const tools = new Set<string>();
  const unmapped: string[] = [];

  for (const capability of role.tools) {
    const mapped = map[capability];
    if (mapped === undefined) {
      unmapped.push(capability);
      continue;
    }
    for (const t of mapped) tools.add(t);
  }

  return { tools: [...tools].sort(), unmapped };
}
