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
    perNodeUsd?: number;
  };
}
