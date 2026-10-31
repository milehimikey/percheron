/**
 * Adapter contract — the executor behind a role binding (G5).
 *
 * An adapter is the thin layer that makes percheron portable: the same
 * pipeline dispatches to a local Claude Code subagent, a Claude cloud session,
 * a GitHub Actions run, or an OpenRig seat, through this one surface. Every
 * 2026 cloud product exposes the createTask/observe shape (landscape finding);
 * the adapter normalizes it.
 *
 * Two findings from writing this contract (fed back into spec-format):
 *
 *  1. `exec` lives HERE, not in the controller. Guarantee-class `check` steps
 *     (L2 tier 1) must run where the workspace is — a cloud node's tests run
 *     in the cloud workspace, not on the controller's machine. The controller
 *     still owns pass/fail judgment; the adapter only provides located,
 *     deterministic execution.
 *
 *  2. `idempotencyKey` is mandatory on createTask. A crashed controller must
 *     be able to re-issue the same dispatch and get the SAME task, not a
 *     duplicate (the OpenRig `workflow operation <key>` lost-response lesson).
 */

import type {
  Artifact,
  ArtifactKind,
  BudgetSpend,
  ExitKind,
} from "./core.js";
import type { NodeContext } from "./provider.js";

export interface AdapterInfo {
  id: string; // "local-subagent" | "claude-cloud" | ...
  version: string;
  /** How completion is learned. Controllers prefer "events", fall back to "poll". */
  observation: Array<"events" | "poll">;
  workspaceKinds: Array<"worktree" | "branch" | "vm" | "container">;
  /** Honest ceilings (sessions, fires/hr). Undeclared = controller assumes 1. */
  maxConcurrentTasks?: number;
}

export interface WorkspaceRef {
  id: string;
  kind: "worktree" | "branch" | "vm" | "container";
  /** Path, branch name, or environment id — adapter-interpreted. */
  location: string;
}

export interface TaskRequest {
  /**
   * Stable across controller crashes: hash of (engagement, nodeKey, stepId,
   * round). Adapters MUST return the existing task for a repeated key.
   */
  idempotencyKey: string;
  role: string;
  /** Model the role binding resolved to. The CONTROLLER has already enforced
   * independence constraints (critic model ≠ implementer model) before this
   * call; adapters just honor the value. */
  model?: string;
  /** Path to the role's node contract file (L1) — inputs/outputs/forbidden. */
  contractRef: string;
  context: NodeContext;
  workspace: WorkspaceRef;
  /** Reviewer/critic run read-only; adapters must enforce it (a guarantee,
   * not a request — the harness denies writes, the prompt doesn't ask). */
  readOnly?: boolean;
  /**
   * Blindness (L4) is enforced by WITHHOLDING: the controller simply never
   * puts sibling outputs in `context`. This field exists so adapters with
   * shared surfaces (a common workspace, a queue) also suppress those
   * channels; it is defense in depth, not the primary mechanism.
   */
  blindTo?: string[];
  /** Declared artifacts (L5). The adapter collects them; the controller
   * refuses the exit if any declared artifact is missing. */
  produces: ArtifactKind[];
  /**
   * Per-task ceilings, computed by the controller AT DISPATCH (remaining
   * node budget, spec per-task caps) and enforced by the adapter as
   * guarantees (headless `--max-budget-usd`, `--max-turns`, a kill at the
   * deadline). A task that hits one exits `failed` with the limit named in
   * `TaskResult.violations` — never a silent overrun judged after the fact.
   */
  limits?: BudgetSpend & { timeoutMs?: number; maxTurns?: number };
}

export interface TaskRef {
  adapterId: string;
  id: string;
}

export interface TaskResult {
  /** Mapped by the adapter onto the closed enum — never free text. */
  exit: ExitKind;
  artifacts: Artifact[];
  spend: BudgetSpend;
  /** Pointer to the raw transcript/log for the evidence archive, if any. */
  transcriptRef?: string;
  /**
   * Guarantee violations the ADAPTER detected and enforced, named for the
   * ledger and for loop feedback: a workspace escape (stray writes outside
   * the task's workspace, quarantined), a limit hit (`max-turns`,
   * `max-budget-usd`, `timeout`). Non-empty ⇒ `exit` is `failed`; the
   * controller never routes a violating task as done.
   */
  violations?: string[];
}

export type TaskStatus =
  | { state: "queued" | "running" }
  | { state: "exited"; result: TaskResult };

export interface TaskEvent {
  at: string; // ISO timestamp
  taskId: string;
  kind: "started" | "progress" | "exited";
  detail?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface Adapter {
  info(): AdapterInfo;

  /**
   * Worktree locally; branch/VM/container in the cloud. Idempotent per node.
   * branch/base come from the provider's node data (em: `impl/<key>` on
   * `main`, never stacked) — the adapter must not invent its own convention.
   */
  provisionWorkspace(
    nodeKey: string,
    opts?: { branch?: string; base?: string },
  ): Promise<WorkspaceRef>;
  releaseWorkspace(ws: WorkspaceRef): Promise<void>;

  /** Dispatch one agent step. MUST be idempotent on request.idempotencyKey. */
  createTask(request: TaskRequest): Promise<TaskRef>;

  status(ref: TaskRef): Promise<TaskStatus>;

  /** Push observation, where the harness supports it (webhooks, hooks). */
  events?(ref: TaskRef): AsyncIterable<TaskEvent>;

  cancel(ref: TaskRef): Promise<void>;

  /**
   * Located deterministic execution for `check` steps: run a command IN the
   * node's workspace, return the raw result. No judgment here — the
   * controller compares against the check's expected schema/exit code.
   */
  exec(
    ws: WorkspaceRef,
    command: string[],
    opts?: { timeoutMs?: number },
  ): Promise<ExecResult>;
}
