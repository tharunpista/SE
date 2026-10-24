/**
 * Local, provenance-preserving context assembly.
 *
 * Project files remain the source of truth and are never copied into memory.
 * `.se/sources.json` is an explicit allowlist. A context query scans only those
 * files, returns small line-bounded excerpts with a content hash, and merges
 * relevant memory records without allowing stale summaries to outrank source.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { findSecrets } from "./redact.ts";
import { type MemoryStore } from "./store.ts";
import type { MemoryRecord } from "./types.ts";

export const SOURCE_CATALOG_PATH = ".se/sources.json";
export const SOURCE_CATALOG_SCHEMA_VERSION = 1;
export const MAX_SOURCE_CATALOG_BYTES = 64 * 1024;
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;
export const MAX_SOURCE_COUNT = 128;
export const DEFAULT_CONTEXT_CHAR_BUDGET = 16_000;
export const MAX_CONTEXT_CHAR_BUDGET = 64_000;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "did", "do", "does", "for", "from", "how", "i", "in", "into", "is", "it", "me", "of", "on", "or", "our", "should", "that", "the", "their", "this", "to", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

export type SourceAuthority = "authoritative" | "reference";

export interface LocalFileSource {
  readonly id: string;
  readonly kind: "file";
  /** Repository-relative path; absolute paths and traversal are rejected. */
  readonly path: string;
  readonly purpose: string;
  readonly authority: SourceAuthority;
}

export interface SourceCatalog {
  readonly schema_version: 1;
  readonly sources: readonly LocalFileSource[];
}

export interface ContextExcerpt {
  readonly source_id: string;
  readonly path: string;
  readonly authority: SourceAuthority;
  readonly purpose: string;
  readonly hash: string;
  readonly lines: readonly [number, number];
  readonly lexical_score: number;
  readonly text: string;
}

export interface ContextMemory {
  readonly record_id: string;
  readonly revision: number;
  readonly status: MemoryRecord["status"];
  readonly scope: MemoryRecord["scope"];
  readonly trust_tier: MemoryRecord["trust_tier"];
  readonly stale_sources: readonly string[];
  readonly source_authority: "source-backed" | "memory-only" | "stale";
  readonly summary: string;
  readonly body?: string;
  readonly lexical_score: number;
}

export interface ContextPackage {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly query: string;
  readonly generated_at: string;
  readonly retrieval: {
    readonly method: "deterministic-lexical";
    readonly source_catalog: string;
    readonly max_chars: number;
    readonly returned_chars: number;
    readonly omitted_items: number;
  };
  readonly authority_rule: string;
  readonly sources: readonly ContextExcerpt[];
  readonly memories: readonly ContextMemory[];
  readonly warnings: readonly string[];
}

export class SourceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCatalogError";
  }
}

class SourceExcludedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceExcludedError";
  }
}

