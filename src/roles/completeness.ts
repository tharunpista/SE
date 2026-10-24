/**
 * Whether a role definition is finished, as opposed to merely present.
 *
 * The catalogue reached 191/191 software roles by count while 30 of them were
 * template fill: identical boilerplate sections, a `boundary` that named no
 * neighbour, and `verify_commands: ["<project-native verification command>"]`.
 * Every existing gate passed them. CI checked for a 40-word floor and the
 * absence of TODO markers, and a 260-word role that says nothing specific
 * clears both.
 *
 * So the bar is measured from the roles that are actually finished rather than
 * asserted: the 161 complete definitions carry nine sections and a 388-word
 * body at the thinnest, with a median of 642. A role below that is not a style
 * problem, it is a role that will not change what an agent does, which is the
 * only thing a role definition is for.
 *
 * QUARANTINE existed so this rule could be introduced before the backlog was
 * cleared. The backlog is now empty and every role is held to the rule as an
 * error. The list stays, empty, because the machinery around it -- a shrinking
 * register, an error when an entry is finished but not delisted -- is what any
 * future batch of unfinished roles should go through rather than being
 * exempted silently.
 */

import type { Diagnostics } from "../util/diagnostics.ts";

/**
 * The sections required, as concepts rather than as exact headings.
 *
 * Measured, not designed. The finished catalogue uses three legitimate
 * structural variants -- the dominant one, an earlier one that says
 * "Responsibilities" where the newer says "Working procedure", and three
 * starter roles on the numbered sixteen-section format -- so requiring literal
 * headings failed 35 roles that are complete. Each concept below is satisfied
 * by 161 of 161 finished roles under its accepted spellings; anything stricter
 * would be this rule asserting a house style rather than detecting an
 * unfinished role.
 *
 * These three are also the ones that carry the role's distinguishing content:
 * what it is for, what it refuses, and when it is done. A definition missing
 * any of them cannot route work or close it.
 */
export const REQUIRED_CONCEPTS: readonly { readonly name: string; readonly accepts: readonly string[] }[] = [
  { name: "Mission", accepts: ["mission"] },
  {
    name: "Non-responsibilities",
    accepts: ["non-responsibilities", "explicit non-responsibilities", "boundaries"],
  },
  { name: "Definition of done", accepts: ["definition of done"] },
];

/** Headings that only ever appeared in the bulk-generated batch. */
const TEMPLATE_SECTIONS = [
  "Role-specific operating procedure",
  "Evidence and boundaries",
  "Handoff and completion",
] as const;

/**
 * The thinnest finished role is 388 words. Rounded down to 380 so the floor is
 * a floor rather than a tie, and deliberately not set at the 642 median: a
 * genuinely narrow role should be allowed to be short, it just may not be
 * empty.
 */
export const MIN_BODY_WORDS = 380;

/** A boundary must name the neighbouring role it is not. This names nobody. */
const GENERIC_BOUNDARY = "Owns the scoped responsibility described in the mission";

const PLACEHOLDER_VERIFY = /<project-native verification command>/;

/**
 * Roles not yet held to the rule. Empty: all 191 software roles meet the bar.
 *
 * An entry here is a debt record, never an exemption. It is reported on every
 * run, the list may only shrink, and finishing a role without delisting it is
 * itself an error.
 */
export const QUARANTINE: readonly string[] = [];

const QUARANTINED = new Set(QUARANTINE);

export interface CompletenessInput {
  readonly id: string;
  readonly file: string;
  readonly body: string;
  readonly boundary?: string | undefined;
  readonly verifyCommands?: readonly string[] | undefined;
}

export interface CompletenessFinding {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

/** Section headings, numeric prefixes stripped and lower-cased for comparison. */
function headings(body: string): Set<string> {
  return new Set(
    [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) =>
      m[1]!.replace(/^\d+\.\s*/, "").trim().toLowerCase(),
    ),
  );
}

/** Body words, which is what a reader actually receives. */
export function bodyWordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

/**
 * Everything wrong with one role's completeness. Returned rather than reported
 * so the caller decides severity: quarantined roles are a warning with a
 * shrinking count, everything else is an error.
 */
