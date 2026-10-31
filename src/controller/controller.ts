/**
 * The percheron controller — a small deterministic engine, no model calls.
 *
 * Responsibilities (and nothing else):
 *   derive the graph from the provider · dispatch agent steps through
 *   adapters · run check steps via adapter-located exec and judge them ·
 *   route on the closed exit enum · enforce guards and budgets honestly ·
 *   park at human gates and wake on observed facts · keep both ledgers true.
 *
 * All judgment lives elsewhere: in the gates (checks), the agents (review),
 * and the human (merge). The controller is the state machine — on purpose
 * (Khourshid's critique, accepted as the design).
 *
 * Budget policy (v0.2, from the toolshed benchmark): the node budget is
 * checked AT DISPATCH and the remaining headroom travels with the task as an
 * adapter-enforced ceiling. A task that exits `done` is never escalated for
 * spend after the fact — the post-exit guard once killed a successful run.
 *
 * Limitations, explicit:
 *   - judge steps are pass-through placeholders (logged, never routing).
 *   - dispatch policy: a node dispatches when every dependsOn node is
 *     terminal-done, readiness.ready is true, and no provider hold
 *     (meta.held) is present — the conservative reading; em itself treats
 *     in-engagement upstreams as ordering only.
 */

import type { Adapter, TaskRequest } from "../contracts/adapter.js";
import type { ExitKind } from "../contracts/core.js";
import type {
  AcceptanceObserver,
  Ledger,
  NodePipelineState,
} from "../contracts/ledger.js";
import type { NodeContext, Provider } from "../contracts/provider.js";
import type { WorkGraph, WorkNode } from "../contracts/core.js";
import type {
  AgentStepSpec,
  CheckStepSpec,
  EngagementSpec,
  HumanStepSpec,
  RouteTarget,
  StepSpec,
} from "./spec.js";

export interface ControllerDeps {
  provider: Provider<unknown>;
  adapters: Record<string, Adapter>;
  observers: Record<string, AcceptanceObserver>;
  ledger: Ledger;
  /** Progress lines for a human tail; default console.error. */
  log?: (line: string) => void;
}

/**
 * Loop feedback must name the failure, not the noise around it (scale
 * benchmark: a 900s gradle run ended in 30 lines of Axon shutdown INFO logs
 * and "6 failed" — the retry learned nothing). Keep the lines that carry
 * failure signatures (test names, assertion text, compiler errors, failed
 * tasks), then the tail for the summary.
 */
