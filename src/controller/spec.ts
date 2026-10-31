/**
 * EngagementSpec — the typed form of `engagement.yaml` (spec-format v0.1).
 *
 * v0.1 of the controller consumes the parsed object; file loading (YAML) is a
 * later, mechanical addition. The shape mirrors the vault's spec-format doc:
 * closed exit enum, step kinds encoding the evidence hierarchy, guards,
 * provider-owned business-state mapping as data.
 */

import type { ArtifactKind, ExitKind, Guards } from "../contracts/core.js";

/** Routing target: another step, node completion, or human escalation. */
export type RouteTarget = string | "node-done" | "escalate";

export interface AgentStepSpec {
  id: string;
  kind: "agent";
  role: string;
  /** Role contract file (L1) — inputs/outputs/forbidden, read by the worker. */
  contractRef: string;
  produces: ArtifactKind[];
  readOnly?: boolean;
  /**
   * Sibling agent-step ids that run CONCURRENTLY with this one as a group
   * (reviewer ‖ critic). Every member must declare the same group (each
   * listing the others) and an identical `on` map; the group joins when all
   * members exit, and the aggregate exit is `failed` if any member failed,
   * `blocked` if any blocked, else `done`. Independence (L4) is withholding:
   * members get the same node context and never each other's output.
   */
  parallelWith?: string[];
  on: Partial<Record<ExitKind, RouteTarget>>;
}

export interface CheckStepSpec {
  id: string;
  kind: "check";
  /**
   * argv arrays, no shell. `{key}` substitutes the node key. All commands
   * exiting 0 = "done"; any non-zero = "failed". Run via the node adapter's
   * `exec` (adapter-located, controller-judged).
   */
  run: string[][];
  on: Partial<Record<"done" | "failed", RouteTarget>>;
}

export interface HumanStepSpec {
  id: string;
  kind: "human";
  gate: { summary: string; evidenceRef?: string };
  acceptance: {
    /** Registered AcceptanceObserver id. */
    observer: string;
    /** Which node ref is the candidate (e.g. "pr" or "branch"). */
    candidateRef: string;
    verdicts: string[];
  };
  on: Partial<Record<"done" | "failed", RouteTarget>>;
}

/** v0.1: judge steps are pass-through placeholders (advisory by design). */
export interface JudgeStepSpec {
  id: string;
  kind: "judge";
  rubrics: string[];
  on: Partial<Record<"done", RouteTarget>>;
}

export type StepSpec =
  | AgentStepSpec
  | CheckStepSpec
  | HumanStepSpec
  | JudgeStepSpec;

/** Business-state names are the PROVIDER's vocabulary, declared as spec data. */
export interface BusinessTransitions {
  onDispatch?: string; // em: "building"
  onGateParked?: string; // em: "awaiting-merge"
  onGateCleared?: string; // em: "merged"
  onEscalate?: string; // em: "held"
}

export interface RoleBinding {
  adapter: string;
  model?: string;
}

export interface EngagementSpec {
  name: string;
  work: {
    provider: string;
    config: unknown;
    transitions?: BusinessTransitions;
  };
  roles: Record<string, RoleBinding>;
  pipeline: {
    entry: string;
    guards: Guards;
    steps: StepSpec[];
  };
  scheduling?: {
    maxConcurrent?: number;
  };
  budgets?: {
    /**
     * Node-wide cap. Checked AT DISPATCH: a step is not dispatched when the
     * node's spend has reached the cap (guard `budget`, named), and every
     * dispatched task carries the remaining headroom as its own ceiling. A
     * task that exits `done` is never killed for budget after the fact — the
     * work exists; the next dispatch is where the guard bites (benchmark
     * finding: the post-exit guard killed a successful run).
     */
    perNodeUsd?: number;
    /**
     * Least headroom worth dispatching into (default 0). Below it the node is
     * treated as exhausted rather than sent a task that dies on its first
     * API call.
     */
    dispatchFloorUsd?: number;
    /** Per-task ceilings, enforced by the adapter (headless flags / kill). */
    perTask?: {
      usd?: number;
      maxTurns?: number;
      timeoutMs?: number;
    };
  };
}
