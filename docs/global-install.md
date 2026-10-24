# Using the catalogue from any project

## Install for a new user

Share the **whole repository** (Git clone or ZIP), not a single agent file. The
repository contains the role source, renderers, and CLI needed to create the
client-specific definitions. Each person installs it once for their own OS user;
global definitions are personal files on that machine, not something shared by
copying them into another person's project.

On Windows, after installing [Bun](https://bun.sh), run this in PowerShell or
the VS Code integrated terminal:

```powershell
git clone <repository-url> se-org
Set-Location .\se-org
bun.cmd install
bun.cmd run src/cli.ts setup --add-path
```

`setup` registers the catalogue, installs the `se` command, and renders the
starter roster into every supported global client folder. `--add-path` adds the
CLI shim directory to that user's PATH; open a new terminal afterward. If PATH
is not needed, omit that option and run future commands as
`bun.cmd run src/cli.ts ...` from the repository.

Claude Code supports separate configuration profiles through
`CLAUDE_CONFIG_DIR`. `se` now follows that variable for both Claude agents and
skills; run setup from an environment with the same variable when using a
non-default profile. Without it, Claude's global paths are under `~/.claude/`.

The renderer also follows `CODEX_HOME` for Codex, `GEMINI_CLI_HOME` for Gemini
CLI, and `OPENCODE_CONFIG_DIR` (or `XDG_CONFIG_HOME`) for OpenCode. Run setup
from the shell/environment used to launch those clients so it writes to the
same profile directories they read.

For macOS or Linux, use the same steps with `bun install` and
`bun run src/cli.ts setup --add-path`.

Check installation and update it after pulling catalogue changes:

```powershell
se agents status
git pull
se agents enable
```

Each client loads its own native global agent location and exposes the agents
through its own picker or mention menu; there is no cross-client picker. A
client must support local custom agents or skills to discover a definition.
When a client is not installed on the machine, its output can still be rendered,
but it cannot be selected there. This project currently ships adapters for
Claude Code, Codex, Cursor, VS Code/Copilot, Gemini CLI, Antigravity, OpenCode,
and portable Agent Skills. Skills are not delegated subagents.

Uninstall only this catalogue's generated definitions with:

```powershell
se agents disable
```

This leaves hand-written files alone. It does not uninstall the clients or remove
the `se` CLI; those are separate user choices.

The roles live in one repository. Nothing is copied into the projects that use
them automatically. The catalogue remains the source of truth, but host files
are generated copies; rerun `se agents enable` after editing or updating roles.

## Install and register the CLI

Run this from the catalogue checkout:

```powershell
Set-Location C:\path\to\se-org
bun.cmd run src/cli.ts install --add-path
```

On macOS or Linux, use `bun run src/cli.ts install --add-path`. This command
registers the catalogue and writes launchers into a user bin directory. Open a
new terminal after changing PATH. To skip PATH setup, omit `--add-path` and keep
running the CLI through `bun run src/cli.ts ...` from the checkout.

Verify from another project or directory:

```bash
se link --show
```

## Change the registered catalogue

```bash
se link --path /path/to/se-org
```

`se install` already registers the checkout from which it runs. Use `se link`
when switching to a different checkout or repairing registration. It writes
`~/.se/config.json` with the catalogue path. Every later command resolves the
catalogue in this order:

1. `SE_CATALOGUE` — an operator saying so for one invocation.
2. Walking up from the working directory — you are inside the catalogue repo.
3. `~/.se/config.json` — registered by `se link`.

Nothing is copied. `se link --show` reports what is registered and whether the
path still holds a catalogue.

## Three roots, deliberately separate

Conflating any two of these is a silent bug once the CLI is global:

| Root | What it is | How it is found |
|---|---|---|
| catalogue root | where role definitions live | `SE_CATALOGUE`, cwd ancestry, `~/.se/config.json` |
| project root | the project being worked on | nearest ancestor with `package.json` or `.git` |
| user-level host dir | definitions applying to every project | per host, e.g. `~/.claude/agents` |

Output is anchored on the **project** root, not the catalogue. Anchoring on the
catalogue would write one project's agents into the catalogue repository, and
project memory likewise. When you are working inside the catalogue repo the two
coincide, which is why the bug is easy to miss.

## Memory, globally

Memory is resolved in two independent parts: **which project** it belongs to,
and **where the store lives**. Conflating them is how a store silently appears
empty.

### Which project — the namespace

Resolved in order: `--project`, `SE_PROJECT`, committed `.se/project.json`, the
git remote, `package.json#name`. If none of those answer, the command
**refuses** rather than guessing (Part XX 23).

The directory name is deliberately never used. Renaming a folder would start a
new, empty memory and orphan everything written before it, with no error.

```bash
se memory init              # pin the id in .se/project.json; commit it
```

### Where the store lives — the placement

Resolved in order: `--memory-root`, `SE_MEMORY_ROOT`, `<project>/memory/` if
that directory exists, otherwise the user-level store at `~/.se/memory/`.

| Placement | Path | Shared? |
|---|---|---|
| global (default) | `~/.se/memory/<project-id>/` | private to this user; not shared |
| repo-local (opt in) | `<project>/memory/<project-id>/` | private to this checkout; ignored by Git |

Global is the default because a globally installed CLI is used across many
projects, and a tool that writes an uncommitted `memory/` directory into every
repository it touches is worse than one that keeps personal state in one place.

A project opts in to checkout-local placement by **having the directory**:

```bash
se memory init --local      # creates ./memory and a local ignore rule
```

That keeps existing repo-local stores working and makes the placement visible
in the file tree. The command adds a marked ignore block to `memory/.gitignore`
without replacing existing rules; commit that file if future clones should get
the same protection. It does not share or commit the records. Already tracked
records remain tracked until removed from the Git index. Review and explicitly
curate any information before sharing it; raw memory is never a team-sync format.

Either way the store is namespaced by project id, so the placement changes *who
can see* the memory and never *which project it belongs to*. Two projects in the
global store never cross-retrieve, even with identical record ids:

```
~/.se/memory/project-a/records/...
~/.se/memory/project-b/records/...
```

`se memory status` reports the project identity and the selected placement.

For personal work across many projects, use the global store. Repo-local mode is
useful when memory must stay beside one checkout, but its records remain private
and ignored by Git. Multi-user sharing belongs in the separately secured hosted
Memory Layer 4; it must not be implemented by committing raw local records.


## Render roles for a host

### One global switch for supported clients

After registering the catalogue, install the starter roster into each client’s
native user-level agent or skill directory:

```powershell
se agents enable
se agents status
```

This covers adapters with an explicit global directory (Claude Code, Codex,
Cursor, VS Code/Copilot, Gemini CLI, Antigravity, OpenCode, and portable Agent
Skills). The clients keep separate formats and directories; this command
renders the same selected roster to each. Restart or refresh the clients, then
select the role in that client's agent picker/mention UI. A project-specific
agent with the same name may take precedence over its global copy.

The default is the 11-role starter roster. Select specific roles with
`se agents enable --roster backend-lead,frontend-lead`, or the full active
catalogue with `se agents enable --all --force`. Full catalogues may exceed a
client's always-loaded metadata budget; `--force` makes that cost an explicit
choice. Install one client at a time with `--host codex` (replace `codex` with
the adapter id). Disable all installed catalogue definitions with
`se agents disable`, or only one client's with `se agents disable --host codex`.
Disable removes only files carrying this renderer's generated marker; it leaves
hand-written files alone. There is no shared UI switch across clients: each
client owns its own picker, and `enable`/`disable` controls whether this
catalogue's definitions appear there.

Each client has its own discovery format and workspace root. Run the renderer
from the target repository (or pass `--project <repo>`); these are generated
files, so a fresh clone must render them locally. `git pull` does not generate
or install host agent files.

By default, rendering replaces the generated roster for that host and removes
generated role files no longer selected. To refresh one role while preserving
the rest of the generated roster, pass `--merge`, for example
`se render --host codex --roster memory-systems-engineer --merge`.

### Windows PowerShell

On Windows, use `bun.cmd` in PowerShell. If `bun` resolves to `bun.ps1` and the
PowerShell execution policy blocks scripts, `bun run ...` fails before this
project's CLI starts. `bun.cmd` selects Bun's command shim:

```powershell
Set-Location C:\path\to\se-org
bun.cmd run src/cli.ts render --host claude-code
bun.cmd run src/cli.ts render --host codex
```

After rendering, check the workspace root and discovered roster with:

```powershell
bun.cmd run src/cli.ts where --host claude-code
bun.cmd run src/cli.ts where --host codex
```

### Portable role skills

The open Agent Skills format provides reusable, on-demand role instructions to
several clients from one shared layout. Render both locations for broad
coverage:

```powershell
bun.cmd run src/cli.ts render --host agent-skills  # .agents/skills/<role>/SKILL.md
bun.cmd run src/cli.ts render --host claude-skills # .claude/skills/<role>/SKILL.md
```

The shared `.agents/skills/` location is read by Codex, Copilot, Cursor,
Gemini CLI, and OpenCode. Claude Code uses `.claude/skills/`. These are skills,
not subagents: they load role instructions into the current agent but do not
create an isolated worker or enforce tool permissions. Keep the native agent
renderers below when delegation or host-specific controls are needed.

### Claude Code

Globally, for every project:

```bash
se render --host claude-code --global   # -> ~/.claude/agents
```

Or per project, which overrides the global copy of the same name:

```bash
cd /path/to/your-project
se render --host claude-code            # starter roster -> ./.claude/agents
se render --host claude-code --dept frontend
```

`--global` charges the roster's always-loaded cost to **every** session in every
project, including ones these roles have nothing to do with:

| Roster | Roles | Always-loaded, per session |
|---|---|---|
| starter | 11 | ~669 tokens |
| one department + starter | 18–33 | ~1,100–2,000 tokens |
| entire catalogue | 152 | ~10,487 tokens |

A project-level render of the same name overrides the global one, so a global
starter roster plus a per-project department is a reasonable arrangement.

Restart Claude Code, or run `/agents`, after any render.

### Codex — native custom subagents

```bash
cd /path/to/your-project
se render --host codex                  # -> ./.codex/agents/*.toml
se render --host agents-md              # -> ./AGENTS.md routing index
```

Codex reads `AGENTS.md` as repository guidance and loads custom subagents from
`.codex/agents/*.toml`. The native adapter renders selected roles as actual
custom agents. The separate `agents-md` adapter is a routing index only; it
does not create delegated subagents.

The Codex IDE extension uses the same project-scoped `.codex/agents/` location
as Codex CLI; there is no separate IDE renderer. To make the agents available
in the IDE:

1. Open the repository that should use the agents as the IDE workspace. The
   generated files must be inside that repository's `.codex/agents/` directory.
2. Trust the repository when Codex asks. Codex skips project-scoped `.codex/`
   configuration for an untrusted project.
3. From that repository root, run `se render --host codex` (or
   `bun run src/cli.ts render --host codex` when working in this catalogue).
4. Start a new Codex IDE session so it discovers the project agent files.

The generated `.codex/agents/` directory is intentionally git-ignored. A fresh
clone must render the agents locally; `git pull` does not download them.
Verify the project location and roster with `se where --host codex`.

Codex custom agents inherit the parent session's tools, provider and sandbox.
Role capability declarations are therefore guidance, not a security boundary.
The renderer reports that limitation.

### VS Code and GitHub Copilot

```bash
cd /path/to/your-project
se render --host copilot               # -> ./.github/agents/*.agent.md
se render --host copilot --global      # -> ~/.copilot/agents
```

These workspace custom agents appear in VS Code's agent picker for supported
harnesses. Select the intended harness (Copilot, Claude, or Codex) in the
session target UI; choosing a model does not choose the harness. Tool aliases
and enforcement differ by harness, so the generated capability list is not a
security boundary. Use VS Code's Chat Customizations Diagnostics if an agent
does not appear.

### Cursor — native subagents

```bash
cd /path/to/your-project
se render --host cursor                  # -> ./.cursor/agents/*.md
```

Cursor can load project subagents from `.cursor/agents/`. The native adapter
uses Cursor's supported Markdown frontmatter and marks non-writers read-only.
Role capability declarations do not replace the parent session's permissions.

### Google Antigravity — native custom agents

```bash
cd /path/to/your-project
se render --host antigravity           # -> ./.agents/agents/*.md
```

Antigravity discovers workspace agents from `.agents/agents/` and global agents
from `~/.gemini/config/agents/`. Definitions are selectable in `/agents` and
can be invoked as subagents. The adapter maps only known tool names and keeps
shell access away from roles marked as non-writers; host sandbox settings still
apply.

### Gemini CLI

```bash
cd /path/to/your-project
se render --host gemini-cli           # -> ./.gemini/agents/*.md
```

Gemini CLI custom subagents use Markdown frontmatter in `.gemini/agents/`;
this is separate from the Antigravity `.agents/agents/` integration. Use
`/agents list` to inspect discovery and `@<agent-name>` to invoke a role.

### OpenCode

```bash
cd /path/to/your-project
se render --host opencode             # -> ./.opencode/agents/*.md
se render --host opencode --global    # -> ~/.config/opencode/agents
```

OpenCode loads project agents from `.opencode/agents/`; invoke them using the
`@` agent mention. The rendered profiles use subagent mode. OpenCode permissions
and the active session remain authoritative; role capability lists do not
replace the host's security controls.

### Other `AGENTS.md` readers

For hosts that read one instruction file but do not support custom subagents,
render a bounded routing index with `se render --host agents-md`. It tells the
host how to locate a role; it does not create selectable agents or enforce
role-specific tools. A shared Markdown instruction file is not a universal
agent loader: clients that require their own project format need their native
adapter above.

## What each host actually enforces

The renderer does not pretend a host provides something it does not:

| | Claude Code | Codex | Copilot / VS Code | Cursor | OpenCode | Gemini CLI | Antigravity | AGENTS.md |
|---|---|---|---|---|---|
| per-role selection | yes | yes | yes | yes | yes | yes | yes | no; routing index only |
| tool restriction | host tools | **none**; parent permissions apply | mapped aliases; harness-specific | read-only flag only | read-only edit deny; shell asks | mapped tools; parent policy applies | mapped tools + sandbox | **none** |
| workspace isolation for file writers | yes, `isolation: worktree` | **none** | **none** | **none** | **none** | **none** | **none** | **none** |
| call budget | `maxTurns` | none | none | none | none | `max_turns` | none | none |

`se render` reports the unenforced cases rather than leaving them to be
discovered.
