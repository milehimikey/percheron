/**
 * The em provider — percheron's reference Provider implementation.
 *
 * Maps em's engagement surfaces onto the provider contract:
 *   deriveGraph   <- `em engagement plan --json`        (engagementPlanSchemaVersion 1.4)
 *   readiness     <- `em validate --slice-ready --json` (validateSliceReadySchemaVersion 1.5)
 *   preflight     <- plan's `preflight[]` (advisory) +
 *                    `em engagement foundation --json`  (1.0; missing-event blocks)
 *   onTransition  -> `em engagement set` (em's Ledger — the only write)
 *
 * em stays the business-state authority: its 8 states (planned … merged | gap)
 * pass through as opaque strings. Everything here is a thin, schema-checked
 * shim over `--json` output; no em file is ever read or written directly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Provider,
  ProviderInfo,
  PreflightIssue,
  NodeContext,
  NodeTransition,
} from "../contracts/provider.js";
import type { Readiness, WorkGraph, WorkNode } from "../contracts/core.js";

const execFileAsync = promisify(execFile);

export interface EmConfig {
  /** Path to the `.em` model file. */
  model: string;
  /** The em engagement slug (must already exist: `em engagement new`). */
  engagement: string;
  /** Target code repo for the foundation gate; omitted = foundation not checked. */
  code?: string;
  /** em binary (default "em" on PATH). */
  emBin?: string;
}

/** em's Ledger states — the full legal value space of NodeTransition.to. */
export const EM_STATES = [
  "planned",
  "building",
  "validating",
  "review",
  "awaiting-merge",
  "merged",
  "held",
  "gap",
] as const;

const REQUIRED = {
  engagementPlan: { major: 1, minor: 4 },
  validateSliceReady: { major: 1, minor: 5 },
  engagementFoundation: { major: 1, minor: 0 },
} as const;

/** Same-major, at-least-minor — em's documented compatibility discipline. */
function checkSchema(
  id: keyof typeof REQUIRED,
  actual: unknown,
): void {
  const want = REQUIRED[id];
  const [major = NaN, minor = NaN] = String(actual).split(".").map(Number);
  if (major !== want.major || minor < want.minor) {
    throw new Error(
      `em provider: ${id} schema ${String(actual)} — need ${want.major}.${want.minor}+ (same major)`,
    );
  }
}

/**
 * Run em and parse JSON from stdout. em exits non-zero on honest negative
 * verdicts (`--slice-ready` on a blocked slice, `foundation` with gaps) while
 * still printing the document — a non-zero exit with parseable stdout is a
 * RESULT here, not an error.
 */
