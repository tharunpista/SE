/**
 * The front door.
 *
 * A clone of this catalogue installs a roster of specialists, each reachable by
 * description. That produces two failures with one cause:
 *
 *   - An operator does not know which of them to pick.
 *   - A host picks by matching the request against descriptions, so an unscoped
 *     request ("build me a website") matches an implementer, and an implementer
 *     implements. Nothing asked what the website is for, because nothing in the
 *     path was accountable for asking.
 *
 * Both are routing failures, not politeness failures. The catalogue already
 * contains the roles that own unscoped work -- `requirements-engineer` exists to
 * "separate what the user actually said from what anyone inferred", and
 * `chief-orchestrator` exists to "refuse to let work proceed on unresolved
 * contracts" -- and neither is ever reached, because nothing classifies a
 * request before dispatching it.
 *
 * This module emits that classifier, and emits it *from the catalogue* rather
 * than as prose a maintainer keeps in sync by hand. The routing table and the
 * ownership index below are derived from the rendered roster, so a role that is
 * added, retired or re-scoped changes the router in the same command that
 * changes the role. A hand-written router is wrong the first time anyone edits a
 * role file, and silently wrong after that.
 */

import type { Role } from "../roles/types.ts";
import { departmentLabel } from "../roles/vocabulary.ts";
import { TOPICS } from "../roles/topics.ts";
import type { RenderedFile } from "./host.ts";

export const ROUTER_SKILL_ID = "se-route";

/**
 * Request classes the router must separate before anything executes.
 *
 * The distinction that matters is not "vague" versus "clear" -- it is the cost
 * of guessing wrong. A throwaway page costs thirty seconds; a product's auth,
 * payment and content model cost a week. The classifier keys on that, which is
 * why a small concrete request is never interrogated.
 */
const CLASSES = [
  {
    name: "Scoped work",
    test: "names an artifact, a file, a defect, or a change to something that exists",
    action:
      "Route it. Find the owning role in the ownership index below and hand it the task. Do not ask " +
      "clarifying questions that the code or the contract already answers -- read them instead.",
  },
  {
    name: "Unscoped build request",
    test:
      "names an outcome with no constraints: \"build me a website\", \"make an app\", \"create a dashboard\". " +
      "No audience, no content source, no definition of done",
    action:
      "Do **not** route this to an implementer. It is not frontend work yet; there is no frontend " +
      "decision in it. Route it to `requirements-engineer`, and follow the protocol below.",
  },
  {
    name: "Question",
    test: "asks what something is, how it works, or what the options are",
    action: "Answer it. Do not route, do not spawn, do not build.",
  },
  {
    name: "Stuck work",
    test: "a task already attempted that is failing, flaky, or not understood",
    action:
      "Route to `root-cause-investigator`. Do not let the role that got stuck keep guessing: that is " +
      "the attempt-counting rule, and a third attempt by the same role is the signal to hand over.",
  },
] as const;

/**
 * The questions asked of an unscoped build request, and the reason each one is
 * on the list: every one of them changes the architecture, and none can be
 * recovered cheaply once built the other way.
 *
 * Five is a ceiling, not a target. A question whose answer would not change what
 * gets built is interrogation, and it is why people stop using tools that ask.
 */
const SCOPING_QUESTIONS = [
  {
    q: "Who uses it, and do they need accounts?",
    why: "Authentication decides the data model, the hosting, the session strategy and most of the security surface.",
    fallback: "no accounts; everything public",
  },
  {
    q: "Where does the content come from?",
    why: "Hand-written, a CMS, or a database are three different applications that look identical in a screenshot.",
    fallback: "static content written into the repository",
  },
  {
    q: "Does it take money?",
    why: "Payments bring a server, a provider contract, idempotency, refunds and compliance that cannot be retrofitted into a static site.",
    fallback: "no payments",
  },
  {
    q: "Does it need to be found by search engines?",
    why: "Server rendering versus a client-side app is a framework-level decision, not a setting.",
    fallback: "no search visibility requirement",
  },
  {
    q: "Where does it deploy, and is any stack already chosen?",
    why: "An existing stack outranks any recommendation; a target platform constrains the framework.",
    fallback: "the project's existing stack, or a static build if there is none",
  },
] as const;

function routingTable(roles: readonly Role[]): string[] {
  const byDept = new Map<string, Role[]>();
  for (const role of roles) {
    const list = byDept.get(role.department) ?? [];
    list.push(role);
    byDept.set(role.department, list);
  }

  const lines = ["| department | roles |", "|---|---|"];
  for (const dept of [...byDept.keys()].sort()) {
    const ids = byDept
      .get(dept)!
      .map((r) => `\`${r.id}\``)
      .sort()
      .join(", ");
    lines.push(`| ${departmentLabel(dept)} | ${ids} |`);
  }
  return lines;
}

