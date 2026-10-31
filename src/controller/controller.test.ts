/**
 * Controller: dispatch-time budget guard + limit propagation + violation
 * feedback. In-memory doubles for provider, adapter, ledger — no model calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Adapter, TaskRef, TaskRequest, TaskResult, TaskStatus, WorkspaceRef } from "../contracts/adapter.js";
import type { Ledger, LedgerEvent, LedgerEventRecord, NodePipelineState } from "../contracts/ledger.js";
import type { Provider } from "../contracts/provider.js";
import { Controller } from "./controller.js";
import type { EngagementSpec } from "./spec.js";

class MemLedger implements Ledger {
  nodes = new Map<string, NodePipelineState>();
  events: LedgerEventRecord[] = [];
  async load() {
    return { nodes: [...this.nodes.values()].map((n) => structuredClone(n)), events: this.events };
  }
  async setNodeState(state: NodePipelineState) {
    this.nodes.set(state.nodeKey, structuredClone(state));
  }
  async append(event: LedgerEvent) {
    this.events.push({ at: new Date().toISOString(), event });
  }
  kinds() {
    return this.events.map((e) => e.event.kind);
  }
}

/** Scripted adapter: each createTask pops the next result off the queue. */
class ScriptedAdapter implements Adapter {
  requests: TaskRequest[] = [];
  results: TaskResult[] = [];
  constructor(private readonly script: TaskResult[]) {
    this.results = [...script];
  }
  info() {
    return { id: "fake", version: "0", observation: ["poll" as const], workspaceKinds: ["worktree" as const] };
  }
  async provisionWorkspace(nodeKey: string): Promise<WorkspaceRef> {
    return { id: nodeKey, kind: "worktree", location: `/ws/${nodeKey}` };
  }
  async releaseWorkspace() {}
  async createTask(request: TaskRequest): Promise<TaskRef> {
    this.requests.push(request);
    return { adapterId: "fake", id: String(this.requests.length) };
  }
  async status(ref: TaskRef): Promise<TaskStatus> {
    const result = this.results[Number(ref.id) - 1];
    if (!result) throw new Error("unscripted task");
    return { state: "exited", result };
  }
  async cancel() {}
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }
}

const provider: Provider<unknown> = {
  info: () => ({ id: "fake", version: "0", requires: [] }),
  parseConfig: (raw) => raw,
  preflight: async () => [],
  deriveGraph: async () => ({
    nodes: [{ key: "n1", dependsOn: [], meta: {} }],
    derivedFrom: { id: "fake", version: "0" },
  }),
  readiness: async () => ({ ready: true, blockedBy: [] }),
  nodeContext: async (_c, node) => ({ key: node.key, briefRefs: [], facts: {} }),
  onTransition: async () => {},
};

function spec(budgets: EngagementSpec["budgets"]): EngagementSpec {
  return {
    name: "t",
    work: { provider: "fake", config: {} },
    roles: { implementer: { adapter: "fake" } },
    pipeline: {
      entry: "implement",
      guards: { maxRounds: 5, maxHops: 20 },
      steps: [
        {
          id: "implement",
          kind: "agent",
          role: "implementer",
          contractRef: "roles/implementer.md",
          produces: ["report"],
          on: { done: "node-done", failed: "implement", blocked: "escalate" },
        },
      ],
    },
    ...(budgets ? { budgets } : {}),
  };
}

const done = (usd: number): TaskResult => ({
  exit: "done",
  artifacts: [{ kind: "report", ref: "/dev/null" }],
  spend: { usd },
});
const failed = (usd: number, violations?: string[]): TaskResult => ({
  exit: "failed",
  artifacts: [],
  spend: { usd },
  ...(violations ? { violations } : {}),
});

async function run(s: EngagementSpec, adapter: ScriptedAdapter, ticks = 6) {
  const ledger = new MemLedger();
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < ticks; i++) await c.tick();
  return { ledger, summary: await c.summary() };
}

