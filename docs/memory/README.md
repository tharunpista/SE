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