/**
 * Artifact kind -> the role accountable for it.
 *
 * This is the routing mechanism the catalogue was built around and never used
 * for routing: exactly one enabled role owns an artifact kind, so naming the
 * artifact names the owner with no inference. Co-owned kinds list both, because
 * a shared boundary is a handoff rather than a lookup.
 *
 * Only kinds owned by a role in this roster are listed. Pointing at a role the
 * host has not installed is worse than omitting it: the handoff would name a
 * receiver that does not exist.
 */
function ownershipIndex(roles: readonly Role[]): string[] {
  const owners = new Map<string, string[]>();
  for (const role of roles) {
    for (const kind of role.owns_artifacts) {
      const list = owners.get(kind) ?? [];
      list.push(role.id);
      owners.set(kind, list);
    }
  }
  if (owners.size === 0) return [];

  const lines = ["| artifact | owner |", "|---|---|"];
  for (const kind of [...owners.keys()].sort()) {
    lines.push(`| \`${kind}\` | ${owners.get(kind)!.sort().map((id) => `\`${id}\``).join(", ")} |`);
  }
  return lines;
}

function hasRole(roles: readonly Role[], id: string): boolean {
  return roles.some((r) => r.id === id);
}

/**
 * Build the router skill for a roster.
 *
 * Returns null when the roster cannot support routing. A router that names
 * `requirements-engineer` when the host has no such agent would send every
 * unscoped request to a receiver that does not exist, which is strictly worse
 * than no router: the operator would be told the request was routed.
 */
export function renderRouterSkill(roles: readonly Role[]): RenderedFile | null {
  if (roles.length < 2) return null;
  const haveRequirements = hasRole(roles, "requirements-engineer");
  const haveOrchestrator = hasRole(roles, "chief-orchestrator");
  if (!haveRequirements && !haveOrchestrator) return null;

  // Prefer the requirements owner for scoping; fall back to the orchestrator,
  // which is specified to refuse work on unresolved requirements anyway.
  const scoper = haveRequirements ? "requirements-engineer" : "chief-orchestrator";

  const body: string[] = [
    "---",
    `name: ${ROUTER_SKILL_ID}`,
    `description: ${JSON.stringify(
      "Classify a request and route it to the role accountable for it. Use before starting work when " +
        "it is not already clear which role owns the task, and always for a request that names an " +
        "outcome without naming its constraints.",
    )}`,
    `when_to_use: ${JSON.stringify(
      "Use at the start of a task when the owning role is not obvious, and ALWAYS when the request " +
        "names an outcome with no constraints -- \"build me a website\", \"make an app\", \"create a " +
        "dashboard\", \"build the backend\". Such a request has no implementation decision in it yet, " +
        "and routing it straight to an implementer produces a confident build of the wrong thing.",
    )}`,
    "---",
    "",
    "<!-- GENERATED from se/agents/ by se render. Do not edit here; edits are overwritten. -->",
    "# Route work to its owner",
    "",
    "This roster is a set of accountable specialists, not a pool of generalists.",
    "Work lands correctly when it reaches the role that owns the artifact, and a",
    "misrouted task is harder to recover than an unrouted one. Classify first.",
    "",
    "## 1. Classify the request",
    "",
  ];

  for (const c of CLASSES) {
    body.push(`### ${c.name}`, `*${c.test}.*`, "", c.action, "");
  }

  body.push(
    "If two classes fit, take the more cautious one. If none fits, say so and ask",
    "the operator rather than routing to the nearest match.",
    "",
    "## 2. The unscoped-request protocol",
    "",
    `An unscoped build request goes to \`${scoper}\` before any implementer sees it.`,
    "That role's job is to turn a stated need into something testable, and to keep",
    "what the operator actually said separate from what anyone inferred.",
    "",
    "Ask **at most five** questions, and only ones whose answer changes what gets",
    "built. Offer the default you would otherwise assume, so the operator can",
    "accept the lot in one word instead of answering five times:",
    "",
    "| ask | why it changes the build | default if unanswered |",
    "|---|---|---|",
  );
  for (const s of SCOPING_QUESTIONS) {
    body.push(`| ${s.q} | ${s.why} | ${s.fallback} |`);
  }

  body.push(
    "",
    "### The rules that keep this from becoming interrogation",
    "",
    "1. **Ask once.** If the operator answers partially, proceed on the answers",
    "   given plus the stated defaults. Never return with a second round.",
    '2. **"Just build it" ends the protocol.** Build immediately, and state every',
    "   assumption you adopted in one block at the end. The operator has accepted",
    "   the cost of a wrong guess, which is their decision to make.",
    "3. **Never ask when the work is cheap and reversible.** A throwaway page, a",
    "   snippet, a local experiment: build it. The questions exist because auth,",
    "   payments, content model and rendering strategy cannot be changed later",
    "   without a rewrite, not because asking is polite.",
    "4. **Never ask what the repository answers.** An existing stack, an existing",
    "   schema, an existing contract outranks any question and any preference.",
    "   Read it first; asking about it wastes the operator's turn.",
    "5. **State assumptions whether or not you asked.** A build nobody questioned",
    "   is still a build full of decisions, and the operator cannot correct a",
    "   decision they were never shown.",
    "",
    "## 3. Route to the owner",
    "",
    "Name the artifact, and the owner follows without inference: exactly one role",
    "is accountable for each artifact kind.",
    "",
  );

  const index = ownershipIndex(roles);
  if (index.length > 0) {
    body.push(...index, "");
  }

  body.push(
    "### Departments in this roster",
    "",
    ...routingTable(roles),
    "",
    "## 4. What this skill does not do",
    "",
    "It grants no tools and it delegates nothing by itself. Whether a role can be",
    "invoked as a separate agent depends on the host; where it cannot, return the",
    "routing decision and the handoff to the operator rather than absorbing the",
    "work into whichever role happens to be active.",
    "",
    "A handoff is not accepted until its receiver confirms acceptance or names",
    "what is missing. Forwarding work is not completing it.",
    "",
  );

  return { path: `${ROUTER_SKILL_ID}/SKILL.md`, contents: body.join("\n") };
}

