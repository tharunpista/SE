# Using these roles in Claude Code

Claude Code reads subagents from `.claude/agents/`. It does not discover
`se/agents/`, so the roles must be rendered into that directory before they are
available.

This page covers rendering from inside the catalogue repository. To use the
roles from **other** projects, or to install them for every project at once, see
[`global-install.md`](global-install.md).

## Install

```bash
bun run src/cli.ts render --host claude-code
```

This writes the **starter roster** (11 roles) to `.claude/agents/`. Then restart
Claude Code, or run `/agents` to refresh — a running session does not pick up
new agent files on its own.

Verify:

```bash
bun run src/cli.ts render --host claude-code --dry-run
```

## Roster size and context cost

Every rendered role costs context in **every** session, used or not: Claude Code
loads each subagent's `description` at startup so it can route to them. Measured
on this catalogue:

| Roster | Roles | Always-loaded metadata |
|---|---|---|
| starter (default) | 11 | ~490 tokens |
| one department | varies | depends on the selected roles |
| entire catalogue | 191 | **~8,465 tokens** |

The adapter's configured budget is 9,000 estimated tokens, so the current full
roster fits. The estimate is a renderer-side budget check, not a guarantee about
Claude Code's actual tokenizer or available context. A smaller task-specific
roster can still make role selection clearer and reduce always-loaded metadata.

Render the roster you need:

```bash
# the leads, which is the right default
bun run src/cli.ts render --host claude-code

# add a department while working in it
bun run src/cli.ts render --host claude-code --dept backend-and-data

# an explicit set
bun run src/cli.ts render --host claude-code --roster frontend-lead,api-contract-owner

# all active roles (currently within the configured metadata budget)
bun run src/cli.ts render --host claude-code --all
```

## What is not committed, and why

`.claude/agents/` is in `.gitignore`. It is build output: the source of truth is
`se/agents/`, and committing the rendered copies invites edits in the wrong
place, which are then silently overwritten by the next render. Each rendered
file carries the role hash it came from so drift is detectable.

The practical consequence: **every clone has to run the render command.** There
is no state to migrate, only a command to run.

## What the renderer changes between source and rendered copy

- **Capabilities become host tools.** `write-files` becomes `Write, Edit`, and
  so on. Capabilities this project serves itself — `memory-read`,
  `memory-write`, `escalate`, `task-graph` — map to nothing, because rendering
  them as `Bash` would hand a role a shell it was never granted.
- **Write tools are withheld** from any role declaring `writes_files: false`,
  whatever its capability list says.
- **File writers get `isolation: worktree`**, so parallel writers cannot corrupt
  each other.
- **`max_calls` becomes `maxTurns`.** These are not the same quantity: a turn
  may contain several tool calls, so the rendered limit is *looser* than the
  declared budget. Treat it as a backstop, not as the budget being enforced.
- **Acceptance tests are stripped.** They are criteria for judging the role, not
  instructions for doing the work, and shipping them invites the agent to grade
  itself against the tests meant to grade it independently. They stay in
  `se/agents/`, which is what the evaluation harness reads.

## Keeping the rendered roster current

A rendered file is stale as soon as its role file changes. Re-run the render
command after editing any role, and restart or `/agents` to pick it up. The
`--dry-run` output lists what would change without writing anything.
