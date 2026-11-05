/**
 * Deterministic task routing: which role owns this request.
 *
 * `schemas/topics.json` has carried 221 operator keywords since it was written,
 * and nothing ever matched a string against them -- the words were validated,
 * printed, and embedded into router prose, then the actual decision was handed
 * to the model. That is the expensive way round: a model can only choose
 * between roles it can see, so every session paid 16,730 tokens to keep 191
 * descriptions resident just so one of them could be picked.
 *
 * Matching here costs no model tokens at all.
 *
 * Three stages, narrowing:
 *
 *   1. keyword  -> topics          (what subject area is this)
 *   2. artifact -> owning role     (what thing is being produced)
 *   3. department                  (which team that role reports to)
 *
 * Stage 2 is what separates a designer from a coder on the same keyword. Both
 * answer to "design the login screen"; only one owns `visual-design` and only
 * one owns `frontend-screen`. Ownership is 1:1 across all 203 artifact kinds,
 * so an artifact match is a decision rather than a ranking.
 *
 * This is a lookup, not a classifier. When the stages disagree or nothing
 * matches, it reports `ambiguous` or `none` and names the question to ask. It
 * never picks the nearest role: a wrong specialist produces confident work in
 * the wrong shape, which is more expensive than a clarifying question.
 */

import type { Role } from "./types.ts";
import { TOPICS, type Topic } from "./topics.ts";
import { departmentLabel } from "./vocabulary.ts";

/** How much the caller should trust the result. Drives whether Atina asks. */
export type RouteConfidence = "clear" | "ambiguous" | "none";

export interface RouteOwner {
  readonly role: string;
  readonly department: string;
  readonly departmentLabel: string;
  /** Artifact kinds this role owns that the request appears to name. */
  readonly matchedArtifacts: readonly string[];
  readonly score: number;
}

export interface RouteHit {
  readonly topic: Topic;
  readonly matched: readonly string[];
  readonly roles: readonly string[];
  readonly score: number;
}

export interface RouteResult {
  readonly query: string;
  readonly confidence: RouteConfidence;
  /** Ranked candidate owners, strongest first. Empty when confidence is "none". */
  readonly owners: readonly RouteOwner[];
  /** Topics whose keywords matched, for explaining *why* this routed here. */
  readonly hits: readonly RouteHit[];
  /** Departments the candidates span. More than one is a reason to ask. */
  readonly departments: readonly string[];
  /** Present when the caller must put a question to the operator. */
  readonly question: string | null;
  readonly fallback: string | null;
  readonly warnings: readonly string[];
}

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9+#.\- ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * Whole-token containment. Substring matching would route "authorisation" from
 * "author", and "token" must not match inside "tokenizer", so the needle is
 * bounded by spaces on both sides.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(` ${phrase.toLowerCase()} `);
}

/**
 * Does the request name this artifact kind? Artifact ids are kebab-case
 * compounds (`visual-design`, `frontend-screen`), which an operator will not
 * type verbatim, so each is also matched as a space-separated phrase and by its
 * distinctive head noun -- but only for multi-word kinds, because a bare
 * `requirement` or `prototype` is too common to carry a routing decision alone.
 */
function artifactMentioned(text: string, kind: string): boolean {
  if (containsPhrase(text, kind)) return true;
  const words = kind.split("-");
  if (words.length < 2) return false;
  if (containsPhrase(text, words.join(" "))) return true;
  // Reversed head noun: "design token" also reads as "token design".
  return containsPhrase(text, [...words].reverse().join(" "));
}

/**
 * Words too common to carry a routing decision on their own.
 *
 * Measured failure: "an api key was pushed to the repository" matched the
 * single keyword "api" and routed confidently to `api-architect` instead of
 * `secrets-management-engineer`. A one-word match against a common technical
 * noun is weak evidence, so it can contribute to ranking but must never on its
 * own produce a confident answer.
 */
const WEAK_ALONE: ReadonlySet<string> = new Set([
  "api", "data", "page", "build", "test", "tests", "cache", "search", "session",
  "token", "roles", "schema", "deploy", "release", "index", "queue", "job",
  "design", "layout", "content", "docs", "log", "logs", "model", "prompt",
]);

