/**
 * Routing accuracy on requests phrased the way an operator actually phrases
 * them, deliberately avoiding the catalogue's own keywords.
 *
 * The keyword arm (routing.ts) scores 99.5%, and that number is close to
 * meaningless on its own: the carrier phrase contains the keyword verbatim, so
 * it mostly proves that a keyword matcher matches keywords. The honest question
 * is whether a request written in a user's words reaches the right specialist.
 *
 * So every case below is a sentence someone would really send, none of which
 * contains the topic keyword it should match, each labelled with the roles that
 * could correctly own it. These labels are hand-authored judgement, not derived
 * from the catalogue, which is the point -- a benchmark derived from the thing
 * under test cannot falsify it.
 *
 * `accept` lists every role that would be a defensible owner. A router that
 * picks any of them has routed correctly; the failure is picking something
 * outside the set *with confidence*. Admitting ambiguity is scored separately
 * and is not a failure.
 */

import { resolveRoles } from "../../src/roles/resolve.ts";
import { route } from "../../src/roles/route.ts";
import { findCatalogueRoot } from "../../src/util/paths.ts";

interface Case {
  readonly ask: string;
  readonly accept: readonly string[];
  /** Why this is the right owner, for reading a failure. */
  readonly note: string;
}

const CASES: readonly Case[] = [
  { ask: "people say they cannot get into their accounts since yesterday",
    accept: ["identity-access-integration-engineer", "security-architect", "authorization-model-engineer", "root-cause-investigator"],
    note: "sign-in failure" },
  { ask: "a customer was billed twice for one order",
    accept: ["backend-lead", "backend-service-engineer", "concurrency-transaction-engineer", "external-integration-engineer"],
    note: "duplicate charge on retry" },
  { ask: "the list of products takes about eight seconds to appear",
    accept: ["backend-performance-engineer", "database-engineer", "frontend-performance-engineer", "performance-architect"],
    note: "latency, likely N+1" },
  { ask: "we need to add a column to the orders table without taking the site down",
    accept: ["database-migration-engineer", "data-modeling-engineer", "migration-modernization-architect", "database-engineer"],
    note: "online schema change" },
  { ask: "screen reader users cannot complete the signup form",
    accept: ["frontend-accessibility-engineer", "accessibility-specialist", "accessibility-test-engineer"],
    note: "assistive technology barrier" },
  { ask: "make the checkout screen look like the approved mockup",
    accept: ["design-implementation-engineer", "visual-ui-designer", "design-qa-reviewer", "frontend-application-engineer"],
    note: "design fidelity" },
  { ask: "decide what colours and spacing every button should use across the product",
    accept: ["design-systems-architect", "design-systems-engineer", "visual-ui-designer"],
    note: "tokens and component set" },
  { ask: "our app is being removed from the store for a privacy declaration problem",
    accept: ["mobile-release-compliance-engineer", "privacy-engineer", "compliance-control-engineer"],
    note: "store compliance" },
  { ask: "the app forgets what the user typed when they switch to another app and come back",
    accept: ["android-application-engineer", "ios-application-engineer", "mobile-lead", "frontend-state-engineer"],
    note: "process death and state restoration" },
  { ask: "we want to know whether someone could break into this before we launch",
    accept: ["offensive-security-engineer", "security-architect", "security-test-engineer", "application-security-engineer"],
    note: "adversarial assessment" },
  { ask: "an api key was pushed to the repository last week",
    accept: ["secrets-management-engineer", "security-incident-responder", "application-security-engineer"],
    note: "leaked credential, rotate first" },
  { ask: "a user asked us to erase everything we hold about them",
    accept: ["data-retention-deletion-engineer", "privacy-engineer", "data-governance-steward"],
    note: "subject deletion across stores" },
  { ask: "emails are going out twice to some people",
    accept: ["notification-delivery-engineer", "background-job-engineer", "messaging-event-engineer"],
    note: "non-idempotent send on retry" },
  { ask: "the site went down for twenty minutes and we do not know why",
    accept: ["root-cause-investigator", "incident-response-coordinator", "site-reliability-engineer", "observability-engineer"],
    note: "outage investigation" },
  { ask: "we keep finding out about problems from customers instead of our own alerts",
    accept: ["observability-engineer", "site-reliability-engineer", "incident-response-coordinator"],
    note: "detection gap" },
  { ask: "deploys are scary and we have no way back if one goes wrong",
    accept: ["release-rollback-engineer", "devops-engineer", "cicd-engineer", "disaster-recovery-engineer"],
    note: "rollback capability" },
  { ask: "two services disagree about how much stock is left",
    accept: ["data-flow-state-consistency-engineer", "distributed-systems-architect", "data-architect", "messaging-event-engineer"],
    note: "consistency between systems" },
  { ask: "one big customer slowed the product down for everyone else",
    accept: ["multi-tenancy-isolation-engineer", "capacity-cost-engineer", "site-reliability-engineer", "backend-performance-engineer"],
    note: "noisy neighbour" },
  { ask: "our cloud bill doubled and nobody knows which team caused it",
    accept: ["capacity-cost-engineer", "cloud-infrastructure-engineer", "finance-unit-economics-analyst"],
    note: "cost attribution" },
  { ask: "the answers our assistant gives are confidently wrong sometimes",
    accept: ["ai-evaluation-engineer", "ai-systems-architect", "retrieval-knowledge-engineer", "responsible-ai-risk-engineer"],
    note: "model output quality" },
  { ask: "we want the model to answer from our own documents and cite them",
    accept: ["retrieval-knowledge-engineer", "ai-systems-architect", "context-engineer"],
    note: "grounded retrieval" },
  { ask: "the provider is retiring the model version we built on",
    accept: ["model-lifecycle-deprecation-engineer", "model-integration-engineer", "ai-systems-architect"],
    note: "version deprecation" },
  { ask: "each request to the model costs more than we make on the feature",
    accept: ["model-performance-engineer", "token-cost-governance-engineer", "capacity-cost-engineer"],
    note: "inference economics" },
  { ask: "our agent loops forever on some inputs",
    accept: ["agent-systems-engineer", "orchestration-runtime-engineer", "ai-workflow-engineer"],
    note: "non-terminating loop" },
  { ask: "write down how someone new sets this project up on their machine",
    accept: ["developer-onboarding-engineer", "technical-documentation-engineer", "developer-experience-engineer"],
    note: "reproducible setup path" },
  { ask: "the instructions on our docs site no longer match what the product does",
    accept: ["documentation-qa-reviewer", "technical-documentation-engineer", "api-documentation-engineer"],
    note: "documentation drift" },
  { ask: "we need to tell users what changed in this release and what they must do",
    accept: ["release-notes-engineer", "technical-documentation-engineer", "product-manager"],
    note: "user-visible change summary" },
  { ask: "the same question keeps coming to support every day",
    accept: ["support-knowledge-engineer", "defect-triage-engineer", "troubleshooting-engineer"],
    note: "recurring question is a product signal" },
  { ask: "nobody can tell which of our tests actually matter",
    accept: ["test-architect", "qa-lead", "regression-test-engineer", "test-infrastructure-engineer"],
    note: "test strategy and allocation" },
  { ask: "our build goes red at random and people just press retry",
    accept: ["test-infrastructure-engineer", "qa-lead", "cicd-engineer"],
    note: "flaky suite" },
  { ask: "we promised the system survives a database failover but never tried it",
    accept: ["chaos-and-resilience-test-engineer", "database-reliability-engineer", "reliability-architect", "disaster-recovery-engineer"],
    note: "untested resilience claim" },
  { ask: "decide whether we should build this on top of the existing service or a new one",
    accept: ["solution-architect", "principal-architect", "application-architect", "architecture-decision-analyst"],
    note: "structural decision with trade-offs" },
  { ask: "can this even be done with the data we have, and what would it cost",
    accept: ["technical-feasibility-engineer", "solution-architect", "architecture-decision-analyst"],
    note: "feasibility with a cost" },
  { ask: "we are replacing the old billing system while it keeps running",
    accept: ["migration-modernization-architect", "solution-architect", "data-architect"],
    note: "staged replacement with rollback" },
  { ask: "the front end and the back end disagree about what a field means",
    accept: ["api-contract-owner", "frontend-backend-integration-engineer", "contract-test-engineer", "full-stack-integration-architect"],
    note: "contract ambiguity" },
  { ask: "we want to turn this feature on for ten percent of users first",
    accept: ["feature-flag-engineer", "release-rollback-engineer", "experimentation-specialist"],
    note: "gradual exposure" },
  { ask: "uploads from users could contain anything and we store them directly",
    accept: ["file-object-storage-engineer", "application-security-engineer", "security-architect"],
    note: "untrusted file handling" },
  { ask: "our search returns things that are not relevant and misses obvious matches",
    accept: ["search-engineer", "retrieval-knowledge-engineer"],
    note: "relevance and index honesty" },
  { ask: "the live dashboard stops updating if someone loses signal for a minute",
    accept: ["realtime-systems-engineer", "frontend-data-fetching-engineer", "offline-pwa-engineer"],
    note: "reconnect and gap replay" },
  { ask: "we are adding a second language and nothing fits in the buttons",
    accept: ["internationalization-engineer", "localization-qa-engineer", "responsive-design-specialist", "ux-content-designer"],
    note: "text expansion and locale layout" },
  { ask: "nobody knows what state a customer order is in halfway through",
    accept: ["end-to-end-workflow-engineer", "backend-lead", "journey-workflow-designer"],
    note: "workflow visibility" },
  { ask: "work keeps getting handed between people and dropped",
    accept: ["chief-orchestrator", "operations-coordinator", "project-manager", "technical-program-manager"],
    note: "handoff and ownership" },
  { ask: "we want to remember decisions so we stop having the same argument",
    accept: ["decision-recorder", "knowledge-steward", "architecture-decision-analyst"],
    note: "decision provenance" },
  { ask: "build me a website for my bakery",
    accept: ["requirements-engineer", "product-strategist", "solution-architect", "chief-orchestrator"],
    note: "outcome with no implementation decision" },
  { ask: "make it faster",
    accept: ["requirements-engineer", "performance-architect"],
    note: "no stated budget or operation; should ask" },
];