/**
 * One skill per topic, so a keyword reaches a group of roles.
 *
 * A department is where a role reports; a topic is what an operator types.
 * "auth" is owned by five roles across three departments, and no department
 * selection or role name reaches that set from the word the operator used. The
 * topic skill is the bridge: its `when_to_use` carries the vocabulary people
 * actually type, and its body names the roles that own the work.
 *
 * A topic is emitted only when the roster carries at least two of its roles.
 * Below that there is no group to route between, and the skill would mostly
 * list roles the host has not installed.
 *
 * Absent members are named rather than hidden. An operator who asks about
 * payments and holds three of the eight relevant roles needs to know which
 * five are missing and how to get them -- silently listing three would present
 * a partial roster as the whole answer.
 */
export function renderTopicSkills(roles: readonly Role[]): RenderedFile[] {
  const present = new Map(roles.map((r) => [r.id, r] as const));
  const files: RenderedFile[] = [];

  for (const topic of TOPICS) {
    const installed = topic.roles.filter((id) => present.has(id));
    if (installed.length < 2) continue;
    const absent = topic.roles.filter((id) => !present.has(id));

    const lines = [
      "---",
      `name: topic-${topic.id}`,
      `description: ${JSON.stringify(`${topic.label} — ${topic.purpose} Routes to the ${installed.length} role(s) in this roster that own it.`)}`,
      `when_to_use: ${JSON.stringify(
        `Use when the request concerns ${topic.label.toLowerCase()}, including when it mentions: ` +
          `${topic.keywords.join(", ")}. These words are owned by specific roles rather than by whoever is active; ` +
          `this skill names them.`,
      )}`,
      "---",
      "",
      "<!-- GENERATED from schemas/topics.json by se render. Do not edit here; edits are overwritten. -->",
      `# ${topic.label}`,
      "",
      topic.purpose,
      "",
      "## Roles that own this work",
      "",
      "| role | owns | mission |",
      "|---|---|---|",
    ];

    for (const id of installed) {
      const role = present.get(id)!;
      const owns = role.owns_artifacts.length > 0 ? role.owns_artifacts.map((a) => `\`${a}\``).join(", ") : "—";
      // Single-line, pipes stripped: a newline or a pipe in a cell breaks the table.
      const mission = role.mission.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
      lines.push(`| \`${role.id}\` | ${owns} | ${mission} |`);
    }

    lines.push(
      "",
      "Route to the role that owns the artifact in question. Where this host",
      "cannot invoke a role directly, apply that role's own definition and say",
      "which role's rules you are following.",
      "",
    );

    if (absent.length > 0) {
      lines.push(
        "## Not installed in this roster",
        "",
        `This topic also involves ${absent.map((id) => `\`${id}\``).join(", ")}, which this host does`,
        "not have. Do not approximate them and do not absorb their decisions.",
        "Report the gap, or install them:",
        "",
        "```sh",
        `se render --topic ${topic.id}`,
        "```",
        "",
      );
    }

    files.push({ path: `topic-${topic.id}/SKILL.md`, contents: lines.join("\n") });
  }

  return files;
}
