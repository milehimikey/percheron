# Concepts

This page explains the three layers percheron is built on, which piece of percheron lives
in which layer, and the words the rest of the documentation uses.

## Three layers: harness, loop, graph

When agents do real work at any scale, three different kinds of problem show up. Each needs
a different kind of engineering, and mixing them up is how most agent systems get stuck.

| Layer | The question it answers | What it covers | How it fails when it is weak |
|---|---|---|---|
| **Harness** | What can the agent see, touch and keep? | Tools, files, permissions, budgets, state, logs, the sandbox it runs in | The agent cannot operate. A tool is missing, state is lost, nobody can see what happened. |
| **Loop** | How does one unit of work get done, checked and retried? | Trigger, goal, action, evidence, feedback, stop rule | Output is unreliable despite being nearly right. Retries make no progress. Confident wrongness. |
| **Graph** | In what order, with what branching, may many units of work proceed? | Nodes, edges, routing, joins, concurrency, human approvals, durability | Orchestration breaks. Steps run out of order, decisions get lost, approvals are skipped. |

A quick diagnostic follows from the table. If the agent cannot do something, the harness is
the problem. If it can do it but keeps getting it wrong, the loop is the problem. If every
piece is right and the whole is still wrong, the graph is the problem.

Two rules make the layers compose:

- **Every graph node runs its own loop.** The graph decides when a node may start. The loop
  decides what happens inside it.
- **A loop is a tiny graph.** One step that routes back to itself is still a graph, so one
  engine can serve both. percheron has one controller, not a loop runtime and a graph
  runtime.

## Where percheron sits

Every serious agent product in 2026 owns a harness. Claude Code, the cloud coding agents and
the CI runners all give an agent tools, a workspace and limits. Each one also bakes in its
own loop. What none of them give you is the graph: which pieces of work exist, which depend
on which, who approves what, and how the whole thing survives a crash or a weekend.

percheron is that graph layer, plus a loop layer you control through data. It does not
replace Claude Code. It drives Claude Code, and later other harnesses, through an adapter.

| Layer | What percheron owns here | What it borrows |
|---|---|---|
| Harness | Nothing of its own. The **adapter** is the seam: it turns a dispatch into a task on some harness and enforces budgets and workspace confinement there. | The agent runtime itself. Today that is a headless Claude Code process per task. |
| Loop | The **pipeline**: typed steps, a closed set of exits, routes, guards, failure feedback, the role contracts | The agent's own inner loop inside one step |
| Graph | The **controller**: the derived node graph, dependency scheduling, human gates, the ledger, resume | The graph's shape, which comes from a **provider** such as em |

## The pieces, one at a time

**Engagement.** One run over one graph, described by one `engagement.yaml`. It has a name,
a provider, role bindings, a pipeline and policy. The file is data. Nothing in it is a
promise the code does not keep; the validator refuses fields the controller does not
implement.

**Provider.** Code that derives the graph from something you already maintain. The
reference provider is [em](https://github.com/milehimikey/em), where the graph is the
slices of an event model and their dependency edges. The provider also answers "is this
node ready?" and records business state in its own ledger. The graph is never drawn by
hand and never cached as authority; it is recomputed whenever the controller asks.

**Node.** One unit of work: one slice, one bounded change. A node has a key, the keys it
depends on, and a small context the provider supplies: the documents to read first and a
few named facts such as the branch to build on.

**Pipeline and steps.** A template applied to every node. Each step has a kind, and the
kind says who judges it:

| Step kind | Who judges | Example |
|---|---|---|
| `check` | The controller, from exit codes. No judgment, no model. | `./gradlew test`, `em coverage --strict` |
| `judge` | A rubric scored criterion by criterion by a read-only task; typed, advisory, never routes | `slice-doc-quality` |
| `agent` | An agent, exiting on the closed enum | implement, review, critique |
| `human` | A person, observed as an external fact | merge the branch |

**Exits and routes.** An agent step ends with exactly one of four exits: `done`, `handoff`,
`blocked`, `failed`. A check ends `done` or `failed`. Each step's `on` map routes every exit
it can produce to another step, to `node-done`, or to `escalate`. Routing happens only on
these words. There is no free-text branching.

**Loop-backs and guards.** A route to an earlier step, or to the same step, is a loop-back.
Each loop-back edge has a budget, `maxRounds`, counted separately per edge. A lint slip on
the way back from `validate` does not spend a round meant for critique findings. `maxHops`
bounds the total number of transitions a node may make in one traversal, as a runaway
detector. Budgets are checked at dispatch, never after a successful exit, so a task that
finishes is never killed for having cost too much.

**Feedback.** When a check fails or an agent exits `failed`, the controller records why in
a form that names the failure: the failing test, the assertion text, the compiler error.
The next dispatch of that node receives it as a fact called `lastValidateFailure`. The retry
knows what to fix.

**Human gates and observers.** A `human` step parks the node at zero cost. Nothing polls a
chat or waits for a reply. The node wakes when an **observer** sees an external fact: with
the `git-merged` observer, that fact is "this branch is now an ancestor of main". A gate can
also be refused with `percheron reject`, which takes the gate's `failed` route.

**Roles and adapters.** A role such as `implementer` is bound to an adapter and a model. The
adapter is the executor. Independence between roles is data: the critic may declare that it
must not share the implementer's model and must not see the reviewer's output, and the
validator checks the model rule statically.

**Two ledgers.** percheron keeps pipeline state in its own ledger: which step each node is
on, rounds, hops, spend, parked gates, and an append-only event log. The provider keeps
business state in its ledger, in its own vocabulary, written only through the transitions
the spec declares: for em, `building`, `awaiting-merge`, `merged`, `held`, `planned`. A
fresh controller resumes from the two ledgers and the evidence directory alone.

**Evidence.** Every agent step leaves files behind: the deliverable, an evidence map of what
was checked, a continuation note for whoever resumes, or the findings of a review. Failing
checks leave their full output. All of it lands under the adapter's state directory, per
node, where a human at a gate can read it.

**Operator actions.** Two commands exist for the human who runs the controller. `reopen`
un-escalates a node and sends it back through the pipeline in a new generation, carrying
the failure or a note from the human as feedback. `reject` says no at a parked gate.

## The evidence hierarchy

The step kinds are ordered. Deterministic checks outrank typed judges, which outrank agents,
and a person has the last word. The LLM tier never overrides the deterministic tier: a
reviewer cannot pass a slice whose tests fail, because the tests ran first and routed the
node back before any reviewer was dispatched.

A related distinction from the harness literature is worth keeping in mind. A tool the
agent *may* call is a request. A check that *always* runs is a guarantee. Everything that
gates a node in percheron is a guarantee. The implementer is told not to run the test
suite; the controller runs it regardless.

## What percheron is not

- Not an agent runtime. The controller makes no model calls. All judgment lives in the
  checks, the agents and the human.
- Not a chat. Nothing waits for a message. Gates wake on observed facts.
- Not a place to draw graphs. The graph is a projection of a domain artifact the provider
  reads.
