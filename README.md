# percheron

A portable **engagement harness**: drive large work-graphs to completion with agents.
Derived graphs (never hand-drawn), evidence-gated loops (deterministic checks > typed judges
> LLM review, never the reverse), bounded retries, and humans as durable interrupts — over
any agent harness, local or cloud.

Named for the draft workhorse breed: the animal harnesses exist for, and they pull in teams.

**Status: 0.0.1 — runs, benchmarked once, thinly documented.** This release exists so the
code that ran the first benchmark has a version number. Expect the spec format and the
contracts to move. First work provider: [em](https://github.com/milehimikey/em) (event
modeling) — an event model with hundreds of slices is the canonical use case — but providers
are pluggable and percheron is not em-specific.

## What it does

You write one `engagement.yaml`: a **work provider** that derives the node graph (em: the
slices of an engagement and their dependencies), **role bindings** (implementer, reviewer,
critic → an adapter and a model), and a **per-node pipeline** of typed steps:

| step kind | who judges | example |
|---|---|---|
| `check` | the controller, from exit codes | `./gradlew test`, `em coverage --strict` |
| `agent` | an agent, exiting on a closed enum (`done`/`handoff`/`blocked`/`failed`) | implement, review, critique |
| `human` | a person, observed as an external fact (branch merged) | merge gate |
| `judge` | advisory only (placeholder in 0.0.x) | rubric scoring |

The controller is a small deterministic state machine with no model calls. It dispatches
nodes whose upstreams are done, runs checks where the workspace is (adapter-located,
controller-judged), routes on exits, feeds the previous failure into every retry as a named
fact, bounds everything (`maxRounds` per loop-back edge, `maxHops`, budgets checked at
dispatch), parks at human gates at zero cost, and resumes from its file ledger after a crash.

```
implement → validate (check) → review ‖ critique (parallel agents) → merge-gate (human)
                ↑ failed            ↑ findings                         ↓ merged
                └───────────────────┘                               node-done
```

## Install and run

```
npm i -g percheron            # needs node ≥ 22; the em provider needs `em` on PATH
percheron validate engagement.yaml
percheron run      engagement.yaml            # drives until settled; resumable
percheron status   engagement.yaml
percheron reopen   engagement.yaml <node> --reason "…" [--feedback "…"]   # un-escalate
percheron reject   engagement.yaml <node> --reason "…" [--feedback "…"]   # say no at a gate
```

`examples/em-engagement.yaml` is the canonical spec, commented. Agent steps run through the
`local-subagent` adapter: a headless `claude -p` per task, confined to a git worktree, with
budget and turn ceilings passed as flags and anything that escapes the worktree quarantined.

## Benchmark so far

One run on a real event-modeled Kotlin/Axon codebase (toolshed, 11 slices over 4 dependency
levels, full pipeline with a sonnet implementer and reviewer and an opus critic): 10 of 11
slices merged, 64 agent tasks, about $32, under 5 hours wall clock, zero workspace escapes.
The one unmerged slice was correctly held by the provider. Two escalations surfaced a real
design gap in the target project that no implementer could have closed, which is what
escalation is for. The write-up will be published with the design docs.

## Not yet

- Documentation beyond this file and the example. The design base, spec-format notes and
  the benchmark report live in a private vault and will be published once they settle.
- Cloud adapters (only `local-subagent` exists), judge steps, more providers.
- A stable spec format: `specVersion: "0.2"` today, validated strictly, but expect changes.

MIT.
