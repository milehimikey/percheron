# Spec reference

`engagement.yaml` is the one file you write. This page lists every key the loader accepts
and the rule it applies. The loader is strict: an unknown key anywhere is an error that
names its path, and a key the controller does not implement is refused rather than carried.
Every error comes with the action that fixes it.

Validate with `percheron validate <file>`. Exit 0 is valid, 1 is errors, 2 is a usage
mistake. Warnings are printed but do not fail validation. `--json` prints the report as a
document.

Relative paths resolve against the directory the spec file is in.

## Top level

| Key | Required | Rule |
|---|---|---|
| `specVersion` | yes | A quoted string `"<major>.<minor>"`. The major must be one this loader supports, today `0`. |
| `engagement` | yes | See below |
| `work` | yes | See below |
| `tools` | no | A mapping of tool id to version range or nested mapping. Carried for your CI; the controller does not check it. |
| `policy` | no | See below |
| `scheduling` | no | See below |
| `roles` | yes | See below |
| `adapters` | no | A mapping of adapter id to its config. When present, every adapter a role names must appear here. |
| `pipeline` | yes | See below |

## engagement

| Key | Required | Rule |
|---|---|---|
| `name` | yes | A slug: letters, digits, `.`, `_`, `-`, starting with a letter or digit. Part of the ledger file name and every idempotency key. |
| `mode` | no | `build` or `investigate`. Informational in 0.0.x. |
| `goalSpec` | no | Path to a committed file. Injected first into every agent step's reading list. |
| `briefing` | no | Path to a committed file. Injected second. |

## work

| Key | Required | Rule |
|---|---|---|
| `provider` | yes | A registered provider id. Only `em` exists. |
| `config` | yes | A mapping the provider parses itself. See the em block below. |
| `transitions` | no | A mapping of the five controller moments to the provider's own state names. Keys: `onDispatch`, `onGateParked`, `onGateCleared`, `onEscalate`, `onReopen`. Values must be strings. For em the usual values are `building`, `awaiting-merge`, `merged`, `held`, `planned`. |

### work.config for the em provider

| Key | Required | Rule |
|---|---|---|
| `model` | yes | Path to the `.em` model file. Resolved from the spec's directory at run time. |
| `engagement` | yes | The em engagement slug. It must already exist. |
| `code` | no | Path to the code repository for em's foundation check. Omitted means the foundation is not checked. |
| `emBin` | no | The em binary. Default `em` on `PATH`. |
| `branchPrefix` | no | A branch name fragment such as `percheron/`. Nodes then build on `<prefix><key>` instead of em's `impl/<key>`. Letters, digits, `.`, `_`, `-`, `/` only. |

## policy

| Key | Required | Rule |
|---|---|---|
| `ratifiers` | no | A list of handles: who may clear human gates. Recorded, not enforced. |
| `mergeAuthority` | no | Only `human` is implemented. |
| `exceptionRouting` | no | Only `human_only` is implemented. |
| `budgets.perNode.usd` | no | Non-negative number. Checked at dispatch; remaining headroom travels with the task. |
| `budgets.perNode.dispatchFloorUsd` | no | Non-negative number. Headroom at or below it counts as exhausted. |
| `budgets.perTask.usd` | no | Non-negative number. Enforced by the adapter. |
| `budgets.perTask.maxTurns` | no | Positive integer. Enforced by the adapter. |
| `budgets.perTask.wallClock` | no | A duration: `90s`, `15m`, `2h`, or milliseconds as a number. Enforced by the adapter as a deadline. |
| `budgets.total` | no | Accepted with a warning. Not enforced. |

## scheduling

| Key | Required | Rule |
|---|---|---|
| `dispatchWhen` | no | Only `upstreamsMerged && ready` is implemented. |
| `maxConcurrent` | no | Positive integer. Default 4. Live, unparked nodes at once. |
| `levels` | no | Only `orderingHintOnly`. Levels never gate dispatch. |

## roles

A mapping of role name to binding. Every role an agent step names must be declared here.

| Key | Required | Rule |
|---|---|---|
| `adapter` | yes | A registered adapter id, and declared under `adapters` when that block exists. Only `local-subagent` exists. |
| `model` | no | A model name the adapter understands, such as `sonnet` or `opus`. Unbound means the adapter's default. |
| `independence.freshContext` | no | Boolean. Documents that each task is a fresh session, which is true for every adapter so far. |
| `independence.modelNot` | no | A list of role names. This role must not bind the same model as any of them. Checked statically; a warning if either model is unbound. |
| `independence.blindTo` | no | A list of step ids whose outputs are withheld from this role. Documents the default: agents never see each other's output. |

## adapters

A mapping of adapter id to its config. The only adapter is `local-subagent`:

