/**
 * Ledger + gate contracts — percheron's durable runtime state (G3/G4).
 *
 * Authority split (resolves the two-ledger risk from spec-format):
 *  - BUSINESS states live with the provider (for em: the engagement file,
 *    written only via Provider.onTransition).
 *  - PIPELINE state lives here: which step, which round, which task, spend.
 *  - The EVENT LOG is append-only; a fresh controller resumes from
 *    (provider graph + pipeline states + events) alone — files, no memory.
 */

import type { Artifact, BudgetSpend, ExitKind, GuardExceeded } from "./core.js";
import type { TaskRef } from "./adapter.js";

export interface NodePipelineState {
  nodeKey: string;
  /** Current step id in the pipeline template, or null before first dispatch. */
  stepId: string | null;
  /** Findings-loop round (bounded by guards.maxRounds). */
  round: number;
  /** Total transitions consumed (bounded by guards.maxHops). */
  hops: number;
  activeTask?: TaskRef;
  /** Parallel-group tasks, keyed by member step id (reviewer ‖ critic). */
  groupTasks?: Record<string, { ref: TaskRef; exit?: string }>;
  spend: BudgetSpend;
  /** Set when parked at a human gate (G3) — cleared only by observed fact. */
  parked?: { gateStepId: string; since: string };
  /** External refs harvested from steps (pr URL, branch) — fed to provider transitions. */
  refs: Record<string, string>;
  /** Terminal outcome; absent while the node is live. */
  terminal?: "done" | "escalated";
}

export type LedgerEvent =
  | { kind: "dispatched"; nodeKey: string; stepId: string; task: TaskRef }
  | { kind: "exited"; nodeKey: string; stepId: string; exit: ExitKind; artifacts: Artifact[] }
  | { kind: "check"; nodeKey: string; stepId: string; pass: boolean; detail: string }
  | { kind: "gate-parked"; nodeKey: string; stepId: string }
  | { kind: "gate-cleared"; nodeKey: string; stepId: string; evidence: Artifact[] }
  | { kind: "guard-exceeded"; nodeKey: string; exceeded: GuardExceeded }
  | { kind: "escalated"; nodeKey: string; summary: string };

export interface LedgerEventRecord {
  at: string; // ISO timestamp
  event: LedgerEvent;
}

export interface Ledger {
  load(): Promise<{
    nodes: NodePipelineState[];
    events: LedgerEventRecord[];
  }>;
  /** Single write path (em's `engagement set` discipline, kept). */
  setNodeState(state: NodePipelineState): Promise<void>;
  append(event: LedgerEvent): Promise<void>;
}

/**
 * Human gates are durable interrupts (G3): the node parks at zero cost, and
 * the wake signal is an OBSERVED EXTERNAL FACT — the PR is merged, the doc is
 * ratified — never a chat reply. Observers are code registered by name (the
 * em/git/gh observer checks `merged` via the forge API).
 */
export interface AcceptanceSpec {
  candidate: string; // e.g. the PR URL
  verdicts: string[]; // e.g. ["merged"]
  evidenceRef: string;
}

export interface AcceptanceObserver {
  id: string;
  check(acceptance: AcceptanceSpec): Promise<{
    satisfied: boolean;
    evidence: Artifact[];
  }>;
}