interface Outcome {
  readonly kase: Case;
  readonly confidence: string;
  readonly top: string | null;
  readonly ok: boolean;
  readonly anyOk: boolean;
}

function main(): number {
  const root = findCatalogueRoot();
  if (!root) {
    console.error("error: no catalogue found.");
    return 2;
  }
  const registry = resolveRoles(root);
  const outcomes: Outcome[] = CASES.map((kase) => {
    const r = route(kase.ask, registry.byId);
    const top = r.owners[0]?.role ?? r.fallback ?? null;
    return {
      kase,
      confidence: r.confidence,
      top,
      ok: top !== null && kase.accept.includes(top),
      anyOk: r.owners.some((o) => kase.accept.includes(o.role)) || (r.fallback !== null && kase.accept.includes(r.fallback)),
    };
  });

  const n = outcomes.length;
  const top1 = outcomes.filter((o) => o.ok).length;
  const anyHit = outcomes.filter((o) => o.anyOk).length;
  const confidentMiss = outcomes.filter((o) => o.confidence === "clear" && !o.ok).length;
  const askedOk = outcomes.filter((o) => o.confidence !== "clear" && o.anyOk).length;
  const blind = outcomes.filter((o) => !o.anyOk).length;

  console.log("paraphrase routing -- " + n + " hand-authored requests, no topic keywords");
  console.log("");
  console.log("  top-1 is a defensible owner   " + pct(top1, n));
  console.log("  some candidate is defensible  " + pct(anyHit, n));
  console.log("  CONFIDENT AND WRONG           " + pct(confidentMiss, n) + "   <- real failure");
  console.log("  asked, right owner present    " + pct(askedOk, n));
  console.log("  no defensible owner at all    " + pct(blind, n) + "   <- real failure");
  console.log("");

  const bad = outcomes.filter((o) => !o.anyOk || (o.confidence === "clear" && !o.ok));
  if (bad.length > 0) {
    console.log("failures:");
    for (const o of bad) {
      console.log(`  [${o.confidence}] "${o.kase.ask}"`);
      console.log(`      got ${o.top ?? "nothing"} -- wanted one of ${o.kase.accept.slice(0, 3).join(", ")}  (${o.kase.note})`);
    }
    console.log("");
  }

  const rate = (confidentMiss + blind) / n;
  const bar = 0.25;
  if (rate > bar) {
    console.error(`FAIL: failure rate ${(rate * 100).toFixed(1)}% exceeds the ${(bar * 100).toFixed(0)}% bar.`);
    return 1;
  }
  console.log(`PASS: failure rate ${(rate * 100).toFixed(1)}% within the ${(bar * 100).toFixed(0)}% bar.`);
  return 0;
}

function pct(k: number, n: number): string {
  return String(k).padStart(4) + " / " + n + "  " + ((k / n) * 100).toFixed(1).padStart(5) + "%";
}

process.exit(main());
