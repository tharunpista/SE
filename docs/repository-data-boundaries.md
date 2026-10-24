# Repository and local data boundaries

This repository is the portable source for the `se` role catalogue and CLI.
GitHub receives only files deliberately added and committed from this tree.
It does not receive files from a user's home directory just because the CLI
renders agents there.

## Commit and share

- `se/agents/`: canonical role definitions and reviewed role-catalogue data.
- `src/`, `schemas/`, `tests/`, and reviewed `docs/`: implementation, contracts,
  verification, and product documentation.
- `.se/project.json`: stable, non-secret project identity (`id`, `label`, and
  identity origin) shared across clones. It contains no memory records or
  machine-specific paths.
- `docs/memory/README.md`: policy for local memory records.
- Curated knowledge intended for all users must be reviewed, scrubbed of
  personal or project-private details, and added as an explicit documentation
  or catalogue change.

## Keep local by default

- `<project>/memory/<project-id>/` and `~/.se/memory/<project-id>/`: private runtime
  records, manifests, pointers, and indexes. Neither is shared through Git.
- `.se/state/`, `.se/cache/`, `.se/workspaces/`, and local database files.
- Rendered client files such as `.claude/agents/`, `.codex/agents/`,
  `.cursor/agents/`, `.github/agents/`, and `.agents/skills/`.
- Root `AGENTS.md` when it carries the generated marker, plus logs and local
  diagnostics.
- API keys, access tokens, credentials, `.env` files, and private keys.

`se memory init --local` creates a checkout-local `memory/.gitignore` rule for
runtime records. Commit that ignore file to preserve the protection in future
clones. This cannot untrack records that were already committed. This
repository's root `.gitignore` separately excludes its own `/memory/` directory.
The generated host files can be recreated from the canonical role definitions
with the CLI. The user's global installations under their home directory are
outside this repository and are never included in a push.

## Before publishing

1. Run `git status --short` and review every changed and untracked path.
2. Confirm generated host directories, logs, and raw `memory/` records are
   ignored. Review `.se/project.json` as stable project identity metadata.
3. Review staged content (`git diff --cached`) for secrets and private data.
4. Stage only the intended source, tests, schemas, and reviewed documentation.

Ignore rules are a safety net, not a substitute for reviewing the staged diff.
Git does not push untracked or unstaged files, and it never pushes local files
outside the repository. A commit is local until explicitly pushed to a remote.
