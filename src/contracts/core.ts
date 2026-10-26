/**
 * percheron contract surface v0.1 — shared types.
 *
 * Design source: harness-design-2026-10/spec-format.md (vault). Component ids
 * (S1–S5, L1–L5, G1–G5) reference design-base.md §2.
 *
 * Two closed enums anchor everything: exits and artifact kinds. Both grow only
 * by a schema-version bump, never by free text — a loop that can invent its own
 * exit names can talk itself past a gate.
 */

export const EXIT_KINDS = ["done", "handoff", "blocked", "failed"] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

/** The three-artifact exit contract (L5) plus the two review products. */
export const ARTIFACT_KINDS = [
  "pr",
  "findings",
  "evidenceMap",
  "continuationNote",
  "report",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Artifact {
  kind: ArtifactKind;
  /** Path (relative to the evidence archive) or URL. */
  ref: string;
  /** Content hash where the artifact is a file — evidence is tamper-evident. */
  sha256?: string;
  summary?: string;
}

/** A versioned schema the controller pins and CI-checks (S4). */
export interface SchemaRef {
  id: string; // e.g. "engagementPlan"
  version: string; // semver range the consumer requires, e.g. ">=1.4"
}

/**
 * One node of the derived work-graph (G1). Providers map their domain item
 * (an em slice, a ticket, a doc) onto this; the controller never sees the
 * domain, only this shape.
 */
export interface WorkNode {
  key: string;
  /** Keys of nodes whose completion this node's dispatch waits on (G2). */
  dependsOn: string[];
  /** Human-facing title; for em this is the resolved exact PR title. */
  title?: string;
  /** External tracking key (issue id etc.), opaque to the controller. */
  tracking?: string;
  /**
   * Ordering hint only (em: the level). Orders dispatch for readability;
   * gates nothing — dispatchability is dependsOn + readiness, never this.
   */
  orderingHint?: number;
  /** Provider-specific facts, opaque to the controller, passed to context. */
  meta: Record<string, string>;
}

export interface WorkGraph {
  nodes: WorkNode[];
  /** The provider schema this graph was derived from, for the ledger record. */
  derivedFrom: SchemaRef;
}

/** Routing data for dispatch (G2). blockedBy carries codes, never prose. */
export interface Readiness {
  ready: boolean;
  blockedBy: string[];
}

export type Severity = "blocker" | "major" | "minor";

/** A review finding. An uncited finding is dropped at the boundary (L2). */
export interface Finding {
  severity: Severity;
  /** Doc line / rule id the finding stands on — required, not optional. */
  citation: string;
  text: string;
}

export interface Guards {
  /** Findings loops back to the implementer before escalation (L3). */
  maxRounds: number;
  /** Total step transitions a node may execute (adopted from OpenRig). */
  maxHops: number;
}

export interface BudgetSpend {
  usd?: number;
  tokens?: number;
  wallClockMs?: number;
}

/**
 * A guard failure names the guard (adopted verbatim from the OpenRig spike:
 * "fails the instance honestly with the guard named"). This is a result,
 * not an exception — guard exhaustion is an expected, routable outcome.
 */
export interface GuardExceeded {
  guard: "maxRounds" | "maxHops" | "budget" | "timeout";
  limit: number;
  actual: number;
  nodeKey: string;
}
