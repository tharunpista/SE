# Repository and local data boundaries

This repository is the portable source for the `se` role catalogue and CLI.
GitHub receives only files deliberately added and committed from this tree.
It does not receive files from a user's home directory just because the CLI
renders agents there.

## Commit and share

- `se/agents/`: canonical role definitions and reviewed role-catalogue data.
- `src/`, `schemas/`, `tests/`, and reviewed `docs/`: implementation, contracts,
  verification, and product documentation.
- `memory/README.md`: policy for local memory records.
- Curated knowledge intended for all users must be reviewed, scrubbed of
  personal or project-private details, and added as an explicit documentation
  or catalogue change.

## Keep local by default

- `memory/<project-id>/`: runtime records, manifests, pointers, and indexes.
- `.se/project.json`: this checkout's local project registration.
- `.se/state/`, `.se/cache/`, `.se/workspaces/`, and local database files.
- Rendered client files such as `.claude/agents/`, `.codex/agents/`,
  `.cursor/agents/`, `.github/agents/`, and `.agents/skills/`.
- Root `AGENTS.md` when it carries the generated marker, plus logs and local
  diagnostics.
- API keys, access tokens, credentials, `.env` files, and private keys.

The `.gitignore` rules prevent these paths from being added accidentally.
The generated host files can be recreated from the canonical role definitions
with the CLI. The user's global installations under their home directory are
outside this repository and are never included in a push.

## Before publishing

1. Run `git status --short` and review every changed and untracked path.
2. Confirm generated host directories, `.se/project.json`, logs, and raw
   `memory/` records are ignored.
3. Review staged content (`git diff --cached`) for secrets and private data.
4. Stage only the intended source, tests, schemas, and reviewed documentation.

Ignore rules are a safety net, not a substitute for reviewing the staged diff.
Git does not push untracked or unstaged files, and it never pushes local files
outside the repository. A commit is local until explicitly pushed to a remote.