const STOP: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "they", "them",
  "their", "there", "our", "you", "your", "are", "was", "were", "been", "has",
  "have", "had", "can", "could", "should", "would", "will", "may", "might",
  "must", "not", "but", "all", "any", "some", "when", "what", "which", "who",
  "how", "why", "about", "than", "then", "also", "just", "only", "even", "does",
  "did", "get", "got", "need", "want", "know", "say", "says", "said", "one",
  "two", "people", "someone", "nobody", "everyone", "something", "anything",
  "thing", "things", "make", "made", "take", "takes", "keep", "keeps", "goes",
  "going", "come", "comes", "back", "out", "off", "its", "his", "her",
]);

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.split(" ")) {
    if (w.length > 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * Symptom index: the words a role's own failure modes use to describe what goes
 * wrong in its area.
 *
 * The 221 topic keywords are catalogue vocabulary; an operator writes "people
 * cannot get into their accounts", which contains none of them. The 977 failure
 * modes are written as observable symptoms, which is much closer to how a
 * request arrives, so they make a better index than the keyword list for exactly
 * the inputs the keyword list misses.
 *
 * This is still lexical and therefore still weak. It generates candidates and
 * ranks them; it is never allowed to produce a confident answer by itself.
 */
function symptomWords(role: Role): Set<string> {
  const parts = [role.mission, ...role.failure_modes.map((f) => `${f.mode} ${f.guard}`)];
  return contentWords(normalise(parts.join(" ")));
}

export function route(query: string, available: ReadonlyMap<string, Role>): RouteResult {
  const warnings: string[] = [];
  const text = normalise(query);
  if (text.trim().length === 0) {
    return {
      query, confidence: "none", owners: [], hits: [], departments: [],
      question: "The request is empty. What should be built, fixed or decided?",
      fallback: null, warnings: ["Empty request; nothing to route."],
    };
  }

  // --- stage 1: keywords -> topics
  const hits: RouteHit[] = [];
  for (const topic of TOPICS) {
    const matched = topic.keywords.filter((k) => containsPhrase(text, k));
    if (matched.length === 0) continue;
    const present = topic.roles.filter((id) => {
      const role = available.get(id);
      return role !== undefined && role.enabled && role.status === "active";
    });
    if (present.length < topic.roles.length) {
      const missing = topic.roles.filter((id) => !present.includes(id));
      warnings.push(`Topic "${topic.id}" names ${missing.length} role(s) not in this roster: ${missing.join(", ")}.`);
    }
    /*
     * Specificity, not count, decides confidence. A two-word phrase or an
     * uncommon single word is real evidence; a bare common noun is not.
     */
    const score = matched.reduce((sum, k) => {
      const words = k.split(" ").length;
      if (words > 1) return sum + words * 2;
      return sum + (WEAK_ALONE.has(k) ? 0 : 2);
    }, 0);
    hits.push({ topic, matched, roles: present, score });
  }
  hits.sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));

  /*
   * Which roles were named by a topic whose keyword match was *specific* (a
   * multi-word phrase, or a single uncommon word)? Only those roles have
   * strong keyword evidence behind them.
   *
   * Tracking this per role rather than per request matters: an earlier version
   * asked only whether the request contained any specific keyword anywhere,
   * which then licensed a confident answer for a role that had actually been
   * selected by weak symptom overlap. That is how "removed from the store for a
   * privacy declaration problem" confidently reached `data-governance-steward`.
   */
  const strongByKeyword = new Set<string>();
  for (const h of hits) {
    const specific = h.matched.some((k) => k.split(" ").length > 1 || !WEAK_ALONE.has(k));
    if (!specific) continue;
    for (const id of h.roles) strongByKeyword.add(id);
  }

  // --- stage 2: artifact ownership, over the candidates the topics named
  const candidateIds = new Set<string>();
  for (const hit of hits) for (const id of hit.roles) candidateIds.add(id);

  /*
   * An artifact named in the request routes on its own, even when no topic
   * keyword matched: "write the migration plan" names `migration-plan`
   * unambiguously, and refusing to route it because no keyword fired would be
   * a worse answer than the one the ownership matrix already holds.
   */
  const artifactOwners = new Map<string, string[]>();
  for (const [id, role] of available) {
    if (!role.enabled || role.status !== "active") continue;
    const owned = role.owns_artifacts.filter((k) => artifactMentioned(text, k));
    if (owned.length > 0) {
      artifactOwners.set(id, owned);
      candidateIds.add(id);
    }
  }

  /*
   * Symptom matching, over the whole active roster. This is what answers a
   * request phrased in the operator's words rather than the catalogue's: it
   * found a defensible owner for 42% of the hard cases where keyword matching
   * found 0%. Scored well below an artifact match, because it is lexical
   * overlap and nothing more.
   */
  const queryWords = contentWords(text);
  const symptomScore = new Map<string, number>();
  if (queryWords.size > 0) {
    for (const [id, role] of available) {
      if (!role.enabled || role.status !== "active") continue;
      const words = symptomWords(role);
      if (words.size === 0) continue;
      let overlap = 0;
      for (const w of queryWords) if (words.has(w)) overlap += 1;
      if (overlap === 0) continue;
      /*
       * Require real overlap, not a single shared word.
       *
       * A threshold of one admitted almost every role with any word in common,
       * producing a 33-role "shortlist" ranked by nothing -- ties fell through
       * to alphabetical order, which is why `accessibility-specialist` kept
       * appearing near the top. Two words, and at least a fifth of the
       * request, is the point at which the overlap is about the subject rather
       * than about English.
       */
      const fraction = overlap / queryWords.size;
      if (overlap < 2 || fraction < 0.2) continue;
      symptomScore.set(id, fraction * 6);
      candidateIds.add(id);
    }
  }

  const owners: RouteOwner[] = [];
  for (const id of candidateIds) {
    const role = available.get(id);
    if (!role) continue;
    const matchedArtifacts = artifactOwners.get(id) ?? [];
    // Topic position is weak evidence; owning the named artifact is strong.
    // A role that owns the thing being produced outranks one that merely
    // shares a subject keyword with it.
    const topicScore = hits.find((h) => h.roles.includes(id))?.score ?? 0;
    const firstNamed = hits.some((h) => h.roles[0] === id) ? 1 : 0;
    owners.push({
      role: id,
      department: role.department,
      departmentLabel: departmentLabel(role.department),
      matchedArtifacts,
      score: matchedArtifacts.length * 10 + topicScore + firstNamed + (symptomScore.get(id) ?? 0),
    });
  }
  owners.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  /*
   * Department shortlist, ranked.
   *
   * Lexical signal is too noisy to pick a role -- measured top-3 role accuracy
   * was 42% on hard cases -- but it is markedly better at picking an area,
   * because a department pools the evidence of its members. So the honest
   * output when no artifact matched is a short list of departments, which the
   * caller resolves with `se heads` and `se roles --dept`: 15 options, then
   * ~15, instead of 191.
   */
  const deptScore = new Map<string, number>();
  for (const o of owners) {
    deptScore.set(o.department, (deptScore.get(o.department) ?? 0) + o.score);
  }
  const departments = [...deptScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([d]) => d);

  // --- stage 3: confidence
  /*
   * Confidence is gated on the *kind* of evidence, not on rank.
   *
   * Measured failure before this gate: 24% of real requests produced a
   * confident wrong answer, because a single common keyword was enough to win a
   * sort. A wrong confident answer sends work to the wrong specialist and the
   * operator finds out after a full run; an admitted ambiguity costs one
   * question. So only strong evidence may be confident:
   *
   *   strong  -- the request names an artifact this role uniquely owns, or a
   *              multi-word / uncommon keyword phrase
   *   weak    -- lexical symptom overlap, or a bare common noun
   *
   * Weak evidence ranks candidates and nothing more.
   */
  let confidence: RouteConfidence;
  let question: string | null = null;
  const top = owners[0] ?? null;
  /*
   * Only a named artifact licenses a confident answer.
   *
   * A keyword identifies the *subject area*, and a topic names between four and
   * eleven roles; choosing one of them confidently is not something the keyword
   * justifies. Measured: with keyword evidence allowed to confer confidence,
   * 20% of real requests were confidently wrong -- "our cloud bill doubled"
   * matched the infrastructure topic and then symptom overlap picked
   * `platform-architect` over `capacity-cost-engineer`. Artifact ownership is
   * 1:1 across all 167 owned artifacts, so it identifies a role rather than an
   * area, and it is the only evidence here strong enough to act on alone.
   *
   * Everything else returns a ranked shortlist and a question. That is not a
   * weaker answer; it is the honest one, and it costs the operator one reply
   * instead of a wasted specialist run.
   */
  const strongTop = top !== null && top.matchedArtifacts.length > 0;
  const margin = owners.length > 1 ? top!.score - owners[1]!.score : Number.POSITIVE_INFINITY;

  if (top === null) {
    confidence = "none";
  } else if (strongTop && margin > 0) {
    confidence = "clear";
  } else {
    confidence = "ambiguous";
    const near = owners.filter((o) => o.score >= top.score - 1).slice(0, 4);
    const spans = [...new Set(near.map((o) => o.departmentLabel))];
    const keywordBacked = top !== null && strongByKeyword.has(top.role);
    question = keywordBacked
      ? (spans.length > 1
        ? `This could be ${spans.join(" or ")} work. Which outcome do you want: ${near.map((o) => `${o.role} (${o.departmentLabel})`).join(", ")}?`
        : `Several ${top.departmentLabel} roles could own this. Which artifact do you want produced: ${near.map((o) => o.role).join(", ")}?`)
      : `Lexical matching cannot name the owner here, and this ranking is noise -- measured top-1 accuracy on real phrasing is about a quarter. Do not pick from it. Run "se heads" (15 departments, ~190 tokens), choose the department, then "se roles --dept <id>" and choose the role. Areas with any signal: ${near.map((o) => o.departmentLabel).filter((d, i, a) => a.indexOf(d) === i).join(", ")}.`;
  }

  /*
   * Nothing matched. The honest answer is not the nearest role: a request that
   * names an outcome with no implementation decision in it ("build me a
   * website") has no owner yet, and belongs with whoever turns needs into
   * testable requirements. That is a documented routing rule in this project.
   */
  const fallback = owners.length === 0
    ? (available.has("requirements-engineer") ? "requirements-engineer" : null)
    : null;
  if (confidence === "none") {
    question = fallback
      ? "No keyword or artifact matched. Either this states an outcome with no implementation decision in it -- then ask what should change and how we would know it worked -- or the wording simply does not overlap the catalogue, in which case run \"se heads\" and choose the department yourself rather than accepting the fallback."
      : "No keyword or artifact matched and requirements-engineer is not installed. Which role should own this?";
    if (!fallback) warnings.push("No fallback role available; ask the operator rather than picking one.");
  }

  return { query, confidence, owners, hits, departments, question, fallback, warnings };
}

