# Attempt counting and the two-strike rule

Canonical definition. Referenced by every role that can get stuck, and by the
renderer, so there is exactly one threshold and one unit in the system.

This document exists because the rule was previously stated three different
ways — "third consecutive failed fix", "two failed attempts", "third attempt"
— with three different units. A rule that cannot be counted the same way twice
cannot be implemented or tested, and in practice it becomes whatever the agent
feels like.

## The unit

**One attempt** is: one change, by one owner, intended to resolve one root
cause, whose outcome was determined by running the role's declared
verification command.

That definition has four load-bearing parts:

- **One change.** Editing three files in one go is one attempt. Trying a
  different approach afterwards is a second.
- **By one owner.** The counter belongs to the task, not the agent, so
  reassigning the work does not reset it. Otherwise a handoff becomes a way
  to buy two more attempts.
- **Intended to resolve one root cause.** A fix for a *different*, newly
  discovered cause starts its own counter. See the anti-gaming rule below.
- **Determined by running the verification command.** An attempt that was
  never verified does not count as succeeded. It counts as failed, because an
  unverified change is indistinguishable from a broken one.

**Not an attempt**: reading code, searching, reproducing, adding logging or
instrumentation, or asking a question. Investigation is free and should be.
Only a change whose purpose was to fix something counts.

## The threshold

**After the second failed attempt on one root cause, stop.**

Do not make a third. Hand over to the role named in
`escalates_on_failure_to`.

Two failed attempts mean the model of the problem is wrong. A third attempt
from the same wrong model is not persistence, it is a coin flip with a cost,
and the cost compounds because each failed attempt also has to be reverted or
reasoned around.

So the budget is: **two attempts, then a handover.** Not three, not "a few".

## Counter identity and reset

The counter is keyed on `(task_id, root_cause_id)`.

It resets **only** when:

1. The root cause investigator returns a diagnosis. The owner then gets a
   fresh budget of two attempts against the *diagnosed* cause.
2. The task's acceptance criteria change, which makes it a different task.

It does **not** reset when:

- The work is reassigned to another owner.
- The session ends and a new one resumes the task.
- The owner decides the cause is different without evidence. This is the
  anti-gaming rule and it matters: relabelling the hypothesis is the obvious
  way to get unlimited attempts, and it is the thing an agent under pressure
  will reach for. A new `root_cause_id` requires **evidence** that the
  previous cause was ruled out, recorded with the attempt.

## What the counter must be stored in

The attempt counter is execution state, so it belongs in the run journal, not
project memory. It must survive a session ending, because the most common way
this rule gets bypassed is a fresh session starting the count again on a task
that has already consumed its budget.

Minimum recorded per attempt: `task_id`, `root_cause_id`, `owner`, the change
reference, the verification command, its exit code, and the observation.

## Interaction with other counters

These are deliberately separate and must not be conflated:

| Counter | Threshold | Owner |
|---|---|---|
| Failed attempts on one root cause | 2, then hand over | The role doing the work |
| Falsified hypotheses during one investigation | 3, then report inconclusive | `root-cause-investigator` |
| Total attempts on one task, across causes | 5, then escalate to the operator | `chief-orchestrator` |
| Delegation depth | 3, then complete or escalate | `chief-orchestrator` |

The third row is the backstop. Without it, a task could consume unlimited
budget by legitimately discovering a new cause each time — each individual
step reasonable, the aggregate absurd. At five total attempts the task is
reported to the operator as needing a decision, not another attempt.

## Why this is cheap to get right and expensive to get wrong

A loose rule produces the single most expensive agent failure mode: a long,
confident sequence of plausible fixes against a wrong model, each one adding
change that has to be understood by whoever cleans up. Counting is trivial.
Deciding not to count is what costs.
