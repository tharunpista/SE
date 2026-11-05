# Minimal solution discipline

Adapted from the decision ladder in `DietrichGebert/ponytail` (MIT licensed).
Attribution and rationale are kept here, not split into a separate doc.

Before writing code, stop at the first rung that holds. The rungs are in
order; jumping to "write it" without having checked the earlier ones is the
defect this prevents, not a shortcut past it.

1. **Does this need to exist?** The cheapest code is the code the task does
   not actually require. State what breaks if it is not built.
2. **Already in this codebase?** Search before adding. A second
   implementation of an existing concept is a defect even while it works,
   because the two now have to agree forever.
3. **Does the standard library do it?** Before any dependency.
4. **Does a native platform feature do it?** The browser's own date picker,
   the database's own constraint, the OS's own primitive — before a library
   that reimplements it.
5. **Does an installed dependency already do it?** Check the lockfile first
   (`stack-discipline.md`). Never add a dependency to avoid writing ten lines.
6. **Can it be one line?** A wrapper earns its keep only if it is called from
   more than one place or crosses a boundary worth naming.
7. **Only then: the minimum that works.** Not the minimum that looks done —
   the minimum that handles its real inputs.

**Lazy about the solution, never about reading.** The ladder runs after the
code the change touches has been read and the real flow traced, not instead
of that reading. Picking rung 3 without having looked at rung 2 is a guess
wearing this discipline's clothes.

**Never on the chopping block, regardless of rung:** trust-boundary
validation, data-loss handling, security, accessibility, and anything this
role's own failure-modes list names. Smaller code, never fewer guarantees.

**Logic leaves a test behind.** A branch, a loop, a parser, or anything
touching money or security gets one small test — even a one-line
implementation, because a one-line regex is still a place a single wrong
character breaks silently and now has nothing watching it.

**State what you skipped.** Every handoff built under this ladder says which
rung it stopped at and names anything deliberately left unchecked. A smaller
diff that hides its own shortcuts is worse than a longer one that states them.