/** Read a bounded, stable UTF-8 snapshot from an already-resolved path. */
function readUtf8Bounded(path: string, maximumBytes: number, label: string): string {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new SourceCatalogError(`${label} must be a regular file.`);
    if (before.size > maximumBytes) throw new SourceCatalogError(`${label} exceeds the ${maximumBytes}-byte read limit.`);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    const after = fstatSync(fd);
    if (total > maximumBytes) throw new SourceCatalogError(`${label} grew beyond its ${maximumBytes}-byte read limit.`);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new SourceCatalogError(`${label} changed while it was being read; retry context assembly.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      throw new SourceCatalogError(`${label} is not valid UTF-8 text.`);
    }
  } finally {
    closeSync(fd);
  }
}

function safeRelativePath(value: unknown, sourceId: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    throw new SourceCatalogError(`Source "${sourceId}" path must be a non-empty repository-relative path using forward slashes.`);
  }
  const components = value.split("/");
  if (components.some((part) => part === "" || part === "." || part === "..")) {
    throw new SourceCatalogError(`Source "${sourceId}" path must not contain empty, ".", or ".." segments.`);
  }
  return value;
}

/** Load and validate an explicit source allowlist. No implicit whole-repo scan. */
export function readSourceCatalog(repoRoot: string): SourceCatalog {
  const catalogCandidate = resolve(repoRoot, SOURCE_CATALOG_PATH);
  if (!existsSync(catalogCandidate)) return { schema_version: 1, sources: [] };

  let catalogPath: string;
  let catalogText: string;
  try {
    catalogPath = assertContained(repoRoot, catalogCandidate, SOURCE_CATALOG_PATH);
    catalogText = readUtf8Bounded(catalogPath, MAX_SOURCE_CATALOG_BYTES, SOURCE_CATALOG_PATH);
  } catch (cause) {
    if (cause instanceof SourceCatalogError) throw cause;
    throw new SourceCatalogError(`Cannot inspect ${SOURCE_CATALOG_PATH}: ${(cause as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogText);
  } catch (cause) {
    throw new SourceCatalogError(`${SOURCE_CATALOG_PATH} is not valid JSON: ${(cause as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SourceCatalogError(`${SOURCE_CATALOG_PATH} must contain a JSON object.`);
  }
  const candidate = parsed as { schema_version?: unknown; sources?: unknown };
  if (candidate.schema_version !== SOURCE_CATALOG_SCHEMA_VERSION || !Array.isArray(candidate.sources)) {
    throw new SourceCatalogError(`${SOURCE_CATALOG_PATH} needs schema_version 1 and a sources array.`);
  }
  if (candidate.sources.length > MAX_SOURCE_COUNT) {
    throw new SourceCatalogError(`${SOURCE_CATALOG_PATH} contains more than ${MAX_SOURCE_COUNT} sources.`);
  }

  const ids = new Set<string>();
  const sources = candidate.sources.map((item, index): LocalFileSource => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SourceCatalogError(`Source entry ${index + 1} must be an object.`);
    }
    const raw = item as Record<string, unknown>;
    const id = raw.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new SourceCatalogError(`Source entry ${index + 1} has an invalid id; use lower-case letters, digits, and dashes.`);
    }
    if (ids.has(id)) throw new SourceCatalogError(`Duplicate source id "${id}" in ${SOURCE_CATALOG_PATH}.`);
    ids.add(id);
    if (raw.kind !== "file") throw new SourceCatalogError(`Source "${id}" has unsupported kind ${JSON.stringify(raw.kind)}; only local files are supported in this release.`);
    if (typeof raw.purpose !== "string" || !raw.purpose.trim() || raw.purpose.length > 500) {
      throw new SourceCatalogError(`Source "${id}" needs a short purpose (1–500 characters).`);
    }
    if (findSecrets(raw.purpose).length > 0) {
      throw new SourceCatalogError(`Source "${id}" purpose contains secret-shaped content; store credential references, never credential values.`);
    }
    if (raw.authority !== "authoritative" && raw.authority !== "reference") {
      throw new SourceCatalogError(`Source "${id}" authority must be "authoritative" or "reference".`);
    }
    return {
      id,
      kind: "file",
      path: safeRelativePath(raw.path, id),
      purpose: raw.purpose.trim(),
      authority: raw.authority,
    };
  });

  return { schema_version: 1, sources };
}

function tokenize(text: string): string[] {
  return [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((token) => !STOP_WORDS.has(token)))];
}

function countOccurrences(text: string, terms: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return terms.reduce((total, term) => total + (counts.get(term) ?? 0), 0);
}

function fileHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function assertContained(root: string, target: string, displayPath: string): string {
  const rootReal = realpathSync(root);
  const targetReal = realpathSync(target);
  const rel = relative(rootReal, targetReal);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SourceCatalogError(`Source path "${displayPath}" resolves outside the project root; symlink escapes are not allowed.`);
  }
  return targetReal;
}

/** Hash one explicit source path without permitting absolute paths or escape via symlinks. */
export function hashProjectSource(repoRoot: string, inputPath: string): { path: string; hash: string } {
  const catalogPath = inputPath.replace(/\\/g, "/");
  const path = safeRelativePath(catalogPath, "--source");
  const candidate = resolve(repoRoot, ...path.split("/"));
  if (!existsSync(candidate)) throw new Error(`Source "${path}" does not exist.`);
  const target = assertContained(repoRoot, candidate, path);
  const contents = readUtf8Bounded(target, MAX_SOURCE_FILE_BYTES, `Source "${path}"`);
  if (contents.includes("\u0000")) throw new Error(`Source "${path}" is not a UTF-8 text file.`);
  return { path, hash: fileHash(contents) };
}

function excerptFor(source: LocalFileSource, repoRoot: string, terms: readonly string[]): ContextExcerpt | null {
  const candidate = resolve(repoRoot, ...source.path.split("/"));
  // Check lexical containment as well as the real path; a symlink may escape.
  const lexical = relative(resolve(repoRoot), candidate);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new SourceCatalogError(`Source path "${source.path}" resolves outside the project root.`);
  }
  if (!existsSync(candidate)) return null;
  const target = assertContained(repoRoot, candidate, source.path);
  const stat = statSync(target);
  if (!stat.isFile()) throw new SourceCatalogError(`Source "${source.id}" is not a regular file.`);
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw new SourceCatalogError(`Source "${source.id}" is ${stat.size} bytes; the per-file limit is ${MAX_SOURCE_FILE_BYTES}. Split it into smaller explicit sources.`);
  }

  const contents = readUtf8Bounded(target, MAX_SOURCE_FILE_BYTES, `Source "${source.id}"`);
  if (contents.includes("\u0000")) throw new SourceExcludedError(`Source "${source.id}" appears to be binary; only UTF-8 text files are supported.`);
  const secretFindings = findSecrets(contents);
  if (secretFindings.length > 0) {
    throw new SourceExcludedError(`Source "${source.id}" contains secret-shaped content (${secretFindings.map((f) => f.rule).join(", ")}); it was not sent to context. Remove credentials and use environment references.`);
  }

  const lines = contents.replace(/\r\n?/g, "\n").split("\n");
  const scores = lines.map((line) => countOccurrences(line, terms));
  const hitLines = scores.flatMap((score, index) => score > 0 ? [index] : []);
  if (hitLines.length === 0) return null;

  // Keep source chunks bounded and joined so one query cannot dump a large file.
  const groups: { first: number; last: number; score: number }[] = [];
  for (const hit of hitLines) {
    const first = Math.max(0, hit - 2);
    const last = Math.min(lines.length - 1, hit + 2);
    const previous = groups.at(-1);
    if (previous && first <= previous.last + 1) {
      previous.last = Math.max(previous.last, last);
      previous.score += scores[hit]!;
    } else groups.push({ first, last, score: scores[hit]! });
  }
  groups.sort((a, b) => b.score - a.score || a.first - b.first);
  const best = groups[0]!;
  const text = lines.slice(best.first, best.last + 1).map((line, i) => `${best.first + i + 1}: ${line}`).join("\n");
  return {
    source_id: source.id,
    path: source.path,
    authority: source.authority,
    purpose: source.purpose,
    hash: fileHash(contents),
    lines: [best.first + 1, best.last + 1],
    lexical_score: best.score,
    text,
  };
}

function sourceFreshness(record: MemoryRecord, repoRoot: string): string[] {
  const stale: string[] = [];
  for (const ref of record.source_refs) {
    // Stored refs are untrusted data: reject absolute paths and traversal before reading.
    if (isAbsolute(ref.path) || /^[a-zA-Z]:/.test(ref.path) || ref.path.startsWith("//") || ref.path.split(/[\\/]/).some((part) => part === "..")) {
      stale.push(`${ref.path} (unsafe reference)`);
      continue;
    }
    const candidate = resolve(repoRoot, ref.path);
    if (!existsSync(candidate)) {
      stale.push(`${ref.path} (missing)`);
      continue;
    }
    try {
      const target = assertContained(repoRoot, candidate, ref.path);
      if (statSync(target).size > MAX_SOURCE_FILE_BYTES) {
        stale.push(`${ref.path} (too large to check)`);
      } else if (fileHash(readUtf8Bounded(target, MAX_SOURCE_FILE_BYTES, `Source reference "${ref.path}"`)) !== ref.hash) {
        stale.push(`${ref.path} (changed)`);
      }
    } catch {
      stale.push(`${ref.path} (unavailable)`);
    }
  }
  return stale;
}

/** Assemble a bounded retrieval package without mutating Tier 0 or copying source files. */
export function assembleContext(options: {
  readonly repoRoot: string;
  readonly projectId: string;
  readonly query: string;
  readonly store: MemoryStore;
  readonly maxChars?: number;
  readonly now?: () => Date;
}): ContextPackage {
  const query = options.query.trim();
  if (query.length < 2 || query.length > 2_000) throw new Error("Context query must be between 2 and 2,000 characters.");
  const terms = tokenize(query);
  if (terms.length === 0) throw new Error("Context query must contain at least one searchable word or identifier.");
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > MAX_CONTEXT_CHAR_BUDGET) {
    throw new Error(`--max-chars must be an integer between 500 and ${MAX_CONTEXT_CHAR_BUDGET}.`);
  }

  const catalog = readSourceCatalog(options.repoRoot);
  const warnings: string[] = [];
  if (catalog.sources.length === 0) warnings.push(`No explicit local sources configured. Add reviewed file entries to ${SOURCE_CATALOG_PATH}; memory retrieval still runs.`);
  const excerpts: ContextExcerpt[] = [];
  for (const source of catalog.sources) {
    try {
      const excerpt = excerptFor(source, options.repoRoot, terms);
      if (excerpt) excerpts.push(excerpt);
      else if (!existsSync(resolve(options.repoRoot, ...source.path.split("/")))) warnings.push(`Configured source is missing: ${source.path}`);
    } catch (cause) {
      if (cause instanceof SourceExcludedError) warnings.push(cause.message);
      else throw cause;
    }
  }
  excerpts.sort((a, b) => (a.authority === b.authority ? 0 : a.authority === "authoritative" ? -1 : 1) || b.lexical_score - a.lexical_score || a.path.localeCompare(b.path));

  const memories: ContextMemory[] = [];
  for (const id of options.store.listRecordIds()) {
    const record = options.store.get(id);
    if (!record || record.status !== "active") continue;
    const text = `${record.summary}\n${record.body ?? ""}`;
    const score = countOccurrences(text, terms);
    if (score === 0) continue;
    if (findSecrets(text).length > 0) {
      warnings.push(`Memory record "${id}" contains secret-shaped content and was excluded from context. Run memory doctor and remove or rotate exposed credentials.`);
      continue;
    }
    const staleSources = sourceFreshness(record, options.repoRoot);
    memories.push({
      record_id: record.record_id,
      revision: record.revision,
      status: record.status,
      scope: record.scope,
      trust_tier: record.trust_tier,
      stale_sources: staleSources,
      source_authority: staleSources.length > 0 ? "stale" : record.source_refs.length > 0 ? "source-backed" : "memory-only",
      summary: record.summary,
      ...(record.body === undefined ? {} : { body: record.body }),
      lexical_score: score,
    });
  }
  memories.sort((a, b) => b.lexical_score - a.lexical_score || (a.source_authority === b.source_authority ? 0 : a.source_authority === "source-backed" ? -1 : 1) || a.record_id.localeCompare(b.record_id));
  const baseWarnings = [...warnings];

  // Source evidence ranks before memory. Items are included whole; the final
  // serialized context package, including metadata, must fit the declared bound.
  const selectedSources: ContextExcerpt[] = [];
  const selectedMemories: ContextMemory[] = [];
  let returnedChars = 0;
  let omittedItems = 0;
  const items = [...excerpts.map((value) => ({ kind: "source" as const, value })), ...memories.map((value) => ({ kind: "memory" as const, value }))];
  for (const item of items) {
    if (item.kind === "source") selectedSources.push(item.value);
    else selectedMemories.push(item.value);
  }

  const makePackage = (): ContextPackage => ({
    schema_version: 1,
    project_id: options.projectId,
    query,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    retrieval: {
      method: "deterministic-lexical",
      source_catalog: SOURCE_CATALOG_PATH,
      max_chars: maxChars,
      returned_chars: returnedChars,
      omitted_items: omittedItems,
    },
    authority_rule: "Configured source excerpts are evidence from the current local file snapshot. The lexical score ranks query overlap; it is not a confidence or truth score. Memory is historical context; stale memory must not override live source. No match is not proof that a fact is absent.",
    sources: selectedSources,
    memories: selectedMemories,
    warnings,
  });

  let result = makePackage();
  for (;;) {
    warnings.length = 0;
    warnings.push(...baseWarnings);
    if (omittedItems > 0) warnings.push(`${omittedItems} relevant item(s) omitted to stay within the ${maxChars}-character output budget; raise --max-chars to include more.`);
    if (selectedSources.length === 0 && excerpts.length > 0) warnings.push("Matching source excerpts did not fit the context budget; no source was truncated.");
    result = makePackage();
    let actualChars = JSON.stringify(result).length;
    if (actualChars <= maxChars) {
      // The reported size is the serialized package size. Rebuild until the
      // digit count itself is stable, then enforce the exact compact JSON bound.
      for (let attempt = 0; attempt < 3; attempt++) {
        returnedChars = actualChars;
        result = makePackage();
        actualChars = JSON.stringify(result).length;
      }
      if (actualChars <= maxChars) return result;
    }
    if (selectedMemories.length === 0 && selectedSources.length === 0) {
      throw new Error("The context envelope exceeds --max-chars; shorten the query or raise the budget.");
    }
    // Source evidence has priority. Drop the least relevant memory first, then
    // the least relevant source, always as a complete item.
    if (selectedMemories.length > 0) selectedMemories.pop();
    else selectedSources.pop();
    omittedItems++;
  }
}

