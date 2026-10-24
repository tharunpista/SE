import vocab from "../../schemas/vocabulary.json" with { type: "json" };

export const DEPARTMENTS = vocab.departments as readonly string[];
export const DEPARTMENT_EXPECTED_COUNTS = vocab.department_expected_counts as Record<string, number>;
export const DEFERRED_DEPARTMENTS = new Set(vocab.deferred_departments as readonly string[]);

const DEPARTMENT_LABELS: Readonly<Record<string, string>> = {
  orchestration: "Orchestration",
  "product-and-requirements": "Product & Requirements",
  "design-and-ux": "Design & UX",
  architecture: "Architecture",
  frontend: "Frontend",
  "backend-and-data": "Backend & Data",
  integration: "Integration",
  "ai-and-agent-systems": "AI & Agent Systems",
  "quality-and-testing": "Quality & Testing",
  "security-and-privacy": "Security & Privacy",
  "platform-and-operations": "Platform & Operations",
  "mobile-and-desktop": "Mobile & Desktop",
  "hardware-and-embedded": "Hardware & Embedded",
  "agent-platform-engineering": "Agent Platform Engineering",
  "documentation-and-support": "Documentation & Support",
  "business-and-product-operations": "Business & Product Operations",
};

/** Human-facing label for a canonical department id. */
export function departmentLabel(id: string): string {
  return DEPARTMENT_LABELS[id] ?? id.split("-").map((word) =>
    word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1),
  ).join(" ");
}

export const ARTIFACT_KINDS = new Set(vocab.artifact_kinds as readonly string[]);
export const INTERFACE_KINDS = new Set(vocab.interface_kinds as readonly string[]);
/**
 * Capabilities a role may declare in `tools`. Closed for the same reason every
 * other vocabulary here is: an unknown term in `tools` is the one typo that
 * silently removes authority instead of failing, because the renderer drops an
 * unmapped capability and the role never learns it lost one.
 */
export const CAPABILITY_KINDS = new Set(vocab.capabilities as readonly string[]);
export const MEMORY_SCOPES = new Set(vocab.memory_scopes as readonly string[]);
export const LIFECYCLE_PHASES = vocab.lifecycle_phases as readonly string[];
export const CLI_COMMANDS = new Set(vocab.cli_commands as readonly string[]);
export const TRUST_TIERS = vocab.trust_tiers as readonly string[];

export const EXPECTED_ROLE_TOTAL = Object.values(DEPARTMENT_EXPECTED_COUNTS).reduce((a, b) => a + b, 0);

/**
 * Levenshtein distance, capped. With 185 artifact kinds in the closed
 * vocabulary, a plain "not in vocabulary" error sends the author hunting
 * through a JSON file. Suggesting the nearest term turns a five-minute
 * lookup into a one-second fix, and authors will be doing this 220 times.
 */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length]!;
}

export function nearest(value: string, candidates: Iterable<string>, cap = 4): string | null {
  let best: string | null = null;
  let bestD = cap + 1;
  for (const c of candidates) {
    const d = distance(value, c, cap);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= cap ? best : null;
}

export function suggest(value: string, candidates: Iterable<string>): string {
  const n = nearest(value, candidates);
  return n ? ` Did you mean "${n}"?` : "";
}
