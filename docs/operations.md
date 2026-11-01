# Operations

This page is for the person running the controller. It covers reading what percheron
writes, the knobs that bound a run, what the different ways a node can stop mean, and the
problems people hit.

## Reading the log

Every line is `[percheron HH:MM:SS] <node>: <event>`. The events you will see, in the order
a node usually meets them:

| Line | Meaning |
|---|---|
| `dispatched <step> (<role>) round N` | A task was created on the adapter |
| `<step> exited <exit> (N artifact(s))` | The agent's final message was collected |
| `check <step> started (N command(s))` | A check began in the worktree; the tick did not wait |
| `check <step> PASS` or `FAIL` | All commands exited 0, or one did not |
| `check <step> failed on N failing test(s) outside this node's diff: ...; re-running (1/1)` | The step has `retryUnrelated` and the named failures are another slice's; the command runs again before any round is spent |
| `dispatched <judge> (<role>, rubrics <ids>) round N` | A judge task was created; read-only, scoring the rubric |
| `judged <judge>: <rubric>: K/N criteria met, mean M` | The typed verdict was recorded; `no verdict` means the task failed or wrote nothing usable. Either way the node moves on |
| `parked at <gate>: <summary>` | The node is waiting on a human |
| `gate <gate> cleared by observed fact` | The observer saw the fact the gate waited for; the evidence is in the `gate-cleared` event |
| `gate <gate> REJECTED by human: <reason>` | `percheron reject` was run |
| `DONE` | The node routed to `node-done` |
| `ESCALATED: <why>` | The node is terminal until a human reopens it |
| `REOPENED by human: <reason>` | `percheron reopen` was run |
| `not ready (<codes>)` | The provider says the node cannot start yet |
| `preflight BLOCKING [<code>] <detail>` | The run refused to start |

Lines without a node prefix are about the run: the graph size, spec warnings, and the
settle summary at the end.

## Reading the ledger

`.percheron/ledger-<name>.json` has two parts.

`nodes` is a map from node key to pipeline state: the current step, `round` and the
per-edge `rounds`, `hops`, `generation`, `spend`, the active task or parallel group tasks,
`parked` with the gate and the time, `refs` such as the branch and the last recorded
failure, and `terminal` once the node is done or escalated. `lifetimeHops` accumulates
hops from earlier generations after a reopen.

`events` is append-only, one record per thing that happened, each with an ISO timestamp.
Kinds: `dispatched`, `exited`, `check`, `gate-parked`, `gate-cleared`, `gate-rejected`,
`guard-exceeded`, `escalated`, `reopened`. A `check` event carries a one-line detail per
command with its exit code and duration, plus the first line of the failure excerpt and
the path of the full output when a check failed.

`percheron status --json` prints both parts together with the settle summary, which is
usually easier than opening the file.

## Reading the evidence

Under `.percheron/evidence/<key>/`, one directory per agent task, named by role and the
first eight characters of the task id. The implementer leaves `evidenceMap.md`, a table
from invariant or scenario id to the test that covers it, and `continuationNote.md`, a
paragraph for whoever picks the work up. The reviewer and critic each leave `findings.md`,
one line per finding with a severity and a citation, or the single line `NO FINDINGS`
followed by what was checked.

`checks/` holds the full output of every failing check, named by step, generation and
round, with the command and exit code at the top. The log and the retry's feedback carry
only an excerpt. When a check's output names a `build/test-results` directory, or gradle's
HTML report path, the excerpt begins with one `FAILED <class>.<test>: <message>` line per
failing test read from the JUnit XML, even when the runner itself printed nothing but
"12 tests completed, 1 failed".

## The knobs

**Guards** live under `pipeline.guards` and bound one traversal of the pipeline.

- `maxRounds` is per loop-back edge. A route from a step to an earlier step, or to itself,
  is a loop-back, and each such edge is counted on its own. `maxRounds: 3` means that edge
  may be taken three times; the fourth attempt escalates the node and the guard event names
  the edge. Separate counting is why a formatting slip caught by `validate` does not use up
  a round meant for critique findings.
- `maxHops` is the total number of step transitions in one traversal. It is a runaway
  detector, not a tuning knob. Set it above the longest legitimate path including every
  permitted round.

Both restart when a human reopens the node. Spend does not.

**Budgets** live under `policy.budgets`.

- `perNode.usd` is checked at dispatch. A step is not dispatched when the node has already
  spent that much, and the headroom that remains is passed to the task as its own ceiling.
  A task that exits `done` is never killed for having overshot; the next dispatch is where
  the guard bites.
- `perNode.dispatchFloorUsd` treats thin headroom as exhausted, so a node is not sent a
  task that dies on its first call.
- `perTask.usd`, `perTask.maxTurns`, `perTask.wallClock` are enforced by the adapter. For
  the local adapter they become `--max-budget-usd`, `--max-turns`, and a deadline after
  which the process is killed. Hitting one is reported as a `failed` exit with a named
  violation, which the retry receives as feedback.