| Key | Rule |
|---|---|
| `repoRoot` | Path to the git checkout worktrees are cut from. Default: the repository containing the spec. |
| `stateDir` | Where percheron writes everything. Default `<repoRoot>/.percheron`. Add it to `.gitignore`. |
| `claudeBin` | The Claude Code binary. Default `claude`. |
| `defaultModel` | Model for roles that bind none. |
| `maxConcurrentTasks` | Honest ceiling the adapter reports. Default 4. |
| `confine` | Boolean. Workspace confinement on or off. Default on. |
| `readOnlyTools` | Tool list for read-only tasks. Default `Read`, `Grep`, `Glob`. |
| `writeTools` | Tool list for writing tasks. Default `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`. |

## pipeline

| Key | Required | Rule |
|---|---|---|
| `entry` | yes | The id of the first step. |
| `exits` | no | If present, must be exactly `[done, handoff, blocked, failed]`. Declarative confirmation only. |
| `guards.maxRounds` | yes | Positive integer. Retries permitted per loop-back edge. |
| `guards.maxHops` | yes | Positive integer. Total step transitions in one traversal. |
| `steps` | yes | A non-empty list. Ids are unique. `node-done` and `escalate` are route keywords and may not be step ids. |

Every step has `id`, `kind` and `on`. `on` maps each exit the kind can produce to a step
id, `node-done` or `escalate`. Routing on an exit the kind cannot produce is an error.
Routing to a step that comes earlier in the list, or to the same step, is a loop-back and
is bounded by `maxRounds`.

### kind: check

| Key | Required | Rule |
|---|---|---|
| `run` | yes | A non-empty list of commands. Each is an argv list, or a string split shell-style with no shell at run time. `{node.key}` is replaced at run time. `{config.<path>}` is replaced at load time from `work.config` and must resolve to a scalar. Any other brace placeholder is an error. |
| `retryUnrelated` | no | A non-negative integer, default 0. When a command fails and every test it names as failing lies outside the node's diff, the command is run again, up to this many times, before the failure is routed. 1 is the usual value. |
| `on` | yes | Exits `done` and `failed`. All commands exit 0 means `done`. |

Commands run in the node's worktree, so paths are relative to it.

A failing test is outside the diff when neither its package directory nor its class name
appears in any file the node changed against its base. A failure that names no test, or a
lint failure, is always the node's own and is never re-run.

### kind: agent

| Key | Required | Rule |
|---|---|---|
| `role` | yes | A role declared under `roles`. |
| `contract` | yes | Path to the role's contract file. A missing file is a warning. |
| `produces` | yes | A non-empty list from the closed registry: `pr`, `findings`, `evidenceMap`, `continuationNote`, `report`. The agent must write each as a file; a missing one demotes the exit to `failed`. |
| `readOnly` | no | Boolean. The adapter denies writes. Use it for reviewers and critics. |
| `parallelWith` | no | A list of other agent step ids. Every member lists the others, and all members have an identical `on` map. The group is dispatched together and joins when all exit: `failed` if any failed, else `blocked` if any blocked, else `done`. |
| `on` | yes | Exits `done`, `handoff`, `blocked`, `failed`. |

### kind: human

| Key | Required | Rule |
|---|---|---|
| `gate.summary` | yes | One line telling the person what they are accepting. Printed when the node parks. |
| `gate.evidenceRef` | no | Path or URL to the evidence. |
| `acceptance.observer` | yes | A registered observer id. Only `git-merged` exists: the candidate branch must become an ancestor of `main`. |
| `acceptance.candidateRef` | yes, or `candidate` | Which harvested node ref is the candidate: `branch` or `pr`. `candidate: "{branch}"` is accepted and means the same. |
| `acceptance.verdicts` | yes | A non-empty list of verdicts that clear the gate, such as `[merged]`. |
| `on` | yes | Exits `done` and `failed`. `failed` runs when a human rejects the gate. |

A pipeline should have one human step. With more than one, a warning explains that
provider adoption of an existing `awaiting-merge` state re-parks at the first.

### kind: judge

| Key | Required | Rule |
|---|---|---|
| `rubrics` | yes | A non-empty list of rubric ids. Each id names a file: `rubrics/<id>.md` beside the spec, or failing that the rubric percheron ships under the same name. Missing is a warning. |
| `role` | no | The role the judge task runs under, default `judge`. It must be bound under `roles`. |
| `contract` | no | Path to the judge's node contract. Default: the shipped `roles/judge.md`. |
| `advisory` | no | If present, must be `true`. Judges never route. |
| `on` | yes | Exit `done` only. |

A judge step dispatches one read-only task under its role with the rubric files added to the
end of its reading list. The task writes a `verdict` artifact: one JSON object with the
rubric id, one entry per criterion carrying an id and a score from 0 to 1, and an optional
summary. The controller parses it, records a `judged` event with the typed verdict, logs
`criteria met` and the mean, and takes `on.done`. A judge task that fails, writes nothing, or
writes something that is not a verdict is recorded as "no verdict" and the node still takes
`on.done`. The verdict reaches no agent step; it is evidence for the human at the gate.
