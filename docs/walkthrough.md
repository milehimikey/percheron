# Walkthrough: your first engagement

This page takes one real repository from nothing to a running engagement, then through a
merge gate, an escalation, and a restart. It uses the em provider, because that is the one
that exists. Commands are shown as you would type them.

## Before you start

You need four things installed and working:

1. **Node.js.** percheron is developed and tested on Node 26.
2. **percheron.** `npm i -g percheron`. Check with `percheron` alone, which prints usage.
3. **Claude Code**, logged in. percheron runs each agent task as a headless `claude -p`
   process. Check with `claude --version`.
4. **em**, the event modeling CLI. `npm i -g @milehimikey/em`. Check with `em --version`.
   The provider was written against em 1.19 and pins the plan and readiness schema
   versions it understands.

You also need a target repository that is a git checkout with a `main` branch, an em model
file in it, slice documents under `slices/`, and an em engagement already created with
`em engagement new`. The engagement names the slices this run will build.

## Step 1: decide where the spec lives

Put the spec inside the target repository, in a folder such as `engagements/`. Every
relative path in the spec resolves against the spec file's own directory, and `percheron
run` changes into that directory before it talks to the provider. Keeping the spec next to
the model it drives makes those paths short and stable.

```
toolshed/
  toolshed.em
  constitution.md
  slices/
    fulfill-hold.md
    ...
  engagements/
    percheron-scale-2026-10.md      <- em's engagement file and ledger
    percheron-scale-2026-10.yaml    <- the percheron spec
```

Add `.percheron/` to the repository's `.gitignore`. That is where worktrees, task records,
the percheron ledger and the evidence live.

## Step 2: write the spec

Here is a complete, working spec. Each block is explained after it.

```yaml
specVersion: "0.2"

engagement:
  name: percheron-scale-2026-10
  mode: build

work:
  provider: em
  config:
    model: ../toolshed.em
    engagement: percheron-scale-2026-10
    # branchPrefix: percheron/
  transitions:
    onDispatch: building
    onGateParked: awaiting-merge
    onGateCleared: merged
    onEscalate: held
    onReopen: planned

tools:
  em: ">=1.19.5 <2.0.0"
  schemas: { engagementPlan: ">=1.4", validateSliceReady: ">=1.5" }

policy:
  ratifiers: [mikey]
  mergeAuthority: human
  exceptionRouting: human_only
  budgets:
    perNode: { usd: 14, dispatchFloorUsd: 1 }
    perTask: { usd: 7, maxTurns: 120, wallClock: 25m }

scheduling:
  dispatchWhen: upstreamsMerged && ready
  maxConcurrent: 3
  levels: orderingHintOnly

roles:
  implementer: { adapter: local-subagent, model: sonnet }
  reviewer:    { adapter: local-subagent, model: sonnet }
  critic:
    adapter: local-subagent
    model: opus
    independence: { freshContext: true, modelNot: [implementer], blindTo: [review] }

adapters:
  local-subagent:
    repoRoot: ..
    stateDir: ../.percheron

pipeline:
  entry: implement
  exits: [done, handoff, blocked, failed]
  guards: { maxRounds: 3, maxHops: 16 }
  steps:
    - id: implement
      kind: agent
      role: implementer
      contract: ../../percheron/roles/implementer.md
      produces: [evidenceMap, continuationNote]
      on: { done: validate, handoff: validate, blocked: escalate, failed: implement }

    - id: validate
      kind: check
      run:
        - ["./gradlew", "ktlintCheck", "test", "--quiet"]
        - ["em", "coverage", "toolshed.em", "--tests", "src/test/kotlin", "--slice", "{node.key}", "--strict"]
      on: { done: review, failed: implement }

    - id: review
      kind: agent
      role: reviewer
      contract: ../../percheron/roles/reviewer.md
      readOnly: true
      parallelWith: [critique]
      produces: [findings]
      on: { done: merge-gate, failed: implement, blocked: escalate }

    - id: critique
      kind: agent
      role: critic
      contract: ../../percheron/roles/critic.md
      readOnly: true
      parallelWith: [review]
      produces: [findings]
      on: { done: merge-gate, failed: implement, blocked: escalate }

    - id: merge-gate
      kind: human
      gate:
        summary: "validate PASS, review and critique done. Merge impl/<key> into main."
        evidenceRef: .percheron/evidence
      acceptance: { observer: git-merged, candidateRef: branch, verdicts: [merged] }
      on: { done: node-done, failed: escalate }