**Concurrency** is `scheduling.maxConcurrent`: the number of nodes that may be live and
unparked at once. A node counts from the tick it enters the pipeline, one tick before its
first task exists. Parked nodes do not count. Within a node, a parallel group dispatches
all its members at once.

**Re-runs** are `retryUnrelated` on a check step. A test suite shared by many slices fails
for reasons that are nobody's: a test container that did not come up in time, a port in use.
With `retryUnrelated: 1`, a failure whose named tests all lie outside the node's diff is run
once more before it costs an implement round. The first attempt's output is still filed as
evidence with a `-try1` suffix. A failure that names no test, names a test in a package the
node changed, or is a lint failure, is never re-run.

**Dispatch** requires every `dependsOn` node to be done, the provider to report the node
ready, no provider hold on the node, and a free slot. A held node is never dispatched; the
reason is shown in `run --plan`.

## What a node's end states mean

**DONE.** The node routed to `node-done`, which in the usual pipeline means the human gate
cleared. The provider's state is whatever `onGateCleared` names.

**Parked.** Waiting for a human. The run settles with parked nodes still parked and exits
0. Start it again after merging; the observer picks the merge up within one poll.

**ESCALATED.** Terminal until a person acts. Three causes: a guard tripped, a step routed
to `escalate`, or a human rejected a gate. The reason is in the log, the `escalated` event
and the `guard-exceeded` event if there was one. The provider's state is `onEscalate`.

An escalation is the designed outcome for something no retry will fix: a spec gap, a rule
that two slices disagree about, a decision only the project owner can make. Read the
continuation note and the findings, decide, write the decision down where the next agent
will read it, then `reopen` with the decision as feedback.

**Held.** Not an end state but looks like one: the node never starts because the provider
holds it, for example because an upstream slice lies outside this engagement. Fix the
cause in the provider's world, or accept that this run will not build it.

## Reopen and reject

Both are run with the controller stopped.

`percheron reopen <spec> <node> --reason "<why>" [--feedback "<note>" | --clear-feedback]`
takes an escalated node back to the entry step in a new generation. Rounds and hops start
at zero. By default the last recorded failure rides along as feedback; `--feedback`
replaces it with your note, prefixed "human note:"; `--clear-feedback` removes it. The
provider's state moves to `onReopen` first so a provider hold does not refuse the dispatch.
The reason is recorded in the event log.

`percheron reject <spec> <node> --reason "<why>" [--feedback "<note>"]` refuses a parked
gate. The gate's `failed` route runs, usually `escalate`. A note is recorded the same way,
so a following `reopen` carries it to the implementer.

## Workspace confinement

Every agent task runs in the node's worktree. Two layers keep it there, and neither is a
request in the prompt. First, the adapter passes deny rules for every top-level entry of the
main checkout except its own state directory, so file tools and the file commands Claude
Code recognizes are refused outside the worktree. Second, the main checkout's `git status`
is snapshotted at dispatch and swept at collection; anything new is moved to
`.percheron/quarantine/<task>/`, the checkout is restored, and the task exits `failed` with
the escape named. Read-only roles get only `Read`, `Grep` and `Glob`.

Expect some permission denials in agent output. Reviewers in particular try to `cd` into the
main checkout to diff against it. That is the harness doing its job.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `preflight: N blocking issue(s)` | em's foundation check found a shared event missing from the code | Build the foundation first; percheron refuses fan-out by design |
| `em provider: ... schema ... not supported` | em is newer or older than the provider's pins | Check `em --version` against the `tools` block; upgrade one side |
| A node never dispatches, log says `not ready (...)` | The provider's readiness check fails | Run the provider's own command, for em `em validate <model> --slice-ready <key>`, and fix what it names |
| A node shows `HELD(...)` in the plan | Provider hold | Resolve it in the provider's world; percheron will not override a hold |
| Gate never clears after merging | The observer compares against `main`; the merge went elsewhere, or the branch was rebased | Merge into `main` in the main checkout; the branch tip must be an ancestor of `main` |
| `git worktree add` fails on dispatch | A worktree or branch with that name already exists | Remove the stale worktree, or set `branchPrefix` so names do not collide |
| Task exits failed with `indeterminate` | The `claude` process died without a parseable result | Read `.percheron/tasks/<id>/stdout.json`; reopen or let the retry run |
| Every validate takes a quarter of an hour | Cold compile and a full suite per worktree | Share a build cache across worktrees, or add a cheaper check before the full suite |
| Agent output full of permission denials | Confinement | Normal. Only a quarantine entry means something actually escaped |
| `percheron: ... is not parked` / `is not escalated` | reopen and reject apply to specific states | Check `status`; reject needs a parked node, reopen an escalated one |
| Validate fails on a test in another slice's package | A shared test container or port, not this node's code | Set `retryUnrelated: 1` on the check; the implementer otherwise gets the failure as feedback and can declare done without changes |
| Feedback says `KtLint found code style violations` with a path | ktlint writes findings to a report file | Nothing to do: the `KTLINT file:line:col` lines above it are read from that file |
| `a controller for <name> is already running (pid N)` | A second `run` on the same engagement, or a controller you thought was gone | `percheron stop`, or `percheron status` to see the pid |
