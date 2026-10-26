/**
 * Provider contract — the work source behind the derived graph (G1).
 *
 * A provider is CODE registered by name; the spec only names and configures it
 * (the em-judge principle: specs stay reviewable data, promises are code).
 * The reference implementation is `em`: graph from `em engagement plan --json`,
 * readiness from `em validate --slice-ready --json`, preflight from
 * `em engagement foundation --json`, write-back via `em engagement set`.
 *
 * Rules every implementation must honor:
 *  - Read methods are idempotent and side-effect-free; the graph is DERIVED,
 *    recomputed whenever asked, never cached as authority (em's own rule).
 *  - `onTransition` is the ONLY mutation, and it writes the provider's own
 *    business ledger (for em: the engagement file, em's 8 states). Business
 *    states are provider-owned strings; the controller never interprets them
 *    beyond equality — its own pipeline state lives in the percheron ledger.
 */

import type { Readiness, SchemaRef, WorkGraph, WorkNode } from "./core.js";

export interface ProviderInfo {
  id: string; // "em"
  version: string;
  /** Tool + schema pins the controller must CI-check before running (S4). */
  requires: SchemaRef[];
}

export interface PreflightIssue {
  code: string; // e.g. "missing-event", "repeated-invariant"
  detail: string;
  /** A blocking issue refuses fan-out outright (em's foundation gate). */
  blocking: boolean;
}

/**
 * The minimized input set an agent step receives (L1). Deliberately small:
 * em's proven rule is the implementer gets the slice key, workspace, exact PR
 * title and tracking key — no plan, no sibling info. Providers populate
 * `facts` with exactly that class of data and nothing more.
 */
export interface NodeContext {
  key: string;
  title?: string;
  /** Files the worker must read first (goal-spec, briefing, slice doc). */
  briefRefs: string[];
  /** Small, named facts (trackingKey, branch, baseRef...). Not a dumping ground. */
  facts: Record<string, string>;
}

export interface NodeTransition {
  /** Provider-owned business state (em: building | pr-open | ... | merged | gap). */
  to: string;
  /** External refs recorded with the state (PR URL, branch). */
  refs?: Record<string, string>;
  /** One sentence for the ledger row — why this transition happened. */
  cause: string;
}

export interface Provider<C = unknown> {
  info(): ProviderInfo;

  /** Parse + validate the spec's `work.config` block. Throws on bad config. */
  parseConfig(raw: unknown): C;

  /** Model-wide gate before any fan-out. Any blocking issue stops the run. */
  preflight(config: C): Promise<PreflightIssue[]>;

  /** Derive the full node set + dependency edges. Idempotent. */
  deriveGraph(config: C): Promise<WorkGraph>;

  /** Routing input for one node: dispatchWhen = upstreams done AND ready. */
  readiness(config: C, nodeKey: string): Promise<Readiness>;

  /** The minimized context for dispatching this node's agent steps. */
  nodeContext(config: C, node: WorkNode): Promise<NodeContext>;

  /** THE only write-back. Idempotent per (nodeKey, to). */
  onTransition(
    config: C,
    nodeKey: string,
    transition: NodeTransition,
  ): Promise<void>;
}
