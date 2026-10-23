/**
 * Part XI / Part XX 79. Secret detection on the write path.
 *
 * This module decides whether content may be persisted. It is deliberately
 * biased towards refusal: a false positive costs an agent one rejected write
 * with a named reason, while a false negative writes a live credential into a
 * durable store that is designed never to hard-delete anything.
 *
 * It does not own the patterns in the sense of being their authority -- the
 * Secrets Management Engineer role owns what counts as a secret -- but the
 * store enforces the rejection here, so the check cannot be skipped by an agent
 * that would rather not run it.
 */

export interface SecretFinding {
  /** Which rule matched, for a message a human can act on. */
  readonly rule: string;
  /** Never the secret itself. A rejection message must not leak the value. */
  readonly excerpt: string;
}

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Patterns for credentials whose shape is unambiguous. Each is anchored on a
 * recognisable prefix or structure rather than on entropy alone, because an
 * entropy threshold on prose produces constant false positives on hashes, which
 * this store writes legitimately in every source reference.
 */
const RULES: readonly Rule[] = [
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "stripe-secret-key", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/i },
  { name: "url-embedded-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{4,}@/i },
  {
    name: "assigned-secret",
    // `password = "..."`, `api_secret: '...'`, `token=...` with a value that is
    // not an obvious placeholder.
    pattern:
      /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?(?!(?:\s*$|<|\$\{|\{\{|x{3,}|\*{3,}|redacted|placeholder|example|changeme|your[_-]|none\b|null\b|true\b|false\b))[^\s"',;]{8,}/i,
  },
];

/**
 * Placeholders that look like assignments but carry no secret. Kept separate
 * from the rules so that loosening this list is a visible, reviewable change
 * rather than a quiet weakening of a regex.
 */
const PLACEHOLDER = /^(?:x+|\*+|\.+|-+|redacted|placeholder|example|sample|dummy|changeme|todo|fixme|your[_-]?\w*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i;

function excerptFor(match: string): string {
  // Report the rule and a shape, never the value. Showing even a prefix of a
  // live credential in a log is a smaller leak, not a safe one.
  const head = match.slice(0, Math.min(4, match.length));
  return `${head}${"*".repeat(Math.max(0, Math.min(match.length - 4, 8)))} (${match.length} chars)`;
}

/** Every rule that matches. All findings are reported, not just the first. */
export function findSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(content);
    if (!match) continue;

    if (rule.name === "assigned-secret") {
      const value = match[0].split(/[:=]/).slice(1).join("=").trim().replace(/^["']|["']$/g, "");
      if (PLACEHOLDER.test(value)) continue;
    }

    findings.push({ rule: rule.name, excerpt: excerptFor(match[0]) });
  }
  return findings;
}

export function containsSecret(content: string): boolean {
  return findSecrets(content).length > 0;
}