export function completenessFindings(input: CompletenessInput): CompletenessFinding[] {
  const found: CompletenessFinding[] = [];
  const present = headings(input.body);

  for (const section of TEMPLATE_SECTIONS) {
    if (present.has(section.toLowerCase())) {
      found.push({
        code: "role/template-section",
        message: `Section "## ${section}" is boilerplate from the bulk-generated batch.`,
        hint:
          `Replace it with the structure the finished roles use: Mission, Activation, Working procedure, ` +
          `Rules that do not bend, Non-responsibilities, Outputs, Authority and escalation, Handoffs, Definition of done. ` +
          `The boilerplate is identical across every role that carries it, so it tells an agent nothing.`,
      });
    }
  }

  const missing = REQUIRED_CONCEPTS.filter((c) => !c.accepts.some((a) => present.has(a)));
  if (missing.length > 0) {
    found.push({
      code: "role/missing-sections",
      message: `Missing section(s): ${missing.map((m) => `## ${m.name}`).join(", ")}.`,
      hint:
        "Every finished role in the catalogue states its mission, what it refuses to absorb, and " +
        "when its work is done. Accepted alternatives: " +
        REQUIRED_CONCEPTS.map((c) => `${c.name} (${c.accepts.join(" | ")})`).join("; "),
    });
  }

  const words = bodyWordCount(input.body);
  if (words < MIN_BODY_WORDS) {
    found.push({
      code: "role/body-too-thin",
      message: `Body is ${words} words; the thinnest finished role is ${MIN_BODY_WORDS}.`,
      hint:
        "A role definition exists to change what an agent does. State the failure modes this role " +
        "prevents, the rules that do not bend, and what it refuses to absorb.",
    });
  }

  if (input.boundary !== undefined && input.boundary.includes(GENERIC_BOUNDARY)) {
    found.push({
      code: "role/generic-boundary",
      message: "boundary names no neighbouring role.",
      hint:
        'The schema requires a boundary to state "what this role is NOT, naming the neighbour". ' +
        '"Owns the scoped responsibility described in the mission" is true of every role and so ' +
        "distinguishes none of them.",
    });
  }

  for (const command of input.verifyCommands ?? []) {
    if (PLACEHOLDER_VERIFY.test(command)) {
      found.push({
        code: "role/placeholder-verify-command",
        message: `verify_commands contains the placeholder "${command}".`,
        hint:
          "Name the checks this role's work actually needs, in the project's own terms. A role that " +
          "cannot name its verification reports confidence instead of evidence.",
      });
      break;
    }
  }

  return found;
}

/**
 * Report completeness across the catalogue.
 *
 * A role outside the quarantine is an error: the bar is met or the build fails.
 * A quarantined role is one warning naming the remaining count, because thirty
 * individual warnings on every run is noise nobody reads, and the number going
 * down is the only progress signal that matters.
 */
export function checkCompleteness(
  roles: readonly CompletenessInput[],
  diags: Diagnostics,
): { outstanding: string[]; cleared: string[] } {
  const outstanding: string[] = [];
  const cleared: string[] = [];

  for (const role of roles) {
    const findings = completenessFindings(role);
    const quarantined = QUARANTINED.has(role.id);

    if (findings.length === 0) {
      if (quarantined) cleared.push(role.id);
      continue;
    }
    if (quarantined) {
      outstanding.push(role.id);
      continue;
    }
    for (const finding of findings) {
      diags.error({
        code: finding.code,
        file: role.file,
        key: role.id,
        message: finding.message,
        ...(finding.hint === undefined ? {} : { hint: finding.hint }),
      });
    }
  }

  if (outstanding.length > 0) {
    diags.warn({
      code: "catalogue/roles-unfinished",
      file: "se/agents",
      message:
        `${outstanding.length} role(s) remain template fill and are quarantined from the ` +
        `completeness rule: ${outstanding.slice(0, 5).join(", ")}${outstanding.length > 5 ? ", ..." : ""}`,
      hint: "The quarantine list in src/roles/completeness.ts may only shrink. Remove an id once its role is finished.",
    });
  }

  /*
   * A cleared role still listed is not harmless: the list is the progress
   * signal, and an entry that no longer corresponds to a defect makes the
   * remaining count a lie.
   */
  if (cleared.length > 0) {
    diags.error({
      code: "catalogue/stale-quarantine",
      file: "src/roles/completeness.ts",
      message: `${cleared.length} quarantined role(s) now meet the bar: ${cleared.join(", ")}`,
      hint: "Remove them from QUARANTINE. The list must reflect the real backlog or the count means nothing.",
    });
  }

  return { outstanding, cleared };
}