export function failureExcerpt(output: string, opts: { maxSignal?: number; tail?: number } = {}): string {
  const maxSignal = opts.maxSignal ?? 60;
  const tailN = opts.tail ?? 12;
  const lines = output.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const signal = /FAILED|FAIL\b|\berror\b|Error|Exception|expected|but was|but got|AssertionError|assert|\be: |Task .* FAILED|tests completed|failing|not found|Unresolved|cannot|BUILD FAILED/;
  // Framework log lines (any level below ERROR) are noise even when they say
  // "Exception": a gRPC WARN storm buried the one real AssertionError.
  const noise = /^\S+\s+(INFO|DEBUG|TRACE|WARN)\s|^\d{4}-\d{2}-\d{2}T[^ ]+\s+(INFO|DEBUG|TRACE|WARN)\b|^\s+at [\w.$]+\(|^io\.grpc\.|\[grpc-/;
  const picked = lines.filter((l) => signal.test(l) && !noise.test(l)).slice(0, maxSignal);
  const tail = lines.filter((l) => !noise.test(l)).slice(-tailN);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of [...picked, ...tail]) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out.join("\n");
}

interface CheckOutcome {
  pass: boolean;
  details: string[];
  lastFailure?: string;
}

export interface SettleSummary {
  done: string[];
  escalated: string[];
  parked: string[];
  pending: string[];
}

export class Controller {
  private readonly spec: EngagementSpec;
  private readonly deps: ControllerDeps;
  private readonly steps: Map<string, StepSpec>;
  private readonly stepOrder: string[];
  private providerConfig!: unknown;
  private graph!: WorkGraph;
  private readonly log: (line: string) => void;

  constructor(spec: EngagementSpec, deps: ControllerDeps) {
    this.spec = spec;
    this.deps = deps;
    this.steps = new Map(spec.pipeline.steps.map((s) => [s.id, s]));
    this.stepOrder = spec.pipeline.steps.map((s) => s.id);
    this.log = deps.log ?? ((l) => console.error(`[percheron] ${l}`));
    if (!this.steps.has(spec.pipeline.entry)) {
      throw new Error(`spec: entry step "${spec.pipeline.entry}" not defined`);
    }
    // Validate parallel groups: symmetric membership, agent-kind, identical routes.
    for (const s of spec.pipeline.steps) {
      if (s.kind !== "agent" || !s.parallelWith?.length) continue;
      for (const other of s.parallelWith) {
        const o = this.steps.get(other);
        if (!o || o.kind !== "agent") {
          throw new Error(`spec: ${s.id} parallelWith "${other}" is not an agent step`);
        }
        if (!(o.parallelWith ?? []).includes(s.id)) {
          throw new Error(`spec: parallel group asymmetric — ${other} must list ${s.id}`);
        }
        if (JSON.stringify(o.on) !== JSON.stringify(s.on)) {
          throw new Error(`spec: parallel group ${s.id}/${other} must share an identical "on" map`);
        }
      }
    }
  }

  /** All member steps of the group containing stepId (sorted by declaration order). */
  private group(stepId: string): AgentStepSpec[] {
    const step = this.steps.get(stepId);
    if (!step || step.kind !== "agent" || !step.parallelWith?.length) return [];
    const ids = new Set([step.id, ...step.parallelWith]);
    return this.spec.pipeline.steps.filter(
      (s): s is AgentStepSpec => s.kind === "agent" && ids.has(s.id),
    );
  }

  /** Preflight + derive. Throws on any blocking preflight issue. */
  async plan(): Promise<WorkGraph> {
    this.providerConfig = this.deps.provider.parseConfig(this.spec.work.config);
    const issues = await this.deps.provider.preflight(this.providerConfig);
    for (const i of issues) {
      this.log(`preflight ${i.blocking ? "BLOCKING" : "advisory"} [${i.code}] ${i.detail}`);
    }
    const blocking = issues.filter((i) => i.blocking);
    if (blocking.length > 0) {
      throw new Error(
        `preflight: ${blocking.length} blocking issue(s) — fan-out refused: ${blocking
          .map((i) => i.code)
          .join(", ")}`,
      );
    }
    this.graph = await this.deps.provider.deriveGraph(this.providerConfig);
    this.log(`graph: ${this.graph.nodes.length} node(s) from ${this.graph.derivedFrom.id} ${this.graph.derivedFrom.version}`);
    return this.graph;
  }

  /**
   * One pass over every node: dispatch, poll, judge, route, park, wake.
   * Returns true when anything changed (progress was made).
   */
  async tick(): Promise<boolean> {
    if (!this.graph) await this.plan();
    let progressed = false;
    const states = await this.nodeStates();

    for (const node of this.graph.nodes) {
      const state = states.get(node.key) ?? this.freshState(node.key);
      if (state.terminal) continue;
      const before = JSON.stringify(state);
      await this.advance(node, state, states);
      if (JSON.stringify(state) !== before) {
        await this.deps.ledger.setNodeState(state);
        states.set(node.key, state);
        progressed = true;
      }
    }
    return progressed;
  }

  /**
   * Tick until quiescent: every node terminal, or only parked/held nodes
   * remain and a full tick makes no progress. Parked nodes wake on later
   * runs — the controller is resumable by design, so returning while gates
   * wait is the normal exit, not a failure.
   */
  async runUntilSettled(opts?: {
    pollMs?: number;
    maxTicks?: number;
  }): Promise<SettleSummary> {
    const pollMs = opts?.pollMs ?? 2000;
    const maxTicks = opts?.maxTicks ?? 1000;
    for (let i = 0; i < maxTicks; i++) {
      const progressed = await this.tick();
      const summary = await this.summary();
      if (summary.pending.length === 0 && summary.parked.length === 0) return summary;
      if (!progressed && !(await this.anyRunning())) {
        if (summary.pending.length === 0) return summary; // only parked left
        // pending but nothing running and no progress: wait one poll then retry
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return this.summary();
  }

  /**
   * Operator action: a human reopens an ESCALATED node with a recorded reason.
   * The node re-enters the pipeline at the entry step on the next tick, at
   * round 0 and hop 0 (a reopen is a new traversal; the lifetime hop count is
   * kept on the record) but with its spend and last failure intact (the budget
   * guard stays honest; the failure rides into the retry as feedback).
   * The provider's business state is moved to `transitions.onReopen` first so
   * a provider hold (em: `held`) does not refuse the dispatch. Run it while
   * the controller is stopped: the ledger has one writer.
   */
  async reopen(nodeKey: string, reason: string, opts: { feedback?: string | null } = {}): Promise<void> {
    if (!this.graph) await this.plan();
    const node = this.graph.nodes.find((n) => n.key === nodeKey);
    if (!node) throw new Error(`reopen: "${nodeKey}" is not a node of this engagement`);
    const state = (await this.nodeStates()).get(nodeKey);
    if (!state || state.terminal !== "escalated") {
      throw new Error(`reopen: "${nodeKey}" is not escalated (${state?.terminal ?? state?.stepId ?? "never started"})`);
    }
    delete state.terminal;
    delete state.activeTask;
    delete state.groupTasks;
    delete state.parked;
    state.stepId = null;
    state.round = 0;
    state.generation = (state.generation ?? 0) + 1;
    // maxHops bounds ONE traversal of the pipeline. A reopen is a new traversal
    // under a human's authority, so hops restart; the lifetime count stays on
    // the record for reporting (benchmark: a reopened node at 15/16 hops died
    // on its first step for nothing it did in this generation).
    state.lifetimeHops = (state.lifetimeHops ?? 0) + state.hops;
    state.hops = 0;
    // The human may replace the recorded failure with their own context (the
    // cause was fixed elsewhere; what the retry must know) or clear it.
    if (opts.feedback === null) delete state.refs["lastCheckFailure"];
    else if (typeof opts.feedback === "string") state.refs["lastCheckFailure"] = `human note: ${opts.feedback}`;
    await this.deps.ledger.append({ kind: "reopened", nodeKey, summary: reason });
    await this.transitionBusiness(node, state, this.spec.work.transitions?.onReopen);
    await this.deps.ledger.setNodeState(state);
    this.log(`${nodeKey}: REOPENED by human — ${reason}`);
  }

  async summary(): Promise<SettleSummary> {
    const states = await this.nodeStates();
    const out: SettleSummary = { done: [], escalated: [], parked: [], pending: [] };
    for (const node of this.graph.nodes) {
      const s = states.get(node.key);
      if (s?.terminal === "done") out.done.push(node.key);
      else if (s?.terminal === "escalated") out.escalated.push(node.key);
      else if (s?.parked) out.parked.push(node.key);
      else out.pending.push(node.key);
    }
    return out;
  }

  // ----- per-node state machine -----

  private async advance(
    node: WorkNode,
    state: NodePipelineState,
    states: Map<string, NodePipelineState>,
  ): Promise<void> {
    // Not started: first adopt business reality (fresh-ledger resume must be
    // idempotent against the provider's own ledger — a merged slice is never
    // re-dispatched, an awaiting-merge slice re-parks at its gate).
    if (state.stepId === null) {
      const biz = node.meta["state"];
      if (biz === "merged") {
        state.terminal = "done";
        await this.deps.ledger.append({
          kind: "exited", nodeKey: node.key, stepId: "adopt:merged", exit: "done", artifacts: [],
        });
        this.log(`${node.key}: adopted provider state "merged" — DONE`);
        return;
      }
      if (biz === "gap") {
        state.terminal = "escalated";
        await this.deps.ledger.append({
          kind: "escalated", nodeKey: node.key, summary: 'adopted provider state "gap"',
        });
        return;
      }
      if (biz === "awaiting-merge") {
        const gateStep = this.spec.pipeline.steps.find((s) => s.kind === "human");
        if (gateStep) {
          if (node.meta["branch"]) state.refs["branch"] = node.meta["branch"] as string;
          state.stepId = gateStep.id;
          state.parked = { gateStepId: gateStep.id, since: new Date().toISOString() };
          await this.deps.ledger.append({ kind: "gate-parked", nodeKey: node.key, stepId: gateStep.id });
          this.log(`${node.key}: adopted provider state "awaiting-merge" — re-parked at ${gateStep.id}`);
          return;
        }
      }
      if (!(await this.dispatchable(node, states))) return;
      if (node.meta["branch"]) state.refs["branch"] = node.meta["branch"] as string;
      if (node.meta["base"]) state.refs["base"] = node.meta["base"] as string;
      await this.transitionBusiness(node, state, this.spec.work.transitions?.onDispatch);
      await this.enterStep(node, state, this.spec.pipeline.entry);
      return;
    }

    const step = this.steps.get(state.stepId);
    if (!step) throw new Error(`node ${node.key}: unknown step "${state.stepId}"`);

    switch (step.kind) {
      case "agent":
        if (step.parallelWith?.length) {
          await this.advanceGroup(node, state, step);
          return;
        }
        await this.advanceAgent(node, state, step);
        return;
      case "check":
        await this.advanceCheck(node, state, step);
        return;
      case "human":
        await this.advanceHuman(node, state, step);
        return;
      case "judge":
        await this.deps.ledger.append({
          kind: "check",
          nodeKey: node.key,
          stepId: step.id,
          pass: true,
          detail: `judge pass-through (v0.1): rubrics ${step.rubrics.join(", ")} not evaluated`,
        });
        await this.route(node, state, step.id, step.on["done"] ?? "node-done");
        return;
    }
  }

  private async advanceAgent(
    node: WorkNode,
    state: NodePipelineState,
    step: AgentStepSpec,
  ): Promise<void> {
    const role = this.spec.roles[step.role];
    if (!role) throw new Error(`spec: role "${step.role}" has no binding`);
    const adapter = this.adapter(role.adapter);

    if (!state.activeTask) {
      const limits = await this.dispatchLimits(node, state, 1);
      if (!limits) return; // budget guard fired before any spend
      const ws = await adapter.provisionWorkspace(node.key, {
        ...(state.refs["branch"] ? { branch: state.refs["branch"] } : {}),
        ...(state.refs["base"] ? { base: state.refs["base"] } : {}),
      });
      const context: NodeContext = await this.deps.provider.nodeContext(
        this.providerConfig,
        node,
      );
      context.briefRefs = [...this.specBriefs(), ...context.briefRefs];
      // Loop feedback (the loop's "feedback returns specific failure info"):
      // a prior check failure rides into the retry as a named fact.
      // A recorded failure is the verdict on the previous attempt whatever the
      // round number says (a reopened node restarts at round 0 WITH its history).
      const lastFail = state.refs["lastCheckFailure"];
      if (lastFail) context.facts["lastValidateFailure"] = lastFail;
      const request: TaskRequest = {
        idempotencyKey: this.taskKey(node, state, step.id),
        role: step.role,
        ...(role.model ? { model: role.model } : {}),
        contractRef: step.contractRef,
        context,
        workspace: ws,
        ...(step.readOnly ? { readOnly: true } : {}),
        produces: step.produces,
        ...(Object.keys(limits).length ? { limits } : {}),
      };
      state.activeTask = await adapter.createTask(request);
      await this.deps.ledger.append({
        kind: "dispatched",
        nodeKey: node.key,
        stepId: step.id,
        task: state.activeTask,
      });
      this.log(`${node.key}: dispatched ${step.id} (${step.role}) round ${state.round}`);
      return;
    }

    const status = await adapter.status(state.activeTask);
    if (status.state !== "exited") return;

    const result = status.result;
    delete state.activeTask;
    for (const k of ["usd", "tokens", "wallClockMs"] as const) {
      const v = result.spend[k];
      if (v) state.spend[k] = (state.spend[k] ?? 0) + v;
    }

    // Declared-artifact enforcement (L5): missing artifact = failed exit.
    let exit: ExitKind = result.exit;
    const missing = step.produces.filter(
      (kind) => !result.artifacts.some((a) => a.kind === kind),
    );
    if (exit !== "failed" && missing.length > 0) {
      exit = "failed";
      this.log(`${node.key}: ${step.id} exit demoted to failed — missing artifacts: ${missing.join(", ")}`);
    }
    // Adapter guarantee violations (workspace escape, limit hit): failed, and
    // the named violation rides into the retry as loop feedback.
    if (result.violations?.length) {
      exit = "failed";
      state.refs["lastCheckFailure"] = this.violationFeedback(step.id, result.violations);
      this.log(`${node.key}: ${step.id} violated guarantees — ${result.violations.join("; ")}`);
    }

    // Harvest refs: a `pr` artifact's first line is the PR URL/branch ref.
    const pr = result.artifacts.find((a) => a.kind === "pr");
    if (pr) {
      const { readFile } = await import("node:fs/promises");
      const firstLine = (await readFile(pr.ref, "utf8")).split("\n")[0]?.trim();
      if (firstLine) state.refs["pr"] = firstLine;
    }

    await this.deps.ledger.append({
      kind: "exited",
      nodeKey: node.key,
      stepId: step.id,
      exit,
      artifacts: result.artifacts,
    });
    this.log(`${node.key}: ${step.id} exited ${exit} (${result.artifacts.length} artifact(s))`);

    // No post-exit budget guard: the budget is checked at dispatch (see
    // dispatchLimits) and enforced per task by the adapter. A finished task
    // routes on its exit; the next dispatch is where exhaustion bites.
    const target = step.on[exit];
    if (!target) {
      await this.escalate(node, state, `step ${step.id} exit "${exit}" has no route`);
      return;
    }
    await this.route(node, state, step.id, target);
  }

  /**
   * Parallel group (reviewer ‖ critic): dispatch every member concurrently,
   * join when all have exited, aggregate (any failed → failed; any blocked →
   * blocked; else done), and route once via the shared `on` map. On a failed
   * join, the failing members' findings artifacts ride into the retry as
   * loop feedback.
   */
  private async advanceGroup(
    node: WorkNode,
    state: NodePipelineState,
    step: AgentStepSpec,
  ): Promise<void> {
    const members = this.group(step.id);
    state.groupTasks ??= {};

    // Dispatch any member without a task. The remaining node budget is
    // split evenly across the members dispatched in this pass.
    const undispatched = members.filter((m) => !state.groupTasks?.[m.id]);
    let limits: TaskRequest["limits"] = {};
    if (undispatched.length) {
      const l = await this.dispatchLimits(node, state, undispatched.length);
      if (!l) return; // budget guard fired before any spend
      limits = l;
    }
    for (const m of members) {
      if (state.groupTasks[m.id]) continue;
      const role = this.spec.roles[m.role];
      if (!role) throw new Error(`spec: role "${m.role}" has no binding`);
      const adapter = this.adapter(role.adapter);
      const ws = await adapter.provisionWorkspace(node.key, {
        ...(state.refs["branch"] ? { branch: state.refs["branch"] } : {}),
        ...(state.refs["base"] ? { base: state.refs["base"] } : {}),
      });
      const context = await this.deps.provider.nodeContext(this.providerConfig, node);
      context.briefRefs = [...this.specBriefs(), ...context.briefRefs];
      const ref = await adapter.createTask({
        idempotencyKey: this.taskKey(node, state, m.id),
        role: m.role,
        ...(role.model ? { model: role.model } : {}),
        contractRef: m.contractRef,
        context,
        workspace: ws,
        ...(m.readOnly ? { readOnly: true } : {}),
        produces: m.produces,
        ...(limits && Object.keys(limits).length ? { limits } : {}),
      });
      state.groupTasks[m.id] = { ref };
      await this.deps.ledger.append({ kind: "dispatched", nodeKey: node.key, stepId: m.id, task: ref });
      this.log(`${node.key}: dispatched ${m.id} (${m.role}) ‖ group of ${members.length}`);
    }

    // Poll; collect exits.
    const { readFile } = await import("node:fs/promises");
    let allExited = true;
    const failureFeedback: string[] = [];
    for (const m of members) {
      const entry = state.groupTasks[m.id];
      if (!entry) { allExited = false; continue; }
      if (entry.exit) continue;
      const role = this.spec.roles[m.role];
      if (!role) throw new Error(`spec: role "${m.role}" has no binding`);
      const status = await this.adapter(role.adapter).status(entry.ref);
      if (status.state !== "exited") { allExited = false; continue; }
      const result = status.result;
      for (const k of ["usd", "tokens", "wallClockMs"] as const) {
        const v = result.spend[k];
        if (v) state.spend[k] = (state.spend[k] ?? 0) + v;
      }
      let exit: ExitKind = result.exit;
      const missing = m.produces.filter((kind) => !result.artifacts.some((a) => a.kind === kind));
      if (exit !== "failed" && missing.length > 0) exit = "failed";
      if (result.violations?.length) {
        exit = "failed";
        failureFeedback.push(this.violationFeedback(m.id, result.violations));
        this.log(`${node.key}: ${m.id} violated guarantees — ${result.violations.join("; ")}`);
      }
      entry.exit = exit;
      await this.deps.ledger.append({
        kind: "exited", nodeKey: node.key, stepId: m.id, exit, artifacts: result.artifacts,
      });
      this.log(`${node.key}: ${m.id} exited ${exit} (group member)`);
      if (exit === "failed") {
        const findings = result.artifacts.find((a) => a.kind === "findings");
        if (findings) {
          try {
            const body = await readFile(findings.ref, "utf8");
            failureFeedback.push(`${m.id} findings:\n${body.trim().split("\n").slice(0, 30).join("\n")}`);
          } catch { /* artifact unreadable; exit already failed */ }
        }
      }
    }
    if (!allExited) return;

    const exits = members.map((m) => state.groupTasks?.[m.id]?.exit);
    const groupExit: ExitKind = exits.includes("failed")
      ? "failed"
      : exits.includes("blocked")
        ? "blocked"
        : "done";
    if (groupExit === "failed" && failureFeedback.length) {
      state.refs["lastCheckFailure"] = failureFeedback.join("\n\n");
    }
    delete state.groupTasks;

    const target = step.on[groupExit];
    if (!target) {
      await this.escalate(node, state, `group ${step.id} exit "${groupExit}" has no route`);
      return;
    }
    this.log(`${node.key}: group ${members.map((m) => m.id).join("‖")} joined → ${groupExit}`);
    await this.route(node, state, step.id, target);
  }

  /**
   * Check steps run ASYNCHRONOUSLY: a check is started on one tick and
   * collected on a later one, so a 10-minute test suite never freezes the
   * loop for every other node (scale-benchmark finding, 2026-10-31). The
   * running check lives in memory only — checks are deterministic and
   * idempotent, so a controller that dies mid-check simply re-runs it on
   * resume; nothing about it needs the ledger.
   */
  private readonly checks = new Map<string, { done: boolean; result?: CheckOutcome }>();

  private async advanceCheck(
    node: WorkNode,
    state: NodePipelineState,
    step: CheckStepSpec,
  ): Promise<void> {
    const key = `${node.key}/${step.id}/r${state.round}`;
    let running = this.checks.get(key);
    if (!running) {
      const slot: { done: boolean; result?: CheckOutcome } = { done: false };
      this.checks.set(key, slot);
      void this.runCheck(node, state, step).then(
        (result) => { slot.result = result; slot.done = true; },
        (err) => {
          slot.result = { pass: false, details: [`check runner error: ${(err as Error).message}`] };
          slot.done = true;
        },
      );
      this.log(`${node.key}: check ${step.id} started (${step.run.length} command(s))`);
      return;
    }
    if (!running.done || !running.result) return; // still running
    this.checks.delete(key);
    const { pass, details, lastFailure } = running.result;
    if (lastFailure) state.refs["lastCheckFailure"] = lastFailure;
    await this.deps.ledger.append({
      kind: "check",
      nodeKey: node.key,
      stepId: step.id,
      pass,
      detail: details.join(" | "),
    });
    this.log(`${node.key}: check ${step.id} ${pass ? "PASS" : "FAIL"}`);
    const target = step.on[pass ? "done" : "failed"];
    if (!target) {
      await this.escalate(node, state, `check ${step.id} ${pass ? "done" : "failed"} has no route`);
      return;
    }
    await this.route(node, state, step.id, target);
  }

  /** Adapter-located, controller-judged: run the commands in the node's workspace. */
  private async runCheck(
    node: WorkNode,
    state: NodePipelineState,
    step: CheckStepSpec,
  ): Promise<CheckOutcome> {
    const adapter = this.anyAdapter();
    const ws = await adapter.provisionWorkspace(node.key, {
      ...(state.refs["branch"] ? { branch: state.refs["branch"] } : {}),
      ...(state.refs["base"] ? { base: state.refs["base"] } : {}),
    });
    const details: string[] = [];
    for (const argv of step.run) {
      const cmd = argv.map((a) => a.replaceAll("{key}", node.key));
      const started = Date.now();
      const res = await adapter.exec(ws, cmd);
      details.push(`${cmd.join(" ")} -> ${res.exitCode} (${Math.round((Date.now() - started) / 1000)}s)`);
      if (res.exitCode !== 0) {
        const excerpt = failureExcerpt(`${res.stdout}\n${res.stderr}`);
        details.push(excerpt.split("\n")[0] ?? "");
        return { pass: false, details, lastFailure: `${cmd.join(" ")} exited ${res.exitCode}:\n${excerpt}` };
      }
    }
    return { pass: true, details };
  }

  /** True while any node has a live agent task or a running check. */
  private checksRunning(): boolean {
    for (const c of this.checks.values()) if (!c.done) return true;
    return false;
  }

  private async advanceHuman(
    node: WorkNode,
    state: NodePipelineState,
    step: HumanStepSpec,
  ): Promise<void> {
    if (!state.parked) {
      state.parked = { gateStepId: step.id, since: new Date().toISOString() };
      await this.deps.ledger.append({ kind: "gate-parked", nodeKey: node.key, stepId: step.id });
      await this.transitionBusiness(node, state, this.spec.work.transitions?.onGateParked);
      this.log(`${node.key}: parked at ${step.id} — ${step.gate.summary}`);
      return;
    }
    const observer = this.deps.observers[step.acceptance.observer];
    if (!observer) throw new Error(`spec: observer "${step.acceptance.observer}" not registered`);
    const candidate = state.refs[step.acceptance.candidateRef];
    if (!candidate) return; // nothing to observe yet
    const check = await observer.check({
      candidate,
      verdicts: step.acceptance.verdicts,
      evidenceRef: step.gate.evidenceRef ?? "",
    });
    if (!check.satisfied) return; // stay parked — zero cost
    delete state.parked;
    await this.deps.ledger.append({
      kind: "gate-cleared",
      nodeKey: node.key,
      stepId: step.id,
      evidence: check.evidence,
    });
    await this.transitionBusiness(node, state, this.spec.work.transitions?.onGateCleared);
    this.log(`${node.key}: gate ${step.id} cleared by observed fact`);
    await this.route(node, state, step.id, step.on["done"] ?? "node-done");
  }

  // ----- routing, guards, terminals -----

  private async route(
    node: WorkNode,
    state: NodePipelineState,
    fromStepId: string,
    target: RouteTarget,
  ): Promise<void> {
    if (target === "node-done") {
      state.terminal = "done";
      state.stepId = null;
      this.log(`${node.key}: DONE`);
      return;
    }
    if (target === "escalate") {
      await this.escalate(node, state, `routed to escalate from ${fromStepId}`);
      return;
    }
    if (!this.steps.has(target)) {
      throw new Error(`spec: route target "${target}" from ${fromStepId} not defined`);
    }
    // Loop-back = a new round (bounded). Re-entering the SAME step is a
    // round too: without the bump the retry's idempotency key would repeat
    // and the adapter would hand back the finished task forever.
    if (this.stepOrder.indexOf(target) <= this.stepOrder.indexOf(fromStepId)) {
      state.round += 1;
      if (state.round >= this.spec.pipeline.guards.maxRounds) {
        await this.guardExceeded(
          node,
          state,
          "maxRounds",
          this.spec.pipeline.guards.maxRounds,
          state.round,
        );
        return;
      }
    }
    await this.enterStep(node, state, target);
  }

  private async enterStep(
    node: WorkNode,
    state: NodePipelineState,
    stepId: string,
  ): Promise<void> {
    state.hops += 1;
    if (state.hops > this.spec.pipeline.guards.maxHops) {
      await this.guardExceeded(node, state, "maxHops", this.spec.pipeline.guards.maxHops, state.hops);
      return;
    }
    state.stepId = stepId;
    delete state.activeTask;
    delete state.groupTasks;
  }

  private async guardExceeded(
    node: WorkNode,
    state: NodePipelineState,
    guard: "maxRounds" | "maxHops" | "budget" | "timeout",
    limit: number,
    actual: number,
  ): Promise<void> {
    await this.deps.ledger.append({
      kind: "guard-exceeded",
      nodeKey: node.key,
      exceeded: { guard, limit, actual, nodeKey: node.key },
    });
    await this.escalate(node, state, `guard ${guard} exceeded: ${actual} vs limit ${limit}`);
  }

  /**
   * Dispatch-time budget check — the guard bites BEFORE spend, never after a
   * successful exit. Returns the per-task limits for `shares` tasks dispatched
   * together (the remaining node headroom split evenly, capped by the spec's
   * per-task ceilings), or null when the node is exhausted — in which case the
   * `budget` guard has already fired and the caller must return.
   */
  private async dispatchLimits(
    node: WorkNode,
    state: NodePipelineState,
    shares: number,
  ): Promise<NonNullable<TaskRequest["limits"]> | null> {
    const b = this.spec.budgets;
    const limits: NonNullable<TaskRequest["limits"]> = {};
    if (b?.perTask?.usd !== undefined) limits.usd = b.perTask.usd;
    if (b?.perTask?.maxTurns !== undefined) limits.maxTurns = b.perTask.maxTurns;
    if (b?.perTask?.timeoutMs !== undefined) limits.timeoutMs = b.perTask.timeoutMs;
    if (b?.perNodeUsd !== undefined) {
      const spent = state.spend.usd ?? 0;
      const remaining = b.perNodeUsd - spent;
      if (remaining <= (b.dispatchFloorUsd ?? 0)) {
        await this.guardExceeded(node, state, "budget", b.perNodeUsd, spent);
        return null;
      }
      const share = remaining / Math.max(1, shares);
      limits.usd = limits.usd === undefined ? share : Math.min(limits.usd, share);
    }
    return limits;
  }

  /** Stable across controller crashes; distinct across reopen generations. */
  private taskKey(node: WorkNode, state: NodePipelineState, stepId: string): string {
    const gen = state.generation ? `g${state.generation}` : "";
    return `${this.spec.name}/${node.key}/${stepId}/${gen}r${state.round}`;
  }

  /** S1/S2: the engagement's goal-spec and briefing lead every agent's reading list. */
  private specBriefs(): string[] {
    const e = this.spec.engagement;
    return [e?.goalSpec, e?.briefing].filter((p): p is string => typeof p === "string");
  }

  private violationFeedback(stepId: string, violations: string[]): string {
    return `${stepId} violated harness guarantees (the harness enforced them; fix the behaviour, do not retry the same action):\n- ${violations.join("\n- ")}`;
  }

  private async escalate(
    node: WorkNode,
    state: NodePipelineState,
    summary: string,
  ): Promise<void> {
    state.terminal = "escalated";
    state.stepId = null;
    delete state.activeTask;
    await this.deps.ledger.append({ kind: "escalated", nodeKey: node.key, summary });
    await this.transitionBusiness(node, state, this.spec.work.transitions?.onEscalate);
    this.log(`${node.key}: ESCALATED — ${summary}`);
  }

  // ----- helpers -----

  private async dispatchable(
    node: WorkNode,
    states: Map<string, NodePipelineState>,
  ): Promise<boolean> {
    if (node.meta["held"]) return false; // provider hold (e.g. upstream outside engagement)
    for (const dep of node.dependsOn) {
      if (states.get(dep)?.terminal !== "done") return false;
    }
    // Cap counts STARTED, live, unparked nodes — not active tasks: a node
    // enters the pipeline one tick before its first task exists (wave-1
    // benchmark bug: three dispatched under a cap of two).
    const cap = this.spec.scheduling?.maxConcurrent ?? 4;
    let active = 0;
    for (const s of states.values()) {
      if (s.stepId !== null && !s.terminal && !s.parked) active += 1;
    }
    if (active >= cap) return false;
    const readiness = await this.deps.provider.readiness(this.providerConfig, node.key);
    if (!readiness.ready) {
      this.log(`${node.key}: not ready (${readiness.blockedBy.join(", ")})`);
      return false;
    }
    return true;
  }

  private async transitionBusiness(
    node: WorkNode,
    state: NodePipelineState,
    to: string | undefined,
  ): Promise<void> {
    if (!to) return;
    await this.deps.provider.onTransition(this.providerConfig, node.key, {
      to,
      refs: state.refs,
      cause: `controller: pipeline ${state.stepId ?? "start"}`,
    });
    await this.deps.ledger.append({
      kind: "exited",
      nodeKey: node.key,
      stepId: `business:${to}`,
      exit: "handoff",
      artifacts: [],
    });
  }

  private async nodeStates(): Promise<Map<string, NodePipelineState>> {
    const { nodes } = await this.deps.ledger.load();
    return new Map(nodes.map((n) => [n.nodeKey, n]));
  }

  private freshState(nodeKey: string): NodePipelineState {
    return { nodeKey, stepId: null, round: 0, hops: 0, spend: {}, refs: {} };
  }

  private async anyRunning(): Promise<boolean> {
    if (this.checksRunning()) return true;
    const states = await this.nodeStates();
    for (const s of states.values()) if (s.activeTask || s.groupTasks) return true;
    return false;
  }

  private adapter(id: string): Adapter {
    const a = this.deps.adapters[id];
    if (!a) throw new Error(`spec: adapter "${id}" not registered`);
    return a;
  }

  private anyAdapter(): Adapter {
    const first = Object.values(this.deps.adapters)[0];
    if (!first) throw new Error("no adapters registered");
    return first;
  }
}
