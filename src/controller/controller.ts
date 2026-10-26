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
 * v0.1 limitations, explicit:
 *   - `parallelWith` groups are serialized (declared order). Blindness is
 *     withholding, so independence survives; wall-clock does not. v0.2 work.
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
    // Not started: dispatchability gate.
    if (state.stepId === null) {
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
      const ws = await adapter.provisionWorkspace(node.key, {
        ...(state.refs["branch"] ? { branch: state.refs["branch"] } : {}),
        ...(state.refs["base"] ? { base: state.refs["base"] } : {}),
      });
      const context: NodeContext = await this.deps.provider.nodeContext(
        this.providerConfig,
        node,
      );
      const request: TaskRequest = {
        idempotencyKey: `${this.spec.name}/${node.key}/${step.id}/r${state.round}`,
        role: step.role,
        ...(role.model ? { model: role.model } : {}),
        contractRef: step.contractRef,
        context,
        workspace: ws,
        ...(step.readOnly ? { readOnly: true } : {}),
        produces: step.produces,
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

    // Budget guard (perNode).
    const cap = this.spec.budgets?.perNodeUsd;
    if (cap && (state.spend.usd ?? 0) > cap) {
      await this.guardExceeded(node, state, "budget", cap, state.spend.usd ?? 0);
      return;
    }

    const target = step.on[exit];
    if (!target) {
      await this.escalate(node, state, `step ${step.id} exit "${exit}" has no route`);
      return;
    }
    await this.route(node, state, step.id, target);
  }

  private async advanceCheck(
    node: WorkNode,
    state: NodePipelineState,
    step: CheckStepSpec,
  ): Promise<void> {
    const adapter = this.anyAdapter();
    const ws = await adapter.provisionWorkspace(node.key, {
      ...(state.refs["branch"] ? { branch: state.refs["branch"] } : {}),
      ...(state.refs["base"] ? { base: state.refs["base"] } : {}),
    });
    let pass = true;
    const details: string[] = [];
    for (const argv of step.run) {
      const cmd = argv.map((a) => a.replaceAll("{key}", node.key));
      const res = await adapter.exec(ws, cmd);
      details.push(`${cmd.join(" ")} -> ${res.exitCode}`);
      if (res.exitCode !== 0) {
        pass = false;
        details.push(res.stderr.trim().split("\n")[0] ?? "");
        break; // first failure is the finding; later checks may depend on it
      }
    }
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
    // Loop-back = a new round (bounded).
    if (this.stepOrder.indexOf(target) < this.stepOrder.indexOf(fromStepId)) {
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
    await this.escalate(node, state, `guard ${guard} exceeded: ${actual} > ${limit}`);
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
    const cap = this.spec.scheduling?.maxConcurrent ?? 4;
    let active = 0;
    for (const s of states.values()) if (s.activeTask) active += 1;
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
    const states = await this.nodeStates();
    for (const s of states.values()) if (s.activeTask) return true;
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
