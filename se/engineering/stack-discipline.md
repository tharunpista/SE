# Stack discipline

Directive only; rationale in `docs/engineering/stack-discipline-rationale.md`.

**Never write an API call from memory.** Recall picks *what*; installed code
gives name, signature, options, return.

**Pin first:** manifest → **lockfile** (truth: `^5.2` vs `5.4.1`) → runtime
version → build/test config. Later contradiction = defect, not judgement.

**Verify:** read installed types, or find a call site in *this* repo. Assume
uncertain if: recent major, options object, async, overloaded, or near-identical
sibling name.

**Repo beats ecosystem.** Pattern wrong? Escalate. Never add a second convention.

**Never invent a dependency.** Adding one is an escalation. An import absent
from the lockfile fails at install time on someone else's machine.

**Unsure → say so.** A marked guess is useful; an unmarked one is the failure
this prevents.

**Verify version on:** major renames/removals · render & data-loading models ·
build/bundler config · ORM transactions & relations · date/time/money (never
float currency, never naive local time) · auth & crypto (stale API = vuln) ·
test-runner assertions & mocks.

**Report versions verified against.**
