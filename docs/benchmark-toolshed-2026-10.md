# Benchmark: percheron on toolshed, October 2026

This is the one real run so far, written up so the numbers and the lessons are public. The
target was toolshed, an event-modeled Kotlin and Axon Framework 5 project with 88 slices in
its model and a constitution that every slice must follow. The full pipeline ran from a
real spec: implement, validate, review and critique in parallel, then a human merge gate.
Roles were a sonnet implementer, a sonnet reviewer and an opus critic, all through the
local Claude Code adapter.

## Scope

Of the 88 slices, 18 were already shipped and 16 were ready to implement. Five of the 16
were excluded because their `impl/<key>` branches collided with branches left by a paused
earlier tool that derived branch names from the same model. That left 11 slices over four
dependency levels, with one provider hold: a slice whose upstream lay outside the
engagement, which percheron correctly never dispatched.

Settings: three nodes at a time, budgets of 14 dollars per node and 7 per task, 120 turns
and 25 minutes per task, `maxRounds` 2 raised to 3 during the run, `maxHops` 14 raised to
16. The human at the merge gate was the operator, standing in for the project owner, who
ruled on the two design questions the run raised.

## Result

Two sessions on the same day.

The first session merged 3 slices and escalated 2, both automations, for the same reason: a
design gap in the project that no implementer was allowed to close. Five slices sat behind
the escalations, correctly. 32 tasks, 15.56 dollars, two hours and four minutes.

The project owner then ruled on the gap and the rule went into the project's constitution.
Both escalated nodes were reopened with the ruling as feedback, and the second session
merged all 7 remaining slices with no escalations. 32 tasks, 16.63 dollars, two hours and
thirty-five minutes.

| | |
|---|---|
| Slices merged | 10 of 11 (the eleventh held by the provider, correctly) |
| Agent tasks | 64 |
| Cost | 32.19 dollars, about 3.22 per merged slice including review and critique |
| Controller time | 4 hours 39 minutes across both sessions |
| Workspace escapes | 0, with 27 denied attempts |
| Budget, turn or time limits hit | 0 |
| Final state of the target's main branch | Green: full lint and test run exited 0 |

Per role, first session:

| Role | Tasks | done / failed | Cost | Average cost | Average wall time |
|---|---|---|---|---|---|
| implementer (sonnet) | 14 | 14 / 0 | 6.17 | 0.44 | 87 s |
| reviewer (sonnet) | 9 | 9 / 0 | 2.60 | 0.29 | 26 s |
| critic (opus) | 9 | 3 / 6 | 6.79 | 0.75 | 74 s |

## What the run showed

**Scheduling without level barriers works, and verification is the whole clock.** A
level-one node was dispatched while two level-zero validations were still running; the
dependency edges and the provider's readiness check gated everything, levels gated nothing.
But every full verification in a fresh worktree took 13 to 16 minutes, a cold compile plus
over 700 tests with a test container. Fourteen validations added up to more than three
hours of build time inside a two-hour run. Agents averaged under a minute and a half. The
harness is bounded by the project's verification cost, not by model latency. A shared build
cache, or a cheaper check tier before the full suite, is the obvious next lever.

**The critic earned its model.** Six of nine critic verdicts in the first session were
`failed`. Zero of nine reviewer verdicts were. Every findings loop was triggered by the
opus critic alone, on code the sonnet reviewer had read and passed. One was a real
idempotency blocker, fixed in a single 46-second round. The others were the same major
twice: an automation reading a projection fed by a different event processor, so a wake-up
could run before the list had caught up. The implementers offered a bounded wait; the critic
refused it twice, and was right. A bounded wait is still a race. Independence as structure,
meaning a different model, fresh context and withheld sibling output, produced disagreement
every time it mattered.

**Escalation did what it is for.** The processor race was a project design question, not a
coding error. The implementers said so in their continuation notes, mitigated within their
bounds, and the critic kept refusing the mitigation. Both nodes escalated with the evidence
attached. The owner's ruling became a constitution amendment, the nodes were reopened with
it as feedback, and both merged. Later in the same session an implementer on a different
slice applied the new rule unprompted, building the binding point its downstream automation
would need. A rule written at 18:50 was being applied by a different agent on a different
slice by 20:38.