/** Operator-facing render. Short: this is read, then acted on immediately. */
export function formatRoute(result: RouteResult): string {
  const out: string[] = [];
  out.push(`confidence: ${result.confidence}`);

  if (result.hits.length > 0) {
    const why = result.hits.map((h) => `${h.topic.label} (${h.matched.join(", ")})`).join("; ");
    out.push(`matched: ${why}`);
  }

  if (result.confidence === "none") {
    out.push("");
    out.push(`ASK: ${result.question}`);
    if (result.fallback) out.push(`then: se hire ${result.fallback}`);
    for (const w of result.warnings) out.push(`warning: ${w}`);
    return out.join("\n");
  }

  out.push("");
  for (const owner of result.owners.slice(0, 6)) {
    const art = owner.matchedArtifacts.length > 0 ? `  owns: ${owner.matchedArtifacts.join(", ")}` : "";
    out.push(`  ${owner.role.padEnd(38)} ${owner.departmentLabel}${art}`);
  }

  out.push("");
  if (result.confidence === "ambiguous") {
    out.push(`ASK: ${result.question}`);
    out.push("Do not hire until the operator answers.");
  } else {
    out.push(`se hire ${result.owners[0]!.role}`);
    out.push("That role owns the outcome. The rest are consulted only on handover.");
  }
  for (const w of result.warnings) out.push(`warning: ${w}`);
  return out.join("\n");
}
