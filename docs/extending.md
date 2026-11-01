# Extending percheron

Three seams are designed to be replaced: the provider that derives the graph, the adapter
that runs tasks, and the observer that notices when a human has acted. Each is code
registered by an id; the spec only names and configures it. In 0.0.2 the registry is a
`switch` in `src/run.ts` with one entry per seam, so adding an implementation means adding a
case there. A plugin mechanism will come when there is a second implementation to justify
it.

The contracts live in `src/contracts/`. This page describes them in words; the TypeScript
is the authority.

## Provider

A provider turns something you already maintain into a graph of nodes, and keeps its own
record of business state. The reference provider wraps the em CLI and never reads or writes
an em file directly; everything goes through `--json` commands with pinned schema versions.

| Method | What it must do |
|---|---|
| `info()` | Return an id, a version, and the tool and schema pins the controller should check before running. |
| `parseConfig(raw)` | Validate the spec's `work.config` block and return a typed config. Throw on anything wrong. |
| `preflight(config)` | Return model-wide issues before any fan-out. A blocking issue stops the run. |
| `deriveGraph(config)` | Return every node with its key, the keys it depends on, an ordering hint, and metadata such as branch, base and any hold. Idempotent, recomputed on every call, never cached as authority. |
| `readiness(config, key)` | Say whether one node may start now and, if not, the codes that block it. |
| `nodeContext(config, node)` | Return the small set of things an agent on this node must read first and the named facts it needs. Keep it minimal; this is not a dumping ground. |
| `onTransition(config, key, transition)` | The only write. Record the business state the spec's `transitions` block named, with any refs such as a branch or PR. Idempotent per node and state. |

Rules: read methods have no side effects. Business state names are the provider's own
vocabulary; the controller writes them and compares them for equality, nothing more.

## Adapter

An adapter is the thin layer between a dispatch and a harness. The same pipeline should run
on a local Claude Code process, a cloud session, or a CI job by swapping this layer. Every
2026 agent product exposes a create-task-and-observe shape; the adapter normalizes it.

| Method | What it must do |
|---|---|
| `info()` | Id, version, how completion is learned (`events` or `poll`), workspace kinds, and an honest concurrency ceiling. |
| `provisionWorkspace(key, {branch, base})` | Create or reuse the node's workspace. The local adapter cuts a git worktree on the given branch from the given base. |
| `releaseWorkspace(ws)` | Tear it down. |
| `createTask(request)` | Start a task. The request carries an idempotency key, the role, the model, the contract path, the node context, the workspace, read-only flag, the artifacts to produce, and limits. A repeated key must return the existing task, running or finished. |
| `status(ref)` | Report running, or exited with a result: the exit, the artifacts found, spend, and any violations such as a budget hit or a workspace escape. |
| `cancel(ref)` | Stop a task. |
| `exec(ws, argv, {timeoutMs})` | Run a command in the workspace and return exit code, stdout and stderr. The controller judges; the adapter only locates and executes. |
| `recordEvidence(key, name, content)` | Optional. File a controller-produced artifact, such as a failing check's full output, with the node's evidence and return a reference. |

Rules the local adapter follows and any adapter should: limits are enforced by the
harness, not requested in the prompt. Read-only means the harness denies writes. A task's
record survives the controller; a fresh adapter can recover a result from disk. A process
that died without a parseable result is reported as failed and indeterminate, never
silently retried.

## Observer

An observer turns an external fact into a gate verdict. It is the reason human gates cost
nothing while they wait: the controller asks the observer once per poll, and the observer
looks at the world.

| Method | What it must do |
|---|---|
| `check(acceptance)` | Given the candidate ref, the accepted verdicts and an evidence reference, return whether the gate is satisfied and the evidence that shows it. |

The `git-merged` observer runs `git merge-base --is-ancestor <branch> main` in the
repository root. Natural next observers are a pull-request state from a forge API and a
ratification mark in a document.

## What the controller promises the seams

- It calls `parseConfig` and `preflight` once at plan time and refuses to run on a blocking
  issue.
- It never caches the graph as authority. Each tick re-derives readiness for nodes that
  might start.
- It dispatches with an idempotency key of engagement, node, step, generation and round, so
  a crash and restart hands back the same task.
- It writes the provider's business state only at the five moments the spec declares.
- It keeps its own pipeline state in its own ledger and never asks a seam to remember
  anything for it.
