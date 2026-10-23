import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Diagnostics } from "../util/diagnostics.ts";
import { layerPaths, posix, repoRelative } from "../util/paths.ts";
import { parseRoleFile } from "./frontmatter.ts";
import { validateRole } from "./validate.ts";
import type { LayerName, Role } from "./types.ts";
import { LAYER_ORDER } from "./types.ts";

interface LayerEntry {
  readonly layer: LayerName;
  readonly file: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

function walkMarkdown(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // A missing override layer is normal, not an error.
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // Raced deletion; nothing to validate.
    }
    if (st.isDirectory()) out.push(...walkMarkdown(full));
    else if (extname(name) === ".md" && !name.startsWith("_") && basename(name) !== "README.md") {
      out.push(full);
    }
  }
  return out;
}

function loadLayer(root: string, layer: LayerName, dir: string, diags: Diagnostics): LayerEntry[] {
  const out: LayerEntry[] = [];
  for (const abs of walkMarkdown(dir)) {
    const rel = repoRelative(root, abs);

    // A builtin role lives at se/agents/<department>/<id>.md. Anything
    // directly in se/agents/ is not a role -- that is where the generated
    // inventory and ownership matrix live, and scanning them as roles
    // produced spurious "missing frontmatter" errors. Making the rule
    // structural rather than a filename blocklist also means a new
    // generated file cannot reintroduce the bug.
    const relToLayer = posix(abs.slice(dir.length).replace(/^[\\/]+/, ""));
    const segments = relToLayer.split("/");
    if (layer === "builtin" && segments.length < 2) continue;
    const parsed = parseRoleFile(rel, readFileSync(abs, "utf8"), diags);
    if (!parsed) continue;

    const id = parsed.frontmatter["id"];
    if (typeof id !== "string" || id.length === 0) {
      diags.error({
        code: "role/missing-id", file: rel, key: "id",
        message: "Every role file must declare an id, including an override patch.",
        hint: "The id is how layers are matched; without it the patch cannot be applied to anything.",
      });
      continue;
    }

    // The filename must match the id. Not cosmetic: when 220 files are
    // listed in a directory, a mismatch means the file you open is not the
    // role you are debugging.
    const expected = `${id}.md`;
    if (basename(abs) !== expected) {
      diags.error({
        code: "role/filename-id-mismatch", file: rel, key: "id",
        message: `File is named "${basename(abs)}" but declares id "${id}".`,
        hint: `Rename the file to "${expected}", or correct the id.`,
      });
    }

    // The directory name must match the declared department. Free integrity
    // check: it catches a role filed in the wrong department, which would
    // otherwise show up only as two confusing department-count errors at
    // opposite ends of the report.
    if (layer === "builtin") {
      const dirDepartment = segments[0];
      const declared = parsed.frontmatter["department"];
      if (typeof declared === "string" && dirDepartment !== declared) {
        diags.error({
          code: "role/department-directory-mismatch", file: rel, key: "department",
          message: `File is in "${dirDepartment}/" but declares department "${declared}".`,
          hint: `Move the file to se/agents/${declared}/, or correct the department.`,
        });
      }
    }

    out.push({ layer, file: rel, frontmatter: parsed.frontmatter, body: parsed.body });
  }
  return out;
}

/** Keys whose list values a higher layer appends to rather than replaces. */
const APPENDABLE = new Set(["collaborators", "activation", "tools", "contributes_artifacts"]);

function mergeFrontmatter(
  entries: readonly LayerEntry[],
  provenance: Record<string, LayerName>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.frontmatter)) {
      if (value === null) {
        // Explicit null clears an inherited value. Without this there is no
        // way for a local layer to remove something the builtin layer set.
        delete merged[key];
        provenance[key] = entry.layer;
        continue;
      }
      if (
        APPENDABLE.has(key) &&
        Array.isArray(value) &&
        Array.isArray(merged[key]) &&
        entry.layer !== "builtin"
      ) {
        const base = merged[key] as unknown[];
        merged[key] = [...base, ...value.filter((v) => !base.includes(v))];
      } else {
        merged[key] = value;
      }
      provenance[key] = entry.layer;
    }
  }
  return merged;
}

/**
 * Content hash over the normalised definition (Part XVII 63).
 *
 * Deliberately excludes `file` and `provenance`: moving a role between
 * layers must not invalidate the evaluation measured against its content.
 * Keys are sorted so the hash is stable regardless of authoring order.
 */
function hashRole(role: Omit<Role, "provenance" | "hash">): string {
  const { file: _file, ...rest } = role;
  const normalised = JSON.stringify(rest, Object.keys(rest).sort());
  return new Bun.CryptoHasher("sha256").update(normalised).digest("hex").slice(0, 16);
}

export interface Registry {
  /** Every resolved role, including disabled and deprecated, sorted by id. */
  readonly all: readonly Role[];
  readonly byId: ReadonlyMap<string, Role>;
  readonly diagnostics: Diagnostics;
}

export function resolveRoles(root: string): Registry {
  const diags = new Diagnostics();
  const paths = layerPaths(root);
  const dirs: Record<LayerName, string> = {
    builtin: paths.builtin,
    user: paths.userOverrides,
    project: paths.projectRoles,
  };

  // Collect per layer, in precedence order.
  const byIdEntries = new Map<string, LayerEntry[]>();
  for (const layer of LAYER_ORDER) {
    const seenInLayer = new Map<string, string>();
    for (const entry of loadLayer(root, layer, dirs[layer], diags)) {
      const id = entry.frontmatter["id"] as string;

      // Two files claiming one id inside the same layer is unresolvable:
      // precedence between them is arbitrary, so refuse rather than pick.
      const prior = seenInLayer.get(id);
      if (prior !== undefined) {
        diags.error({
          code: "role/duplicate-id", file: entry.file, key: "id",
          message: `Role id "${id}" is already declared by ${prior} in the same layer.`,
          hint: "Ids must be unique per layer. Precedence between two files in one layer is undefined, so this is refused rather than resolved arbitrarily.",
        });
        continue;
      }
      seenInLayer.set(id, entry.file);

      const list = byIdEntries.get(id);
      if (list) list.push(entry);
      else byIdEntries.set(id, [entry]);
    }
  }

  const roles: Role[] = [];
  for (const [id, entries] of byIdEntries) {
    const provenance: Record<string, LayerName> = {};
    const merged = mergeFrontmatter(entries, provenance);

    // Body comes from the highest layer that supplied a non-empty one, so a
    // frontmatter-only patch keeps the shipped prose instead of blanking it.
    let body = "";
    let file = entries[entries.length - 1]!.file;
    for (const entry of entries) {
      if (entry.body.trim().length > 0) {
        body = entry.body;
        file = entry.file;
      }
    }

    const base = validateRole(file, merged, body, diags);
    if (!base) continue;

    if (base.id !== id) {
      diags.error({
        code: "role/id-changed-by-override", file, key: "id",
        message: `An override layer changed the id from "${id}" to "${base.id}".`,
        hint: "Ids are the identity of a role across layers and must never be overridden. Create a new role instead.",
      });
      continue;
    }

    roles.push({ ...base, provenance, hash: hashRole(base) });
  }

  roles.sort((a, b) => a.id.localeCompare(b.id));
  return { all: roles, byId: new Map(roles.map((r) => [r.id, r])), diagnostics: diags };
}

export { posix };
