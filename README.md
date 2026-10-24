# SE

SE is an open-source catalogue of software engineering roles with a Bun-based
CLI that validates the catalogue and renders selected roles into supported
coding-agent clients. The repository also contains the first version of a
project-scoped local memory store.

**Current scope:** this is a CLI and local library. A localhost dashboard, a
background service, hosted team memory, and automatic task-aware memory
retrieval are not implemented yet. The memory CLI currently supports project
status, integrity checks, listing, reading, and writing records.

## Get started

Requirements: Git and Bun `>=1.3.3`.

```sh
bun install
bun run check
bun run src/cli.ts help
```

For a global installation and client setup, see
[Using the catalogue from any project](docs/global-install.md).

## Repository map

| Path | Purpose |
|---|---|
| `src/cli.ts` | CLI entry point and command routing |
| `src/roles/` | Role loading, schema validation, and ownership checks |
| `src/render/` | Client-specific agent and skill renderers |
| `src/memory/` | Project identity, versioned records, writes, and diagnostics |
| `src/install.ts` | User-level CLI installation |
| `se/agents/<department>/` | Canonical, reviewed role definitions; edit these as the source of truth |
| `schemas/` | Role and vocabulary contracts |
| `tests/` | Unit, integration, and memory-store tests |
| `docs/` | Installation, architecture, data-boundary, and memory documentation |
| `.se/project.json` | Stable project ID metadata shared across clones; contains no runtime records |
| `memory/` | Optional checkout-local runtime store; ignored by Git |

Generated files under client folders such as `.claude/agents/` and
`.codex/agents/` are outputs. They are ignored by Git and can be regenerated
from `se/agents/` with the CLI. User-level installations live under the user's
configuration directory and do not belong to this repository.

## Project memory

Each repository has a stable project ID in `.se/project.json`. Private memory
is stored under `~/.se/memory/<project-id>/` by default. On Windows, `~` means
the user's home directory. To keep runtime memory beside one checkout, run
`se memory init --local`; records remain ignored by Git in either location.

```sh
se memory status
se memory doctor
se memory list
se memory get <record-id>
```

Raw memory records are private runtime data. Do not commit or upload them. To
share knowledge, curate it into reviewed documentation or role definitions.
See [the memory data policy](docs/memory/README.md) and
[the repository data boundaries](docs/repository-data-boundaries.md).

## Contributing

Edit canonical role definitions in `se/agents/`, implementation in `src/`,
contracts in `schemas/`, and tests in `tests/`. Regenerate the catalogue
inventory and ownership matrix with `bun run gen`. Run `bun run check` before
submitting changes. Do not hand-edit rendered client files or generated
catalogue files.
