# Roles

A role is a name in the spec bound to an adapter and a model. What the role actually does
is written in its contract, a Markdown file the agent is told to read first. percheron
ships three contracts under `roles/`. This page explains what each does, what every agent
is told regardless of role, and how to write a contract of your own.

## What every agent receives

The adapter builds one prompt per task. It is short on purpose. The agent is told:

- its role name and the node key, plus the node title if the provider gave one;
- the path of its role contract, to read first and follow exactly;
- the documents to read next, in order: the engagement's goal spec and briefing if the spec
  names them, then whatever the provider supplies, for em the slice document and the
  project's constitution;
- a few named facts, such as `branch`, `base`, `tracking`, and after a failed round
  `lastValidateFailure`, the verdict on the previous attempt;
- whether it is read-only, or that writes outside the current directory are denied and
  swept;
- the artifacts it must write and where, one file per declared kind;
- that its final message must be exactly one JSON object: `{"exit": ..., "summary": ...}`.

The exit is the only thing the controller routes on. A missing artifact demotes `done` to
`failed`. Everything else the agent knows comes from the files it reads, which is the
point: the contract and the project's own documents carry the rules, not the prompt.

## implementer

Builds exactly one node in its git worktree. The contract tells it to read the node's spec
as read-only truth, follow the project's rules, and study two or three implemented
neighbours before writing anything. Every invariant and scenario in the spec gets a test
that cites it. It commits its own files by path, never with `git add -A`, and never merges,
pushes or rebases. It does not run the project's verification suite: the harness does, as
the verdict, after it exits. If the spec contradicts the project's rules it stops and exits
`blocked` with the question in its continuation note.

It writes two artifacts. `evidenceMap.md` is a table from invariant id to the test that
covers it, followed by the files it created. `continuationNote.md` is one paragraph: what
was built, what is open, what whoever resumes must know.

Exits: `done`, `blocked`, `failed`.

## reviewer

Reads the node's spec, the project's rules, and the diff against `main`. Checks four
things: spec fidelity, slice isolation, conformance to the project's rules, and test
honesty, meaning each cited test really exercises the invariant it claims. It makes no
edits. Every finding must cite a line of the spec or a rule of the project, or it is
dropped. `NO FINDINGS` is a valid and expected outcome.

It writes `findings.md`: one line per finding with a severity of `blocker`, `major` or
`minor` and its citation, or `NO FINDINGS` followed by what was checked.

Exits: `done` when there is nothing above `minor`, `failed` when a blocker or major stands.

## critic

The same checks as the reviewer, with one difference that is the whole reason it exists:
independence. It runs in fresh context, on a different model from the implementer, and is
told not to look for or read any other review. If other review material reaches it anyway
it says so and ignores it. A finding the reviewer did not make is exactly the signal the
harness wants.

In the one benchmark so far, every findings loop was triggered by the critic. The reviewer
read the same code and passed it every time. See the benchmark page for the details.

## Writing your own contract

A contract is a Markdown file. The agent reads it before anything else, so write it as
instructions to a careful colleague who has never seen the project. The shipped contracts
are a good template. Things that have proved to matter:

- **Say what to read, in order.** The spec first, the rules second, examples third.
- **Name the forbidden list.** Other nodes' code, shared infrastructure, the model, the
  ledgers. Agents follow explicit prohibitions well and infer them badly.
- **Make the artifacts concrete.** Give each one a format. A table with named columns beats
  "write up your evidence".
- **State the exit rule.** Which exit, under which condition. The controller routes on it.
- **Explain the session shape.** A headless task ends when its message ends. Nothing runs
  in the background, nothing waits for a reply, and a previous attempt may have left work
  in the worktree that should be checked, not discarded.
- **Tell it what the harness already guarantees** so it does not spend turns on it. The
  implementer does not run the test suite. The reviewer does not need to ask permission to
  be read-only.

Bind the new role under `roles`, point an agent step's `contract` at the file, and declare
the artifacts it produces from the closed registry.