```

**specVersion** is a quoted string. YAML would read a bare `0.2` as a number.

**engagement** names the run. The name becomes part of the ledger file name and of every
task's idempotency key, so keep it stable once a run has started.

**work** picks the provider and configures it. The em provider needs the model path and
the em engagement slug. `branchPrefix` is optional: without it, nodes build on em's
`impl/<key>` branches; with `percheron/` they build on `percheron/<key>`, which matters when
another tool derives branches from the same model. The `transitions` block maps the
controller's five moments onto em's own state names. The controller never interprets those
names; it only writes them.

**tools** records the versions this spec was written against. The controller carries them
for your CI to check; it does not verify them itself.

**policy** declares who may clear gates and how much a node and a task may spend. The node
budget is checked when a task is about to be dispatched. The remaining headroom travels with
the task as its own ceiling. `dispatchFloorUsd` says how little headroom is still worth
dispatching into.

**scheduling** is deliberately narrow. A node is dispatched when every node it depends on
is done and the provider says it is ready, up to `maxConcurrent` live nodes. Levels are an
ordering hint only, never a barrier.

**roles** bind each role name to an adapter and a model. The critic's `independence` block
is data the validator checks: the critic must not share the implementer's model, and the
review step's output is withheld from it.

**adapters** configures the executor. `repoRoot` is the checkout that worktrees are cut
from. `stateDir` is where everything percheron writes goes.

**pipeline** is the loop every node runs. The entry step is `implement`. Check commands are
argument lists, not shell strings, and run inside the node's worktree, so paths are
relative to the worktree. `{node.key}` is replaced with the node's key at run time. Review
and critique form a parallel group: both are dispatched together and the node moves on when
both have exited. The merge gate parks the node until the `git-merged` observer sees the
node's branch merged into `main`.

## Step 3: validate

```
$ percheron validate engagements/percheron-scale-2026-10.yaml
ok: engagements/percheron-scale-2026-10.yaml, 0 error(s), 0 warning(s) · percheron-scale-2026-10 · 5 step(s), entry implement
```

The validator is strict on purpose. An unknown key anywhere is an error with its exact
path. A route to a step that does not exist is an error. Each issue comes with the action
that fixes it:

```
FAILED: engagements/x.yaml, 1 error(s), 0 warning(s)
  ERROR   pipeline.steps[1].on.done: route target "reveiw" is not a step id
          fix: Route to an existing step id, or to `node-done` / `escalate`.
```

Exit code 0 means valid, 1 means errors, 2 means the command line was wrong. Warnings do
not fail validation. `--json` prints the same report as a document.

## Step 4: look at the plan

```
$ percheron run engagements/percheron-scale-2026-10.yaml --plan
[percheron 06:03:51] percheron-scale-2026-10: repo /Users/you/toolshed, ledger /Users/you/toolshed/.percheron/ledger-percheron-scale-2026-10.json
L0  holds-to-fulfill           deps=[] state=planned
L0  undelivered-notices        deps=[] state=planned
L0  send-overdue-notice        deps=[] HELD(upstream-outside-engagement-unmerged) state=planned
L1  fulfill-hold               deps=[holds-to-fulfill] state=planned
L2  flagged-neighbors          deps=[flag-neighbor] state=planned
...
```

This derives the graph from the provider and prints it without dispatching anything. `L`
is the provider's ordering hint. `deps` are the keys this node waits for. `HELD` names a
provider hold: that node will never be dispatched in this run, and the reason is the
provider's own code. `state` is the provider's current business state.

The plan step also runs the provider's preflight. For em that includes the foundation
check: if a shared event the slices depend on is missing from the code, the run refuses to
start and says which event.

## Step 5: run

```
$ percheron run engagements/percheron-scale-2026-10.yaml 2>&1 | tee -a .percheron/run.log
```

The controller now loops. On every tick it looks at each node, dispatches the ones that
may start, collects the tasks and checks that have finished, routes, and sleeps for the
poll interval, five seconds by default. It stops when every node is terminal or only parked
gates remain, and exits 1 if any node escalated. Run it in a terminal you can leave open,
or under a process manager. The log goes to standard error with a timestamp per line.

You will see lines like these for one node:

```
[percheron 06:04:02] holds-to-fulfill: dispatched implement (implementer) round 0
[percheron 06:05:31] holds-to-fulfill: implement exited done (2 artifact(s))
[percheron 06:05:31] holds-to-fulfill: check validate started (2 command(s))
[percheron 06:19:48] holds-to-fulfill: check validate PASS
[percheron 06:19:53] holds-to-fulfill: dispatched review (reviewer) round 0
[percheron 06:19:53] holds-to-fulfill: dispatched critique (critic) round 0
[percheron 06:20:41] holds-to-fulfill: review exited done (1 artifact(s))
[percheron 06:21:07] holds-to-fulfill: critique exited done (1 artifact(s))
[percheron 06:21:07] holds-to-fulfill: parked at merge-gate: validate PASS, review and critique done. Merge impl/<key> into main.
```

Checks are asynchronous. A fourteen-minute test suite on one node never stops other nodes
from being dispatched or collected. When a check fails you see the failure named:

```
[percheron 06:33:10] neighbors-to-flag: check validate FAIL
[percheron 06:33:10] neighbors-to-flag: dispatched implement (implementer) round 1
```

and the retry's prompt carries the reason, for example `FAILED
com.toolshed.NeighborsToFlagProjectionTest.redelivered Reinstated keeps rows(): expected:<1>
but was:<0>`, as the fact `lastValidateFailure`.

## Step 6: clear a gate

A parked node is waiting for you. Read its evidence first:

```
.percheron/evidence/holds-to-fulfill/
  implementer-3f9a2c1d/
    evidenceMap.md          <- invariant id -> test, plus files created
    continuationNote.md     <- what was built, what is open
  reviewer-8b1e77d0/
    findings.md             <- one line per finding, or NO FINDINGS
  critic-c04d19ae/
    findings.md
  checks/
    validate-g0r1.log       <- full output of a failing check, if there was one
