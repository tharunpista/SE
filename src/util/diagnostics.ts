/**
 * Diagnostics carry enough locality to be actionable across 220 role files.
 * A validator that says "invalid role" is useless at this scale; every
 * diagnostic names the file, the key, and a stable machine-readable code so
 * CI output can be grepped and suppressions can be audited.
 */

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable, greppable identifier. Never reworded once published. */
  readonly code: string;
  /** Repo-relative, forward-slashed. Absent for whole-catalogue findings. */
  readonly file?: string;
  /** Frontmatter key path, e.g. "memory_scopes.write". */
  readonly key?: string;
  readonly message: string;
  /** What the author should do. Omitted only when the message is already the fix. */
  readonly hint?: string;
}

export class Diagnostics {
  readonly #items: Diagnostic[] = [];

  error(d: Omit<Diagnostic, "severity">): void {
    this.#items.push({ ...d, severity: "error" });
  }

  warn(d: Omit<Diagnostic, "severity">): void {
    this.#items.push({ ...d, severity: "warning" });
  }

  absorb(other: Diagnostics): void {
    this.#items.push(...other.items);
  }

  get items(): readonly Diagnostic[] {
    return this.#items;
  }

  get errorCount(): number {
    return this.#items.filter((d) => d.severity === "error").length;
  }

  get warningCount(): number {
    return this.#items.filter((d) => d.severity === "warning").length;
  }

  get ok(): boolean {
    return this.errorCount === 0;
  }

  /**
   * Deterministic ordering. Unstable diagnostic order makes CI logs
   * undiffable between runs, which is how real regressions get missed.
   */
  sorted(): Diagnostic[] {
    const rank = (s: Severity) => (s === "error" ? 0 : 1);
    return [...this.#items].sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.key ?? "").localeCompare(b.key ?? "") ||
        a.code.localeCompare(b.code),
    );
  }

  format(opts: { color?: boolean } = {}): string {
    const c = opts.color ?? false;
    const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s);
    const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[0m` : s);
    const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[0m` : s);

    return this.sorted()
      .map((d) => {
        const label = d.severity === "error" ? red("error") : yellow("warning");
        const loc = d.file ? `${d.file}${d.key ? `:${d.key}` : ""}` : "catalogue";
        const head = `${label} ${dim(`[${d.code}]`)} ${loc}`;
        const hint = d.hint ? `\n        ${dim(`fix: ${d.hint}`)}` : "";
        return `${head}\n        ${d.message}${hint}`;
      })
      .join("\n");
  }
}