test("limits ride into the dispatch: remaining node budget + per-task caps", async () => {
  const adapter = new ScriptedAdapter([done(0.5)]);
  await run(spec({ perNodeUsd: 2, perTask: { usd: 5, maxTurns: 30, timeoutMs: 60_000 } }), adapter);
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(adapter.requests[0]?.limits, { usd: 2, maxTurns: 30, timeoutMs: 60_000 });
});

test("per-task usd is capped by the spec's per-task ceiling when smaller than headroom", async () => {
  const adapter = new ScriptedAdapter([done(0.5)]);
  await run(spec({ perNodeUsd: 10, perTask: { usd: 3 } }), adapter);
  assert.equal(adapter.requests[0]?.limits?.usd, 3);
});

test("no budgets → no limits field at all", async () => {
  const adapter = new ScriptedAdapter([done(0.5)]);
  await run(spec(undefined), adapter);
  assert.equal("limits" in (adapter.requests[0] ?? {}), false);
});

test("a successful exit that overshoots the cap is NOT killed after the fact", async () => {
  // Benchmark finding: the post-exit guard escalated a run that had already
  // produced its artifacts. Now: done routes as done; spend is recorded.
  const adapter = new ScriptedAdapter([done(14.3)]);
  const { ledger, summary } = await run(spec({ perNodeUsd: 12 }), adapter);
  assert.deepEqual(summary.done, ["n1"]);
  assert.ok(!ledger.kinds().includes("guard-exceeded"));
  assert.equal(ledger.nodes.get("n1")?.spend.usd, 14.3);
});

test("the budget guard bites at the NEXT dispatch, before any spend", async () => {
  // Round 0 fails having spent 1.2 of a 1.0 cap; the retry must not launch.
  const adapter = new ScriptedAdapter([failed(1.2), done(0.1)]);
  const { ledger, summary } = await run(spec({ perNodeUsd: 1 }), adapter);
  assert.equal(adapter.requests.length, 1, "retry was dispatched despite exhausted budget");
  assert.deepEqual(summary.escalated, ["n1"]);
  const guard = ledger.events.find((e) => e.event.kind === "guard-exceeded")?.event;
  assert.ok(guard && guard.kind === "guard-exceeded");
  assert.equal(guard.exceeded.guard, "budget");
  assert.equal(guard.exceeded.limit, 1);
  assert.equal(guard.exceeded.actual, 1.2);
});

test("dispatchFloorUsd treats thin headroom as exhausted", async () => {
  const adapter = new ScriptedAdapter([failed(0.9), done(0.1)]);
  const { summary } = await run(spec({ perNodeUsd: 1, dispatchFloorUsd: 0.25 }), adapter);
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(summary.escalated, ["n1"]);
});

test("the retry carries the remaining headroom, not the full cap", async () => {
  const adapter = new ScriptedAdapter([failed(0.4), done(0.1)]);
  await run(spec({ perNodeUsd: 1 }), adapter);
  assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[0]?.limits?.usd, 1);
  assert.ok(Math.abs((adapter.requests[1]?.limits?.usd ?? 0) - 0.6) < 1e-9);
});

test("adapter violations demote the exit and ride into the retry as named feedback", async () => {
  const adapter = new ScriptedAdapter([
    { ...done(0.1), violations: ["workspace-escape: 1 path(s) written to the main checkout"] },
    done(0.1),
  ]);
  const { ledger, summary } = await run(spec({ perNodeUsd: 5 }), adapter);
  assert.deepEqual(summary.done, ["n1"]);
  assert.equal(adapter.requests.length, 2, "violating task must be retried, not accepted");
  const exited = ledger.events.filter((e) => e.event.kind === "exited" && e.event.stepId === "implement");
  assert.equal(exited[0]?.event.kind === "exited" && exited[0].event.exit, "failed");
  const feedback = adapter.requests[1]?.context.facts["lastValidateFailure"] ?? "";
  assert.match(feedback, /workspace-escape/);
  assert.match(feedback, /violated harness guarantees/);
});
