# SE

SE is an open-source catalogue of software engineering roles with a Bun-based
CLI that validates the catalogue and renders selected roles into supported
coding-agent clients. The repository also contains the first version of a
project-scoped local memory store.

**Current scope:** this is a CLI and local library. A localhost dashboard, a
background service, hosted team memory, and automatic task-aware memory
retrieval are not implemented yet. The memory CLI supports project identity,
versioned local records, explicit source allowlists, and query-based bounded
context assembly for local repository files.

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
| `src/roles/` | Role loading, schema validation, ownership checks, topics, roster closure |
| `src/render/` | Client-specific agent and skill renderers, and the request router |
| `src/memory/` | Project identity, versioned records, writes, and diagnostics |
| `src/install.ts` | User-level CLI installation |
| `se/agents/<department>/` | Canonical, reviewed role definitions; edit these as the source of truth |
| `schemas/` | Role, vocabulary, and topic contracts |
| `tests/` | Unit, integration, and memory-store tests |
| `docs/` | Installation, architecture, data-boundary, and memory documentation |
| `.se/project.json` | Stable project ID metadata shared across clones; contains no runtime records |
| `.se/sources.json` | Reviewed allowlist of project files eligible for local context retrieval |
| `memory/` | Optional checkout-local runtime store; ignored by Git |

Generated files under client folders such as `.claude/agents/` and
`.codex/agents/` are outputs. They are ignored by Git and can be regenerated
from `se/agents/` with the CLI. User-level installations live under the user's
configuration directory and do not belong to this repository.

## Choosing roles: topics

A department is where a role reports. A topic is the job someone arrives with,
and the two are different axes. Authentication is owned by roles in three
departments, so no department selection reaches that set from the word
"login".

```sh
se topics                                  # 18 topics, with the keywords each answers to
se topics --topic auth                     # its roles and their departments
se render --host claude-code --topic auth  # install them
```

Rendering a roster also emits routing skills: one per topic, carrying the
words an operator actually types, plus `se-route`, which classifies a request
before anything executes it. A request that names an outcome with no
constraints — "build me a website" — is routed to `requirements-engineer`
rather than to an implementer, because it contains no implementation decision
yet. Both are generated from `se/agents/` and `schemas/topics.json`, so they
cannot describe a roster other than the one installed.

Selecting a department or a topic also installs the roles it escalates to.
A roster whose escalation targets are missing is one where stuck work has no
receiver.

## Project memory

Each repository has a stable project ID in `.se/project.json`. Private memory
is stored under `~/.se/memory/<project-id>/` by default. On Windows, `~` means
the user's home directory. To keep runtime memory beside one checkout, run
`se memory init --local`; records remain ignored by Git in either location.

```sh
se memory brief                 # identity, namespace, and every record: a session's first turn
se memory recall [topic]        # live records, newest first, with source freshness
se memory remember "<summary>"  # write one record; revision and hashes are resolved for you
se memory status
se memory doctor
se memory list
se memory get <record-id>
se memory sources
se memory context --query "the task and relevant project area"
```

`remember` computes the parts a caller should not have to assemble — the live
revision, a content hash per `--source`, the record id, the lifecycle phase —
and enforces the same gates as the explicit `put --file` form. A project-scope
record requires evidence, and says which flag supplies it:

```sh
se memory remember "we chose Stripe over Adyen" \
  --type architecture-decision --source src/cart.ts --evidence "bun test:0"
```

A record carries a hash of each source file as it was when written, so
`recall` marks a record `STALE` once that file changes. The live source always
wins over a summary about it.

Every memory command reports which project it resolved and warns when a
namespace is shared by unrelated directories — two projects with the same
`package.json` name would otherwise read and write one store silently.

The context command reads only the files listed in `.se/sources.json`, returns
small source excerpts with paths, line numbers, and hashes, and adds matching
memory notes with freshness and trust metadata. It does not scan or copy the
whole repository. See [context retrieval policy](docs/memory/README.md#context-retrieval).

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
