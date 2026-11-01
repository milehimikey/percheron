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
  async exec(_ws: WorkspaceRef, _command: string[]) {
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

test("engagement goalSpec and briefing lead every agent's briefRefs", async () => {
  const adapter = new ScriptedAdapter([done(0.1)]);
  const s = spec(undefined);
  s.engagement = { goalSpec: "/abs/goal-spec.md", briefing: "/abs/briefing.md" };
  await run(s, adapter);
  assert.deepEqual(adapter.requests[0]?.context.briefRefs, ["/abs/goal-spec.md", "/abs/briefing.md"]);
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

test("check steps run asynchronously: a slow check never blocks the tick loop", async () => {
  // Two nodes; node A's check takes 300ms. While it runs, node B must still
  // be collected on the next tick.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const adapter = new ScriptedAdapter([done(0.1), done(0.1)]);
  adapter.exec = async () => { await gate; return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; };
  const twoNodes: Provider<unknown> = {
    ...provider,
    deriveGraph: async () => ({
      nodes: [{ key: "n1", dependsOn: [], meta: {} }, { key: "n2", dependsOn: [], meta: {} }],
      derivedFrom: { id: "fake", version: "0" },
    }),
  };
  const s = spec(undefined);
  s.pipeline.steps = [
    { id: "implement", kind: "agent", role: "implementer", contractRef: "r.md", produces: ["report"], on: { done: "validate", failed: "escalate" } },
    { id: "validate", kind: "check", run: [["true"]], on: { done: "node-done", failed: "escalate" } },
  ];
  const ledger = new MemLedger();
  const c = new Controller(s, { provider: twoNodes, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  await c.tick(); // dispatch both
  await c.tick(); // collect both exits → both enter validate
  const t0 = Date.now();
  await c.tick(); // checks START; the tick must return without waiting on exec
  assert.ok(Date.now() - t0 < 200, "tick blocked on the check");
  let sum = await c.summary();
  assert.equal(sum.pending.length, 2);
  await c.tick(); // still running: nothing collected, nothing blocked
  assert.equal((await c.summary()).done.length, 0);
  release();
  await new Promise((r) => setTimeout(r, 20));
  await c.tick(); // both checks collected
  sum = await c.summary();
  assert.deepEqual(sum.done.sort(), ["n1", "n2"]);
  assert.equal(ledger.kinds().filter((k) => k === "check").length, 2);
});

test("failureExcerpt keeps the failing test names and assertion text, drops INFO noise", async () => {
  const { failureExcerpt } = await import("./controller.js");
  const gradle = [
    "> Task :compileKotlin",
    "FulfillHoldTest > fulfils the oldest hold() FAILED",
    "    org.opentest4j.AssertionFailedError: expected: <h1> but was: <h2>",
    "        at FulfillHoldTest.kt:42",
    ...Array.from({ length: 40 }, (_, i) => `2026-10-31T00:42:08.556-06:00  INFO 36550 --- [ionShutdownHook] PooledStreamingEventProcessor : Stopping processor ${i}`),
    "731 tests completed, 6 failed",
    "FAILURE: Build failed with an exception.",
    "> There were failing tests. See the report at: file:///x/index.html",
  ].join("\n");
  const ex = failureExcerpt(gradle);
  assert.match(ex, /fulfils the oldest hold\(\) FAILED/);
  assert.match(ex, /expected: <h1> but was: <h2>/);
  assert.match(ex, /731 tests completed, 6 failed/);
  assert.ok(!/INFO 36550/.test(ex), "INFO noise must be dropped");
  assert.ok(ex.split("\n").length < 20);
});

test("reopen: a human un-escalates a node; it re-enters at round 0 with its failure as feedback", async () => {
  // maxRounds=1: one retry on the implement->implement edge; the second
  // failure exhausts it → escalated. Reopen → dispatch again.
  const adapter = new ScriptedAdapter([failed(0.1), failed(0.1), done(0.1)]);
  const s = spec({ perNodeUsd: 5 });
  s.pipeline.guards.maxRounds = 1;
  // Tight enough that the hops of the two failed rounds would exceed it if
  // they carried over (benchmark: a reopened node died at 17/16 on step one).
  s.pipeline.guards.maxHops = 3;
  s.work.transitions = { onEscalate: "held", onReopen: "planned" };
  const transitions: string[] = [];
  const p: Provider<unknown> = { ...provider, onTransition: async (_c, _k, t) => { transitions.push(t.to); } };
  const ledger = new MemLedger();
  const c = new Controller(s, { provider: p, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 6; i++) await c.tick();
  assert.deepEqual((await c.summary()).escalated, ["n1"]);
  assert.equal(adapter.requests.length, 2);
  await assert.rejects(c.reopen("ghost", "x"), /not a node/);
  const hopsBefore = ledger.nodes.get("n1")!.hops;
  assert.ok(hopsBefore >= 2, `two failed rounds consumed hops (${hopsBefore})`);
  await c.reopen("n1", "lint slip after a real fix; one more round");
  assert.deepEqual(transitions.slice(-1), ["planned"]);
  assert.equal(ledger.nodes.get("n1")!.hops, 0, "hops restart per reopen generation");
  assert.equal(ledger.nodes.get("n1")!.lifetimeHops, hopsBefore, "lifetime hops are kept for reporting");
  assert.ok(ledger.kinds().includes("reopened"));
  for (let i = 0; i < 4; i++) await c.tick();
  assert.equal(adapter.requests.length, 3, "reopened node must dispatch again");
  assert.equal(adapter.requests[0]?.idempotencyKey, "t/n1/implement/r0");
  assert.equal(adapter.requests[2]?.idempotencyKey, "t/n1/implement/g1r0", "a reopened round 0 must be a NEW idempotency key");
  assert.equal(adapter.requests[2]?.context.facts["lastValidateFailure"], undefined, "scripted failures carry no check feedback");
  assert.deepEqual((await c.summary()).done, ["n1"]);
  await assert.rejects(c.reopen("n1", "again"), /not escalated/);
});

test("failureExcerpt: a WARN storm does not bury the one real assertion", async () => {
  const { failureExcerpt } = await import("./controller.js");
  const out = [
    ...Array.from({ length: 80 }, (_, i) => `2026-10-31T01:13:31.180-06:00  WARN 13276 --- [n.tokenprobe]-0] o.a.m.e.p.streaming.pooled.Coordinator   : Processor [x${i}] Exception occurred while starting work packages`),
    "io.grpc.StatusRuntimeException: UNAVAILABLE",
    "\tat io.grpc.Status.asRuntimeException(Status.java:532) ~[grpc-api-1.79.0.jar:1.79.0]",
    "MyHoldsEndpointTest > lists holds() FAILED",
    "    java.lang.AssertionError: JSON path \"$[0].status\" expected:<waiting> but was:<ready-for-pickup>",
    "732 tests completed, 1 failed",
  ].join("\n");
  const ex = failureExcerpt(out);
  assert.match(ex, /MyHoldsEndpointTest > lists holds\(\) FAILED/);
  assert.match(ex, /expected:<waiting> but was:<ready-for-pickup>/);
  assert.ok(!/WARN 13276/.test(ex));
  assert.ok(ex.split("\n").length <= 6, ex);
});

test("reject: the human at a parked gate says no → the gate's failed route (escalate) → reopen carries the note", async () => {
  const adapter = new ScriptedAdapter([done(0.1), done(0.1)]);
  const s = spec({ perNodeUsd: 5 });
  s.pipeline.steps[0]!.on = { done: "merge-gate", failed: "implement", blocked: "escalate" };
  s.pipeline.steps.push({
    id: "merge-gate",
    kind: "human",
    gate: { summary: "merge it" },
    acceptance: { observer: "never", candidateRef: "branch", verdicts: ["merged"] },
    on: { done: "node-done", failed: "escalate" },
  });
  s.work.transitions = { onEscalate: "held", onReopen: "planned" };
  const transitions: string[] = [];
  const p: Provider<unknown> = { ...provider, onTransition: async (_c, _k, t) => { transitions.push(t.to); } };
  const ledger = new MemLedger();
  const never = { id: "never", check: async () => ({ satisfied: false, evidence: [] }) };
  const c = new Controller(s, { provider: p, adapters: { fake: adapter }, observers: { never }, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 4; i++) await c.tick();
  assert.deepEqual((await c.summary()).parked, ["n1"], "node parks at the gate");
  await assert.rejects(c.rejectGate("ghost", "x"), /not a node/);
  await c.rejectGate("n1", "critic's major stands: ordering is not guaranteed in the app", { feedback: "use the hook shape" });
  assert.deepEqual((await c.summary()).escalated, ["n1"], "the gate's failed route escalates");
  assert.ok(ledger.kinds().includes("gate-rejected"));
  assert.deepEqual(transitions.slice(-1), ["held"]);
  await assert.rejects(c.rejectGate("n1", "again"), /not parked/);
  await c.reopen("n1", "rework under the clarified ruling");
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal(adapter.requests.length, 2, "reopened node dispatches again");
  assert.equal(adapter.requests[1]?.context.facts["lastValidateFailure"], "human note: use the hook shape");
});

/** ScriptedAdapter whose exec answers from a script keyed by the command's binary. */
class ExecAdapter extends ScriptedAdapter {
  evidence: Array<{ nodeKey: string; name: string; content: string }> = [];
  constructor(script: TaskResult[], private readonly execs: Record<string, Array<{ exitCode: number; stdout?: string }>>) {
    super(script);
  }
  override async exec(_ws: WorkspaceRef, command: string[]) {
    const next = this.execs[command[0] ?? ""]?.shift();
    if (!next) return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    return { exitCode: next.exitCode, stdout: next.stdout ?? "", stderr: "", durationMs: 0 };
  }
  async recordEvidence(nodeKey: string, name: string, content: string) {
    this.evidence.push({ nodeKey, name, content });
    return `/ev/${nodeKey}/${name}`;
  }
}

function pipelineWithCheck(): EngagementSpec {
  const s = spec({ perNodeUsd: 50 });
  s.roles["critic"] = { adapter: "fake" };
  s.pipeline.steps = [
    { id: "implement", kind: "agent", role: "implementer", contractRef: "roles/implementer.md", produces: ["report"], on: { done: "validate", failed: "implement", blocked: "escalate" } },
    { id: "validate", kind: "check", run: [["./gradlew", "test", "--quiet"]], on: { done: "critique", failed: "implement" } },
    { id: "critique", kind: "agent", role: "critic", contractRef: "roles/critic.md", produces: ["report"], on: { done: "node-done", failed: "implement", blocked: "escalate" } },
  ];
  return s;
}

test("rounds are counted per loop-back edge: a validate slip does not spend a findings round", async () => {
  // implement → validate FAIL → implement → validate ok → critique failed → implement
  //           → validate ok → critique failed → escalate (critique->implement taken twice, max 1).
  // Under one shared counter the FIRST critique failure would already have escalated.
  // Agent results in dispatch order: implement, implement (after the slip), critique, implement, critique.
  const adapter = new ExecAdapter(
    [done(0.1), done(0.1), failed(0.1), done(0.1), failed(0.1)],
    { "./gradlew": [{ exitCode: 1, stdout: "e: Foo.kt:3:1 Unresolved reference\nBUILD FAILED" }] },
  );
  const s = pipelineWithCheck();
  s.pipeline.guards.maxRounds = 1;
  const ledger = new MemLedger();
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 30; i++) await c.tick();
  assert.deepEqual((await c.summary()).escalated, ["n1"]);
  assert.equal(adapter.requests.length, 5, "three implement dispatches and two critiques");
  const state = ledger.nodes.get("n1")!;
  assert.deepEqual(state.rounds, { "validate->implement": 1, "critique->implement": 2 });
  assert.equal(state.round, 3, "the monotonic round still counts every loop-back");
  const guard = ledger.events.map((e) => e.event).find((e) => e.kind === "guard-exceeded");
  assert.ok(guard && guard.kind === "guard-exceeded");
  assert.deepEqual(guard.exceeded, { guard: "maxRounds", limit: 1, actual: 2, nodeKey: "n1", detail: "critique->implement" });
  assert.match(adapter.requests[1]?.context.facts["lastValidateFailure"] ?? "", /Unresolved reference/);
});

test("check failure under gradle --quiet: the JUnit XML names the test, the full output is filed as evidence", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.toolshed.HoldsToFulfillProjectionTest" tests="2" failures="1">
  <testcase name="fulfilled hold leaves the list()" classname="com.toolshed.HoldsToFulfillProjectionTest" time="0.1">
    <failure message="expected:&lt;0&gt; but was:&lt;1&gt;&#10;second line" type="AssertionError">stack</failure>
  </testcase>
  <testcase name="placed hold appears()" classname="com.toolshed.HoldsToFulfillProjectionTest" time="0.1"/>
</testsuite>`;
  const quiet = "\n12 tests completed, 1 failed\nThere were failing tests. See the report at: file:///ws/n1/build/reports/tests/test/index.html\n";
  // implement, implement (retry), critique → node-done.
  const adapter = new ExecAdapter([done(0.1), done(0.1), done(0.1)], {
    "./gradlew": [{ exitCode: 1, stdout: quiet }],
    grep: [{ exitCode: 0, stdout: "/ws/n1/build/test-results/test/TEST-com.toolshed.HoldsToFulfillProjectionTest.xml\n" }],
    cat: [{ exitCode: 0, stdout: xml }],
  });
  const s = pipelineWithCheck();
  const ledger = new MemLedger();
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 12; i++) await c.tick();
  const feedback = adapter.requests[1]?.context.facts["lastValidateFailure"] ?? "";
  assert.match(feedback, /^\.\/gradlew test --quiet exited 1:\nFAILED com\.toolshed\.HoldsToFulfillProjectionTest\.fulfilled hold leaves the list\(\): expected:<0> but was:<1>\n/);
  assert.match(feedback, /12 tests completed, 1 failed/);
  assert.match(feedback, /full output: \/ev\/n1\/validate-g0r0\.log$/);
  assert.equal(adapter.evidence.length, 1);
  assert.match(adapter.evidence[0]!.content, /^\$ \.\/gradlew test --quiet\nexit 1\n/);
  assert.match(adapter.evidence[0]!.content, /See the report at/);
  const check = ledger.events.map((e) => e.event).find((e) => e.kind === "check");
  assert.ok(check && check.kind === "check" && /FAILED com\.toolshed/.test(check.detail) && /full output:/.test(check.detail));
});

test("testResultDirs: gradle report path, explicit dir, and the bare summary fallback", async () => {
  const { testResultDirs } = await import("./controller.js");
  assert.deepEqual(testResultDirs("See the report at: file:///r/build/reports/tests/test/index.html"), ["/r/build/test-results/test"]);
  assert.deepEqual(testResultDirs("wrote /r/build/test-results/integrationTest/TEST-x.xml"), ["/r/build/test-results/integrationTest/TEST-x.xml".replace("/TEST-x.xml", "")]);
  assert.deepEqual(testResultDirs("3 tests completed, 1 failed"), ["build/test-results"]);
  assert.deepEqual(testResultDirs("BUILD FAILED"), []);
});

test("junitFailureLines: failures and errors, unescaped, self-closing passes skipped", async () => {
  const { junitFailureLines } = await import("./controller.js");
  const lines = junitFailureLines(`<testsuite>
  <testcase name="a()" classname="C"><failure message="x &amp;&amp; y &quot;q&quot;"/></testcase>
  <testcase name="b()" classname="C"/>
  <testcase name="c()" classname="D"><error message="boom" type="E">trace</error></testcase>
  <testcase name="d()" classname="D"><failure type="E">no message</failure></testcase>
</testsuite>`);
  assert.deepEqual(lines, ['FAILED C.a(): x && y "q"', "FAILED D.c(): boom", "FAILED D.d()"]);
});

test("retryUnrelated: a failure naming only tests outside the node's diff is re-run once, and a passing re-run spends no round", async () => {
  const xml = `<testsuite name="com.toolshed.placehold.PlaceHoldEndpointTest" tests="1" failures="0" errors="1">
  <testcase name="initializationError" classname="com.toolshed.placehold.PlaceHoldEndpointTest" time="0">
    <error message="ConditionTimeoutException: Axon Server container" type="E">trace</error>
  </testcase>
</testsuite>`;
  const quiet = "\n975 tests completed, 1 failed\nSee the report at: file:///ws/n1/build/reports/tests/test/index.html\nBUILD FAILED in 20m 45s\n";
  // implement, critique → node-done; the second gradlew call passes.
  const adapter = new ExecAdapter([done(0.1), done(0.1)], {
    "./gradlew": [{ exitCode: 1, stdout: quiet }, { exitCode: 0, stdout: "" }],
    grep: [{ exitCode: 0, stdout: "/ws/n1/build/test-results/test/TEST-com.toolshed.placehold.PlaceHoldEndpointTest.xml\n" }],
    cat: [{ exitCode: 0, stdout: xml }],
    git: [{ exitCode: 0, stdout: "src/main/kotlin/com/toolshed/myaccount/MyAccountProjection.kt\nsrc/test/kotlin/com/toolshed/myaccount/MyAccountProjectionTest.kt\n" }],
  });
  const s = pipelineWithCheck();
  const validate = s.pipeline.steps.find((st) => st.id === "validate")!;
  assert.equal(validate.kind, "check");
  if (validate.kind === "check") validate.retryUnrelated = 1;
  const ledger = new MemLedger();
  const logs: string[] = [];
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: (l) => logs.push(l) });
  await c.plan();
  for (let i = 0; i < 12; i++) await c.tick();
  assert.deepEqual((await c.summary()).done, ["n1"]);
  assert.equal(adapter.requests.length, 2, "implement and critique only: no retry round was spent");
  assert.equal(ledger.nodes.get("n1")!.rounds, undefined);
  assert.ok(logs.some((l) => /check validate failed on 1 failing test\(s\) outside this node's diff: com\.toolshed\.placehold\.PlaceHoldEndpointTest\.initializationError; re-running \(1\/1\)/.test(l)), logs.join("\n"));
  assert.deepEqual(adapter.evidence.map((e) => e.name), ["validate-g0r0-try1.log"], "the first attempt's output is still filed");
  const check = ledger.events.map((e) => e.event).find((e) => e.kind === "check");
  assert.ok(check && check.kind === "check" && check.pass && /re-running \(1\/1\)/.test(check.detail));
});

test("retryUnrelated: a failure that names a test the diff touches is routed as failed at once", async () => {
  const xml = `<testsuite><testcase name="t()" classname="com.toolshed.myaccount.MyAccountProjectionTest"><failure message="nope"/></testcase></testsuite>`;
  const quiet = "\n3 tests completed, 1 failed\n";
  const adapter = new ExecAdapter([done(0.1), done(0.1), done(0.1)], {
    "./gradlew": [{ exitCode: 1, stdout: quiet }, { exitCode: 0, stdout: "" }],
    grep: [{ exitCode: 0, stdout: "build/test-results/TEST-x.xml\n" }],
    cat: [{ exitCode: 0, stdout: xml }],
    git: [{ exitCode: 0, stdout: "src/main/kotlin/com/toolshed/myaccount/MyAccountProjection.kt\n" }],
  });
  const s = pipelineWithCheck();
  const validate = s.pipeline.steps.find((st) => st.id === "validate")!;
  if (validate.kind === "check") validate.retryUnrelated = 1;
  const ledger = new MemLedger();
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 14; i++) await c.tick();
  assert.equal(adapter.requests.length, 3, "implement, implement (retry), critique");
  assert.deepEqual(ledger.nodes.get("n1")!.rounds, { "validate->implement": 1 });
  assert.match(adapter.requests[1]?.context.facts["lastValidateFailure"] ?? "", /FAILED com\.toolshed\.myaccount\.MyAccountProjectionTest\.t\(\): nope/);
});

test("ktlint: the report file is read and its findings ride into the feedback as KTLINT lines", async () => {
  const out = "\nFAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':ktlintMainSourceSetCheck'.\n   > KtLint found code style violations. Please see the following reports:\n     - /ws/n1/build/reports/ktlint/ktlintMainSourceSetCheck/ktlintMainSourceSetCheck.txt\n";
  const report = "\x1b[90msrc/main/kotlin/com/toolshed/toolinventory/\x1b[0mToolInventoryProjection.kt\x1b[90m:\x1b[0m38\x1b[90m:22:\x1b[0m Newline expected after opening brace \x1b[90m(standard:function-literal)\x1b[0m\n\nSummary error count (descending) by rule:\n  standard:function-literal: 1\n";
  const adapter = new ExecAdapter([done(0.1), done(0.1), done(0.1)], {
    "./gradlew": [{ exitCode: 1, stdout: out }],
    cat: [{ exitCode: 0, stdout: report }],
  });
  const s = pipelineWithCheck();
  const ledger = new MemLedger();
  const c = new Controller(s, { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 12; i++) await c.tick();
  const feedback = adapter.requests[1]?.context.facts["lastValidateFailure"] ?? "";
  assert.match(feedback, /^\.\/gradlew test --quiet exited 1:\nKTLINT src\/main\/kotlin\/com\/toolshed\/toolinventory\/ToolInventoryProjection\.kt:38:22: Newline expected after opening brace \(standard:function-literal\)\n/);
  assert.doesNotMatch(feedback, /\x1b/);
});

test("ktlintReportFiles / ktlintReportLines / failuresUnrelatedToDiff", async () => {
  const { ktlintReportFiles, ktlintReportLines, failuresUnrelatedToDiff } = await import("./controller.js");
  assert.deepEqual(ktlintReportFiles("reports:\n - /r/build/reports/ktlint/ktlintTestSourceSetCheck/ktlintTestSourceSetCheck.txt\n - file:///r/build/reports/ktlint/a/a.txt"), [
    "/r/build/reports/ktlint/ktlintTestSourceSetCheck/ktlintTestSourceSetCheck.txt",
    "/r/build/reports/ktlint/a/a.txt",
  ]);
  assert.deepEqual(ktlintReportFiles("BUILD FAILED"), []);
  assert.deepEqual(ktlintReportLines("A.kt:1:2: msg (standard:x)\nnot a finding\nb/B.kts:3:4: other\n"), ["KTLINT A.kt:1:2: msg (standard:x)", "KTLINT b/B.kts:3:4: other"]);
  const far = ["FAILED com.toolshed.placehold.PlaceHoldEndpointTest.initializationError: timeout"];
  const diff = ["src/main/kotlin/com/toolshed/myaccount/MyAccountProjection.kt"];
  assert.equal(failuresUnrelatedToDiff(far, diff), true);
  assert.equal(failuresUnrelatedToDiff(["FAILED com.toolshed.myaccount.MyAccountProjectionTest.t(): x"], diff), false, "same package as the diff");
  assert.equal(failuresUnrelatedToDiff(["FAILED com.other.MyAccountProjection.t(): x"], diff), false, "same simple name as a changed file");
  assert.equal(failuresUnrelatedToDiff(["FAILED com.toolshed.placehold.Outer$Inner.t(): x"], diff), true, "nested class uses the outer file");
  assert.equal(failuresUnrelatedToDiff([], diff), false, "no named test: the failure is the node's");
  assert.equal(failuresUnrelatedToDiff(far, []), false, "no diff: nothing to compare against");
});

function pipelineWithJudge(): EngagementSpec {
  const s = spec({ perNodeUsd: 50 });
  s.roles["judge"] = { adapter: "fake", model: "haiku" };
  s.pipeline.steps = [
    { id: "implement", kind: "agent", role: "implementer", contractRef: "roles/implementer.md", produces: ["report"], on: { done: "judge", failed: "implement", blocked: "escalate" } },
    { id: "judge", kind: "judge", role: "judge", contractRef: "roles/judge.md", rubrics: ["slice-doc-quality"], rubricRefs: ["/r/rubrics/slice-doc-quality.md"], on: { done: "node-done" } },
  ];
  return s;
}

test("judge: a read-only task scores the rubric, the typed verdict is recorded, and on.done is taken", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "percheron-judge-"));
  const verdictPath = join(dir, "verdict.md");
  await writeFile(verdictPath, 'Scored.\n```json\n{"rubric":"slice-doc-quality","criteria":[{"id":"fields","score":1,"evidence":"Row.kt:3"},{"id":"scenarios","score":0.5,"note":"one missing"},{"id":"observability","score":0}],"summary":"two gaps"}\n```\n');
  const judged: TaskResult = { exit: "done", artifacts: [{ kind: "verdict", ref: verdictPath }], spend: { usd: 0.05 } };
  const adapter = new ScriptedAdapter([done(0.1), judged]);
  const ledger = new MemLedger();
  const logs: string[] = [];
  const c = new Controller(pipelineWithJudge(), { provider, adapters: { fake: adapter }, observers: {}, ledger, log: (l) => logs.push(l) });
  await c.plan();
  for (let i = 0; i < 8; i++) await c.tick();
  assert.deepEqual((await c.summary()).done, ["n1"]);
  const req = adapter.requests[1]!;
  assert.equal(req.role, "judge");
  assert.equal(req.model, "haiku");
  assert.equal(req.readOnly, true);
  assert.deepEqual(req.produces, ["verdict"]);
  assert.ok(req.context.briefRefs.includes("/r/rubrics/slice-doc-quality.md"), "the rubric file is in the judge's reading list");
  assert.equal(req.context.facts["rubrics"], "slice-doc-quality");
  const ev = ledger.events.map((e) => e.event).find((e) => e.kind === "judged");
  assert.ok(ev && ev.kind === "judged");
  assert.deepEqual(ev.rubrics, ["slice-doc-quality"]);
  assert.equal(ev.verdict?.criteria.length, 3);
  assert.equal(ev.verdict?.criteria[1]?.score, 0.5);
  assert.match(ev.detail, /^slice-doc-quality: 2\/3 criteria met, mean 0\.50: two gaps$/);
  assert.equal(ledger.nodes.get("n1")!.refs["verdict:judge"], verdictPath);
  assert.ok(logs.some((l) => /n1: judged judge: slice-doc-quality: 2\/3 criteria met/.test(l)));
  assert.equal((ledger.nodes.get("n1")!.spend.usd ?? 0).toFixed(2), "0.15", "the judge's spend counts against the node");
});

test("judge: a failed judge task, or a missing or malformed verdict, records no verdict and still routes on.done", async () => {
  const adapter = new ScriptedAdapter([done(0.1), failed(0.02, ["max-turns: run stopped at 3 turns (limit 3)"])]);
  const ledger = new MemLedger();
  const c = new Controller(pipelineWithJudge(), { provider, adapters: { fake: adapter }, observers: {}, ledger, log: () => {} });
  await c.plan();
  for (let i = 0; i < 8; i++) await c.tick();
  assert.deepEqual((await c.summary()).done, ["n1"], "advisory: the node is done regardless");
  assert.deepEqual((await c.summary()).escalated, []);
  const ev = ledger.events.map((e) => e.event).find((e) => e.kind === "judged");
  assert.ok(ev && ev.kind === "judged" && ev.verdict === null && /exited failed \(max-turns/.test(ev.detail));
  assert.equal(ledger.nodes.get("n1")!.rounds, undefined, "no round was spent");
});

test("parseJudgeVerdict: fenced or bare JSON, boolean scores, and rejection of the malformed", async () => {
  const { parseJudgeVerdict } = await import("./controller.js");
  assert.deepEqual(parseJudgeVerdict('{"rubric":"r","criteria":[{"id":"a","score":true},{"id":"b","score":0.25,"note":"n"}]}'), {
    rubric: "r",
    criteria: [{ id: "a", score: 1 }, { id: "b", score: 0.25, note: "n" }],
  });
  assert.equal(parseJudgeVerdict("no json here"), null);
  assert.equal(parseJudgeVerdict('{"rubric":"r","criteria":[{"id":"a","score":7}]}'), null, "score out of range");
  assert.equal(parseJudgeVerdict('{"rubric":"r","criteria":[{"score":1}]}'), null, "criterion without id");
  assert.equal(parseJudgeVerdict('{"criteria":[]}'), null, "no rubric");
  assert.deepEqual(parseJudgeVerdict('text\n```json\n{"rubric":"x","criteria":[],"summary":"s"}\n```')?.summary, "s");
});
