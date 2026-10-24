# Memory data policy

The implementation and schemas live in `src/memory/` and `schemas/`.
Documentation lives under `docs/memory/`. Runtime memory is data, not source.

The global store is `~/.se/memory/<project-id>/` (under `%USERPROFILE%\.se`
on Windows). Repo-local mode uses
`<project>/memory/<project-id>/` when explicitly selected. `se memory init
--local` writes a `memory/.gitignore` rule in that checkout so runtime records
are excluded from Git; commit that ignore file if the protection should travel
to other clones. Both locations can contain private context, decisions, and
derived indexes. Never force-add or upload a raw store. Existing records that
were already tracked remain tracked until explicitly removed from the index.

Each project ID is pinned in its committed `.se/project.json`; that file holds
only stable identity metadata, not records or machine-specific paths. To share
knowledge, curate and sanitize it into reviewed documentation or role
definitions. Multi-user live memory requires a separately secured service.

## Context retrieval

Agents need a bounded answer to “what is this project and which files matter
for this task?” without asking a model to read the whole checkout. The local
CLI assembles that answer from two separate stores:

- `.se/sources.json` is a reviewed, shareable allowlist of local files and why
  they are relevant. It contains paths and metadata, never file contents or
  credentials.
- The Tier 0 project store holds durable, versioned decisions and outcomes under
  `~/.se/memory/<project-id>/` by default. It is private to the user account.

Configure exact repository-relative files in `.se/sources.json`:

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "project-overview",
      "kind": "file",
      "path": "README.md",
      "purpose": "Product goal, current scope, and repository map.",
      "authority": "authoritative"
    }
  ]
}
```

Then ask for only the context needed for the current task:

```powershell
se memory sources
se memory context --query "where project identity is resolved and stored"
se memory context --query "change login session expiry" --max-chars 12000
```

The current adapter supports local UTF-8 files only. It does not scan the whole
repository or connect to APIs, databases, or cloud storage. Each selected
excerpt carries its path, line range, file hash, declared authority, and lexical
relevance score. Matching memory records are included with their scope, trust
tier, revision, and source freshness. Authoritative files take priority over
historical notes. This is deterministic lexical matching, not semantic search;
synonyms can be missed, so phrase queries with the names and terms used by the
project.

Source contents are read locally for matching and are not copied into the
memory store or persisted as an index. A file with secret-shaped content is
excluded as a whole. Keep credentials out of the allowlist and use secret
manager or environment references in documentation. The output budget limits
the serialized package; source excerpts and records are omitted whole rather
than silently truncated. Local file access does not use model tokens, but the
context returned to an agent does consume its context window and may be billed
by its provider.