async function emJson(
  config: EmConfig,
  args: string[],
): Promise<Record<string, unknown>> {
  const bin = config.emBin ?? "em";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout && e.stdout.trimStart().startsWith("{")) {
      stdout = e.stdout;
    } else {
      throw new Error(
        `em provider: \`${bin} ${args.join(" ")}\` failed: ${e.stderr?.trim() || e.message || "unknown"}`,
      );
    }
  }
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function emRun(config: EmConfig, args: string[]): Promise<void> {
  const bin = config.emBin ?? "em";
  try {
    await execFileAsync(bin, args);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `em provider: \`${bin} ${args.join(" ")}\` failed: ${e.stderr?.trim() || e.message || "unknown"}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface PlanSlice {
  key: string;
  level: number;
  upstreams: string[];
  branch: string;
  base: string;
  prTitle: string | null;
  tracking: string | null;
  pattern?: string;
  docStatus?: string;
  state?: string | null;
  stateInferred?: boolean;
  planHeld?: string | null;
  held?: string | null;
}

export class EmProvider implements Provider<EmConfig> {
  info(): ProviderInfo {
    return {
      id: "em",
      version: "0.1.0",
      requires: [
        { id: "engagementPlan", version: ">=1.4 <2" },
        { id: "validateSliceReady", version: ">=1.5 <2" },
        { id: "engagementFoundation", version: ">=1.0 <2" },
      ],
    };
  }

  parseConfig(raw: unknown): EmConfig {
    const c = raw as Partial<EmConfig> | null;
    if (!c || typeof c.model !== "string" || typeof c.engagement !== "string") {
      throw new Error(
        "em provider config: `model` (path to .em file) and `engagement` (slug) are required",
      );
    }
    return {
      model: c.model,
      engagement: c.engagement,
      ...(typeof c.code === "string" ? { code: c.code } : {}),
      ...(typeof c.emBin === "string" ? { emBin: c.emBin } : {}),
    };
  }

  async preflight(config: EmConfig): Promise<PreflightIssue[]> {
    const issues: PreflightIssue[] = [];

    const plan = await this.plan(config);
    for (const p of (plan["preflight"] as Array<Record<string, unknown>> | undefined) ?? []) {
      issues.push({
        code: String(p["kind"]),
        detail: `${String(p["message"])} [${(p["slices"] as string[] | undefined)?.join(", ") ?? ""}]`,
        blocking: false, // em pre-flight is advisory by definition (GH #239)
      });
    }

    if (config.code) {
      const f = await emJson(config, [
        "engagement",
        "foundation",
        config.model,
        config.engagement,
        "--code",
        config.code,
        "--json",
      ]);
      checkSchema("engagementFoundation", f["engagementFoundationSchemaVersion"]);
      for (const ev of (f["events"] as Array<Record<string, unknown>>) ?? []) {
        const status = String(ev["status"]);
        if (status === "present") continue;
        const missing = [
          ...((ev["missingFields"] as string[] | undefined) ?? []),
          ...((ev["missingTagFields"] as string[] | undefined) ?? []),
        ];
        issues.push({
          code: status, // "missing-event" | "incomplete"
          detail:
            status === "missing-event"
              ? `foundation absent for event "${String(ev["event"])}"`
              : `event "${String(ev["event"])}" missing: ${missing.join(", ")}`,
          blocking: status === "missing-event", // em's STOP rule
        });
      }
    }

    return issues;
  }

  async deriveGraph(config: EmConfig): Promise<WorkGraph> {
    const plan = await this.plan(config);
    const slices = (plan["slices"] as unknown as PlanSlice[]) ?? [];
    const nodes: WorkNode[] = slices.map((s) => ({
      key: s.key,
      dependsOn: s.upstreams ?? [],
      ...(s.prTitle ? { title: s.prTitle } : {}),
      ...(s.tracking ? { tracking: s.tracking } : {}),
      orderingHint: s.level,
      meta: Object.fromEntries(
        Object.entries({
          pattern: s.pattern,
          docStatus: s.docStatus,
          branch: s.branch,
          base: s.base,
          state: s.state,
          held: s.held,
        }).flatMap(([k, v]) => (v == null ? [] : [[k, String(v)]])),
      ),
    }));
    return {
      nodes,
      derivedFrom: {
        id: "engagementPlan",
        version: String(plan["engagementPlanSchemaVersion"]),
      },
    };
  }

  async readiness(config: EmConfig, nodeKey: string): Promise<Readiness> {
    const v = await emJson(config, [
      "validate",
      config.model,
      "--slice-ready",
      nodeKey,
      "--json",
    ]);
    checkSchema("validateSliceReady", v["validateSliceReadySchemaVersion"]);
    return {
      ready: v["ready"] === true,
      blockedBy: (v["blockedBy"] as string[] | undefined) ?? [],
    };
  }

  async nodeContext(config: EmConfig, node: WorkNode): Promise<NodeContext> {
    const modelDir = dirname(config.model);
    const briefRefs: string[] = [];
    const sliceDoc = join(modelDir, "slices", `${node.key}.md`);
    if (await exists(sliceDoc)) briefRefs.push(sliceDoc);
    const constitution = join(modelDir, "constitution.md");
    if (await exists(constitution)) briefRefs.push(constitution);

    const facts: Record<string, string> = {};
    if (node.tracking) facts["tracking"] = node.tracking;
    const branch = node.meta["branch"];
    if (branch) facts["branch"] = branch;
    const base = node.meta["base"];
    if (base) facts["base"] = base;

    return {
      key: node.key,
      ...(node.title ? { title: node.title } : {}),
      briefRefs,
      facts,
    };
  }

  async onTransition(
    config: EmConfig,
    nodeKey: string,
    transition: NodeTransition,
  ): Promise<void> {
    if (!(EM_STATES as readonly string[]).includes(transition.to)) {
      throw new Error(
        `em provider: "${transition.to}" is not an em Ledger state (expected one of: ${EM_STATES.join(", ")})`,
      );
    }
    const args = [
      "engagement",
      "set",
      config.model,
      config.engagement,
      nodeKey,
      "--state",
      transition.to,
    ];
    const refs = transition.refs ?? {};
    if (refs["branch"]) args.push("--branch", refs["branch"]);
    if (refs["base"]) args.push("--base", refs["base"]);
    if (refs["pr"]) args.push("--pr", refs["pr"]);
    await emRun(config, args); // idempotent: em no-ops an unchanged state
  }

  private async plan(config: EmConfig): Promise<Record<string, unknown>> {
    const plan = await emJson(config, [
      "engagement",
      "plan",
      config.model,
      config.engagement,
      "--json",
    ]);
    checkSchema("engagementPlan", plan["engagementPlanSchemaVersion"]);
    return plan;
  }
}
