# percheron documentation

percheron drives a graph of work nodes to completion with agents. Each node runs a bounded,
evidence-gated loop. Humans sit in the graph as gates that park a node until they act.

Read in this order if you are new:

1. [Concepts](concepts.md). The three layers (harness, loop, graph), where each percheron
   piece lives, and the vocabulary the other pages use.
2. [Walkthrough](walkthrough.md). Set up an engagement on a real repo, run it, clear a
   gate, handle an escalation, stop and resume.
3. [Operations](operations.md). Reading the log, the ledger and the evidence; guards and
   budgets; what to do when a node escalates; troubleshooting.
4. [Spec reference](spec-reference.md). Every field of `engagement.yaml` and the rule the
   validator applies to it.
5. [Roles](roles.md). The implementer, reviewer and critic contracts, what an agent is
   told, and how to write a role of your own.
6. [Extending](extending.md). The provider, adapter and observer contracts.
7. [Benchmark: toolshed, October 2026](benchmark-toolshed-2026-10.md). The one real run so
   far, with numbers and what it changed.

Version: these pages describe percheron 0.0.1. The spec format is `0.2` and will change.
