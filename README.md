# percheron

A portable engagement harness. percheron drives a large graph of work to completion with
agents: the graph is derived from something you already maintain, every node runs a
bounded loop gated on evidence, and humans sit in the graph as gates that park a node until
they act. It sits above any agent harness, local or cloud.

Named for the draft workhorse breed: the animal harnesses exist for, and they pull in teams.

**Status: 0.0.2.** It runs, it has been benchmarked twice on a real codebase, and the
documentation is new. Expect the spec format and the contracts to move. The first work
provider is [em](https://github.com/milehimikey/em), the event modeling CLI, because an
event model with hundreds of slices is the canonical case. Providers are pluggable;
percheron is not em-specific.

## Documentation

Start with [docs/concepts.md](https://github.com/milehimikey/percheron/blob/main/docs/concepts.md) for the three layers (harness, loop, graph)
and where each piece of percheron lives, then [docs/walkthrough.md](https://github.com/milehimikey/percheron/blob/main/docs/walkthrough.md)
to run your first engagement. The index is [docs/README.md](https://github.com/milehimikey/percheron/blob/main/docs/README.md).

## In one paragraph

You write one `engagement.yaml`. It names a provider that derives the node graph, binds
roles such as implementer, reviewer and critic to an adapter and a model, and declares a
per-node pipeline of typed steps: deterministic checks the controller judges from exit
codes, agent steps that end on a closed set of exits, and human gates that wake on observed
facts such as a branch being merged. The controller is a small deterministic state machine
with no model calls. It dispatches nodes whose upstreams are done, runs checks where the
workspace is, routes on exits, feeds each failure into the retry by name, bounds rounds per
loop-back edge and hops per traversal, checks budgets at dispatch, and resumes from its
file ledger after a crash.

```
implement -> validate (check) -> review and critique (parallel agents) -> merge-gate (human)
     ^           | failed                 | findings                          | merged
     +-----------+-------------------------+                              node-done
```

## Install and run

```
npm i -g percheron            # tested on Node 26; the em provider needs `em` on PATH
percheron validate engagement.yaml
percheron run      engagement.yaml            # drives until settled; resumable
percheron status   engagement.yaml
percheron reopen   engagement.yaml <node> --reason "..." [--feedback "..."]   # un-escalate
percheron reject   engagement.yaml <node> --reason "..." [--feedback "..."]   # say no at a gate
```

`examples/em-engagement.yaml` is the canonical spec, commented. Agent steps run through the
`local-subagent` adapter: one headless `claude -p` process per task, confined to a git
worktree, with budget and turn ceilings passed as flags and anything that escapes the
worktree quarantined.

## Benchmark so far

One run on toolshed, an event-modeled Kotlin and Axon codebase: 11 slices over four
dependency levels, full pipeline, sonnet implementer and reviewer, opus critic. Ten of
eleven slices merged, 64 agent tasks, about 32 dollars, under five hours of controller time,
zero workspace escapes. The eleventh was correctly held by the provider. Two escalations
surfaced a design gap in the target project that no implementer could have closed, which
is what escalation is for. Details in
[docs/benchmark-toolshed-2026-10.md](https://github.com/milehimikey/percheron/blob/main/docs/benchmark-toolshed-2026-10.md).

## Not yet

- Cloud adapters. Only `local-subagent` exists.
- Judge steps. Accepted by the spec, logged, never routing.
- More providers, and a plugin registry; today the registry is a `switch` in `src/run.ts`.
- A stable spec format. `specVersion: "0.2"` is validated strictly, but it will change.

MIT.
