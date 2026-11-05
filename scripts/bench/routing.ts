/**
 * Routing accuracy against the catalogue's own labels.
 *
 * `schemas/topics.json` holds 221 operator keywords, and `topic/ambiguous-keyword`
 * enforces that each belongs to exactly one topic. That makes it a genuine
 * labelled set: for every keyword there is one correct topic and a known set of
 * roles that own it.
 *
 * Because routing is now a code lookup rather than a model judgement, this arm
 * costs nothing to run and is fully deterministic. That matters: it means a
 * routing regression fails a build instead of being discovered when a design
 * task reaches a coder.
 *
 * What this measures: whether the router sends a request to a role that owns
 * the subject. What it does NOT measure: whether that role then does good work.
 * That needs the defect arm, which costs money and needs a model.
 */

import { resolveRoles } from "../../src/roles/resolve.ts";
import { route } from "../../src/roles/route.ts";
import { TOPICS } from "../../src/roles/topics.ts";
import { findCatalogueRoot } from "../../src/util/paths.ts";

interface Case {
  readonly keyword: string;
  readonly topic: string;
  /** Roles the topic declares; any of them is a correct subject match. */
  readonly expected: readonly string[];
}

interface Outcome {
  readonly kase: Case;
  readonly confidence: string;
  readonly top: string | null;
  /** The top candidate owns the subject. */
  readonly topInExpected: boolean;
  /** Some candidate owns the subject, even if not ranked first. */
  readonly anyInExpected: boolean;
  readonly askedInstead: boolean;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const topic of TOPICS) {
    for (const keyword of topic.keywords) {
      out.push({ keyword, topic: topic.id, expected: topic.roles });
    }
  }
  return out;
}

/*
 * A bare keyword is not a realistic request, and routing on one would flatter
 * the router: real input is a sentence. Each keyword is wrapped in a neutral
 * carrier phrase so the matcher has to find it in prose, including the
 * word-boundary handling that stops "token" matching inside "tokenizer".
 */
function phrase(keyword: string): string {
  return `we need to deal with the ${keyword} part of the product`;
}

function main(): number {
  const root = findCatalogueRoot();
  if (!root) {
    console.error("error: no catalogue found. Run from the repository, or run `se link`.");
    return 2;
  }
  const registry = resolveRoles(root);
  const all = cases();
  const outcomes: Outcome[] = [];

  for (const kase of all) {
    const result = route(phrase(kase.keyword), registry.byId);
    const top = result.owners[0]?.role ?? null;
    outcomes.push({
      kase,
      confidence: result.confidence,
      top,
      topInExpected: top !== null && kase.expected.includes(top),
      anyInExpected: result.owners.some((o) => kase.expected.includes(o.role)),
      askedInstead: result.confidence !== "clear",
    });
  }

  const n = outcomes.length;
  const top1 = outcomes.filter((o) => o.topInExpected).length;
  const anyHit = outcomes.filter((o) => o.anyInExpected).length;
  const noMatch = outcomes.filter((o) => o.confidence === "none").length;
  const ambiguous = outcomes.filter((o) => o.confidence === "ambiguous").length;

  /*
   * The important distinction for a production system is not accuracy alone but
   * what happens when the router is unsure. A wrong confident answer sends work
   * to the wrong specialist; an admitted ambiguity costs one question. So these
   * are counted separately and a confident miss is the only real failure.
   */
  const confidentMiss = outcomes.filter((o) => o.confidence === "clear" && !o.topInExpected).length;
  const safeAsk = outcomes.filter((o) => o.confidence !== "clear" && o.anyInExpected).length;
  const blindMiss = outcomes.filter((o) => o.confidence === "none").length;

  console.log("routing accuracy -- " + n + " labelled keywords from schemas/topics.json");
  console.log("");
  console.log("  top-1 owns the subject        " + pct(top1, n));
  console.log("  any candidate owns it         " + pct(anyHit, n));
  console.log("");
  console.log("  confident and correct         " + pct(outcomes.filter((o) => o.confidence === "clear" && o.topInExpected).length, n));
  console.log("  CONFIDENT AND WRONG           " + pct(confidentMiss, n) + "   <- the only real failure");
  console.log("  asked, candidate present      " + pct(safeAsk, n));
  console.log("  no match at all               " + pct(blindMiss, n));
  console.log("");
  console.log("  ambiguous (asks the operator) " + pct(ambiguous, n));
  console.log("  none      (asks for criteria) " + pct(noMatch, n));

  if (confidentMiss > 0) {
    console.log("");
    console.log("confident misses, worst first:");
    for (const o of outcomes.filter((x) => x.confidence === "clear" && !x.topInExpected).slice(0, 15)) {
      console.log(`  "${o.kase.keyword}" (${o.kase.topic}) -> ${o.top}`);
    }
  }

  /*
   * Exit non-zero on a confident miss rate above the stated bar. A benchmark
   * that only prints is a dashboard; this has to be able to fail.
   */
  const bar = 0.1;
  const rate = confidentMiss / n;
  console.log("");
  if (rate > bar) {
    console.error(`FAIL: confident-miss rate ${(rate * 100).toFixed(1)}% exceeds the ${(bar * 100).toFixed(0)}% bar.`);
    return 1;
  }
  console.log(`PASS: confident-miss rate ${(rate * 100).toFixed(1)}% within the ${(bar * 100).toFixed(0)}% bar.`);
  return 0;
}

function pct(k: number, n: number): string {
  return String(k).padStart(4) + " / " + n + "  " + ((k / n) * 100).toFixed(1).padStart(5) + "%";
}

process.exit(main());