```

The node's branch is `impl/holds-to-fulfill` in the worktree under
`.percheron/worktrees/holds-to-fulfill`. Review the diff however you like, then merge it
into `main` in the main checkout:

```
$ git merge --no-ff impl/holds-to-fulfill -m "merge: impl/holds-to-fulfill"
```

Within one poll interval the observer sees that the branch is an ancestor of `main`:

```
[percheron 06:41:20] holds-to-fulfill: gate merge-gate cleared by observed fact
[percheron 06:41:20] holds-to-fulfill: DONE
[percheron 06:41:25] fulfill-hold: dispatched implement (implementer) round 0
```

The provider's ledger moves to `merged`, and any node that depended on this one becomes
dispatchable. You did not tell the controller anything. It observed a fact.

If you do not want to merge, stop the controller and refuse the gate instead. See step 8.

## Step 7: watch progress

```
$ percheron status engagements/percheron-scale-2026-10.yaml
percheron-scale-2026-10: done 3 · parked 1 · pending 6 · escalated 1 · spend $15.56
  flag-neighbor              ESCALATED              round 3 [validate->implement:1 critique->implement:2] hops 13 $3.60
  fulfill-hold               parked@merge-gate      round 1 [validate->implement:1] hops 9 $5.38
  holds-to-fulfill           DONE                   round 0 hops 6 $1.45
  pickups-to-expire          -                      round 0 hops 0 $0.00
  ...
```

`round` is the total number of loop-backs this generation. The bracket shows how many times
each loop-back edge was taken, which is what `maxRounds` bounds. `hops` is the total number
of transitions. `--json` gives you the summary and every node's full state.

## Step 8: handle an escalation

A node escalates when a guard trips, when a step routes to `escalate`, or when a human
refuses a gate. The log says why, the provider's ledger moves to `held`, and the node is
terminal until a person acts:

```
[percheron 07:52:14] flag-neighbor: ESCALATED: guard maxRounds exceeded on critique->implement: 3 vs limit 3
```

Read the evidence, decide, then stop the controller and reopen the node with your decision
as feedback:

```
$ percheron reopen engagements/percheron-scale-2026-10.yaml flag-neighbor \
    --reason "ruling recorded in constitution amendment 11" \
    --feedback "the reaction must ride the read model's processor; see constitution.md Amendment 11"
```

The node re-enters at the entry step, in a new generation, with your note delivered to the
implementer as `lastValidateFailure`. Rounds and hops restart; spend does not. Start the
controller again and the node is dispatched on the first tick. `--clear-feedback` instead
of `--feedback` sends the node back with no failure context at all.

To refuse a parked gate, stop the controller and run:

```
$ percheron reject engagements/percheron-scale-2026-10.yaml fulfill-hold \
    --reason "critic's ordering finding stands" \
    --feedback "use the hook shape from Amendment 11, not bean ordering"
```

The gate's `failed` route runs, usually `escalate`, and the node is now in the same place
as any other escalated node. `reopen` sends it back with your note.

Both commands require the controller to be stopped. The ledger has one writer.

## Step 9: stop and resume

Stop the controller with Ctrl-C at any time. Nothing is lost: pipeline state is written
through to the ledger on every change, each task has a record on disk, and a running
`claude` process keeps running and writes its result to its task record.

Start it again with the same command. It reloads the ledger, re-derives the graph from the
provider, and continues. A finished task is handed back, not repeated, because dispatches
are keyed by engagement, node, step, generation and round. A check that was running when
the controller died is simply run again. A task whose process died with no parseable result
is reported as a failed exit marked indeterminate, never silently retried.

## Step 10: where everything is

| Path | What it holds |
|---|---|
| `.percheron/ledger-<name>.json` | Pipeline state per node and the append-only event log |
| `.percheron/worktrees/<key>/` | The node's git worktree on its branch |
| `.percheron/tasks/<id>/` | One record per dispatched task, with the agent's raw output |
| `.percheron/evidence/<key>/<role>-<id>/` | The artifacts each agent step wrote |
| `.percheron/evidence/<key>/checks/` | Full output of failing checks |
| `.percheron/quarantine/<id>/` | Files an agent wrote outside its worktree, if that ever happens |
| `engagements/<slug>.md` | em's engagement file and ledger, the business state |

The two ledgers are kept in step by the transitions you declared. If you ever need to know
why a node is where it is, the event log in the percheron ledger is the record: every
dispatch, exit, check, gate, guard, escalation, reopen and rejection, with a timestamp.