**The critic caught the operator too.** The first version of the ruling relied on
registration order between two handler components, which holds in Axon's test fixture but
not in its Spring integration. The critic flagged that nothing ordered the beans. The
implementer's fix was a timing guess. Reading the framework's bytecode confirmed the critic:
the Spring extension collects handlers into a set before building processors, so no order
survives. The ruling was clarified to a shape that needs no ordering. Until then the only
way to say no at a parked gate was to let it wait forever, so `percheron reject` was built
that evening.

**Loop feedback must name the failure.** The first retry after a failed validation received
the last thirty lines of a 900-second build: shutdown logs and "6 failed". It learned
nothing and recovered only by reading the test results itself. The excerpt was rewritten to
keep lines that carry failure signatures and drop framework log noise, then rewritten again
when a warning storm buried the one real assertion. Under `gradle --quiet` even that was not
enough, because quiet mode suppresses per-test lines; reading the JUnit XML fixed it after
the run.

**Confinement held.** Thirty-two tasks, no file written outside a worktree. The deny rules
did the work; the sweep had nothing to quarantine. Reviewers trying to `cd` into the main
checkout to diff against it were refused and read the worktree instead.

## What it changed in percheron

During the run: asynchronous check steps, after a 13-minute validation froze the tick loop
and left two finished implementers uncollected; the failure excerpt; `percheron reopen`
with generations in the idempotency key; `percheron status`; hops restarting per generation
after a reopened node died on its first transition for hops spent in earlier generations.

After the run: `percheron reject`; `maxRounds` counted per loop-back edge, after one node
died at the limit on a formatting slip right after a real fix; JUnit XML reading and full
check output filed as evidence; `branchPrefix` on the em provider so two tools on one model
stop colliding.

## The rerun

The five slices the first run lost to the branch collision were run on their own the next
day, on the same spec plus `branchPrefix: percheron/`. Five nodes, one level, three at a
time, the same budgets and guards.

| | |
|---|---|
| Wall clock | 84 minutes |
| Agent spend | $10.65, between $1.46 and $3.26 per node |
| Done / escalated | 5 / 0 |
| First validate on the slice code | 5 of 5 passed |
| Retry rounds | 5 across two nodes, none on the other three |
| Human gate decisions | 5 merges, 1 rejection |

The branch fix did what it was built for. The first dispatch created `percheron/<key>`
branches beside the paused rig's `impl/<key>` branches and never touched them, and the real
branch name was written back to em's ledger.

Every kind of finding the loop met, it closed without a human touching code. A critic rated
a missing per-event log line as a constitution violation, the join failed the node, and the
implementer fixed it and three minors in one 42-second round. A validate failure that was
really another slice's test container timing out came back as feedback naming that test, and
the implementer read it, said so, changed nothing, and declared done; the re-check passed. A
formatting slip after a fix came back as a ktlint failure, and the implementer read the
report in its own worktree and fixed the one line. At one gate the human rejected a node
whose critic had rated the same logging gap as minor that another critic had rated major;
`percheron reject` sent it back and the fix landed in 15 seconds.

The rerun also found two defects in the first ten minutes, one in the adapter and one in
how the operator ran it. The adapter matched the agent's closing `{"exit": ...}` with a
regex that could not cross a brace, so a summary that mentioned `/api/neighbors/{id}/account`
hid an honest done and cost a retry round. It now parses the declaration as JSON. And the
operator stopped the controller with a tool that kills the whole process tree, which took a
detached agent nine minutes into its work with it; the adapter reported the death honestly
and the retry recovered the committed work in 30 seconds. The controller is now stopped
with a plain kill of its own process, and a stop command that does only that is on the list.

Two follow-ups came out of it. A check cannot yet tell a flake from a failure, so a container
timeout in another slice's test costs a retry round. And ktlint's report is named in the
feedback but not read, the same gap the JUnit reader closed for tests.

## What it did not show

Sixteen nodes across two runs is not hundreds. The scheduling and resume properties held at this size with
dependencies; the hypothesis that they hold at the size of a whole event model is still a
hypothesis. One project, one language, one provider, one adapter. The pipeline shape was
fixed; nothing was learned about judge steps, which do not exist yet, or about more than
one human clearing gates at once.
