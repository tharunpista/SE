# OSE (Open Source Everything) — v0 Build Spec

Status: **draft, pending operator review.** Nothing in this repo is built yet.
This file is the single source of truth for what v0 is. If a decision here
turns out wrong, this file gets corrected before any code changes — the code
never silently drifts from what's written here.

## What this is

A standalone CLI tool, written in Node.js/TypeScript, that wraps the
operator's existing coding-agent subscription (Claude Code first) to make it
behave like a more honest, more useful senior engineer:

1. It does not trust an agent's own claim that something works — it can
   independently re-run the real checks and report the real result.
2. It can read an existing codebase and report what's actually there — flaws,
   gaps, a next-steps list — on command, not as a side effect of every task.
3. It never auto-reruns anything in the background. Every capability is an
   explicit command the operator chooses to pay tokens for.

This is **not** an IDE. The IDE is explicitly deferred — v0 proves the CLI
agent idea works before any editor/UI work starts.

This is **not** the SE project. SE (`%USERPROFILE%\SE`) stays untouched as
a reference of what over-engineering looks like: ~191 roles, an unused
orchestrator, an unused memory subsystem, too many tokens for too little
payoff. OSE starts from a deliberately small surface and only grows once
each piece is proven.

## Non-negotiable constraints

- **Token usage must not exceed what the operator would spend doing the same
  task in plain Claude Code with no tool on top.** OSE is leverage, not
  overhead. Every added layer must earn its token cost.
- **No automatic background re-execution of anything.** Verification and
  analysis are commands the operator explicitly runs, never something OSE
  decides to do on its own to "be helpful."
- **No self-reported success taken at face value.** When the operator asks
  for verification, the answer comes from a real command's real exit code —
  never from re-reading what the agent said it did.
- **No extra code, no extra words.** Output — both code OSE's wrapped agent
  writes and OSE's own CLI code — should be exactly what the task needs, no
  speculative abstraction, no filler.
- **Cross-platform, stack-agnostic.** OSE does not analyze or care what
  language/framework the target project uses — it shells out and reads exit
  codes. It must run the same way on Windows/macOS/Linux.
- **Proving ground:** `%USERPROFILE%\nba-research-mvp` is the first real
  project OSE is tested against. Not nba-specific logic — just the first
  real codebase used to prove the three commands below actually work on
  something real, including the known gaps already identified there (missing
  odds/Stripe credentials, needed legal review) as a test of whether `ose
  analyze` finds real things rather than rubber-stamping.

## v0 commands (and only these three)

### `ose run --project <path> "<task>"`
Shells out to the operator's existing Claude Code CLI, with the task and the
target project path, to do the actual work. Does not verify or analyze
anything on its own — that's what the other two commands are for.

### `ose analyze --project <path>`
Reads the target codebase and reports, in plain terms: what's actually there,
what's missing or fragile, and a short prioritized next-steps list. Run only
when the operator asks — not bundled into `run`.

### `ose verify --project <path> [--check <command>]`
Independently runs the project's own real check command(s) (tests, typecheck,
build — whatever `--check` names, or a small project-level config if one
exists) and reports the real exit code and output. This is the
anti-hallucination mechanism: whatever an agent claimed earlier counts for
nothing until this command confirms it against reality.

## What v0 explicitly does NOT include

- No IDE/editor UI (deferred until the CLI is proven).
- No support for agents other than Claude Code yet (Codex/others come later,
  once this works for one).
- No payments, email, SMS/calling integrations, or any "entire owned
  product" feature — those are the long-term vision, not v0.
- No automatic background verification loop.
- No multi-stack-specific logic — OSE stays agnostic by design, not by
  accident.
- No subscription/licensing/billing system yet — open-sourcing and any
  paid-tier model come after v0 is proven to actually work.

## Open questions / not yet decided

- Exact shape of the one shared "rules" context OSE injects when it shells
  out to Claude Code (format, length, what goes in it).
- Exact output format for `ose analyze`'s report (plain text report file?
  terminal only? both?).
- Whether `--check` commands are passed on the command line each time, or
  read from a small per-project config file, or both.
- Distribution plan (npm package name, how `ose` ends up on PATH) — deferred
  until v0 itself works locally.

## Why this document exists

The operator has twice started a build by over-scoping (SE's 191-role
catalogue; the first draft of this very conversation, which drifted toward
"standalone CLI + IDE platform" before being pulled back). This file exists
so that doesn't happen a third time inside OSE itself: any assistant or agent
working on this project reads this file first, and any change to scope gets
written here before it gets written in code.
