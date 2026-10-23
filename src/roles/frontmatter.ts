import { Diagnostics } from "../util/diagnostics.ts";

export interface ParsedRoleFile {
  readonly file: string;
  /** Unvalidated frontmatter. Shape is unknown until the merged role is validated. */
  readonly frontmatter: Record<string, unknown>;
  /** Markdown body, trailing whitespace trimmed. */
  readonly body: string;
  /** 1-indexed line where the body starts, for diagnostics. */
  readonly bodyStartLine: number;
}

const DELIM = "---";

/**
 * Split YAML frontmatter from the Markdown body.
 *
 * Normalises CRLF first. A file authored on Windows otherwise leaves a
 * trailing \r on the closing delimiter, the delimiter fails to match, and
 * the resulting error points at the wrong line. That bug costs an afternoon
 * every time, so it is handled once, here.
 */
export function parseRoleFile(file: string, source: string, diags: Diagnostics): ParsedRoleFile | null {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  if (lines[0]?.trim() !== DELIM) {
    diags.error({
      code: "role/missing-frontmatter",
      file,
      message: "Role file must begin with a YAML frontmatter block.",
      hint: `Start the file with a line containing exactly "${DELIM}".`,
    });
    return null;
  }

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === DELIM) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    diags.error({
      code: "role/unterminated-frontmatter",
      file,
      message: "Frontmatter block is never closed.",
      hint: `Add a line containing exactly "${DELIM}" after the last key.`,
    });
    return null;
  }

  const yaml = lines.slice(1, close).join("\n");
  let parsed: unknown;
  try {
    parsed = yaml.trim() === "" ? {} : Bun.YAML.parse(yaml);
  } catch (err) {
    diags.error({
      code: "role/invalid-yaml",
      file,
      message: `Frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Check indentation; tabs are not valid YAML indentation.",
    });
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diags.error({
      code: "role/frontmatter-not-mapping",
      file,
      message: "Frontmatter must be a YAML mapping of keys to values.",
    });
    return null;
  }

  return {
    file,
    frontmatter: parsed as Record<string, unknown>,
    body: lines.slice(close + 1).join("\n").trim(),
    bodyStartLine: close + 2,
  };
}
