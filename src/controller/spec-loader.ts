/**
 * engagement.yaml → EngagementSpec: the loader + validator (spec-format v0.2).
 *
 * The YAML file is the human-authored artifact (spec-format.md: "declarative
 * intent"); this module is the only thing that reads it. It is STRICT on
 * purpose — every rule the factory rig once carried as prose is a typed field
 * here, and a field the controller does not implement is refused rather than
 * silently carried (a knob that reads as a promise must be one):
 *
 *   - unknown keys anywhere → error with the exact path;
 *   - `specVersion` major must be one this loader knows (em's rule: breaking
 *     changes bump the major; validators refuse unknown majors);
 *   - exits are the closed enum; `produces` the closed registry; route
 *     targets must exist; parallel groups symmetric with identical `on`;
 *   - `check.run` rows are argv (a string is split shell-style, no shell at
 *     runtime); `{node.key}` → the controller's `{key}`, `{config.a.b}` is
 *     substituted from `work.config` at load; anything else in braces is an
 *     error, not a hope;
 *   - `escalate` and `node-done` are route keywords, never step ids;
 *   - role `independence.modelNot` is checked statically;
 *   - `policy.mergeAuthority` / `exceptionRouting` accept only the implemented
 *     values; `policy.budgets.total` is accepted with a WARNING (not enforced).
 *
 * Output is OpenRig-shaped (the spike's validation discipline): `ok`, and a
 * list of issues each with severity, path, message and the fixing action.
 * Static only — no live tools, no executors.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { ARTIFACT_KINDS, EXIT_KINDS } from "../contracts/core.js";
import type { ArtifactKind, ExitKind } from "../contracts/core.js";
import type {
  AgentStepSpec,
  CheckStepSpec,
  EngagementSpec,
  HumanStepSpec,
  JudgeStepSpec,
  RoleBinding,
  RouteTarget,
  StepSpec,
} from "./spec.js";

export const SUPPORTED_SPEC_MAJORS = ["0"] as const;
const RESERVED_TARGETS = ["node-done", "escalate"] as const;

export interface SpecIssue {
  severity: "error" | "warning";
  /** Dotted/indexed path into the YAML document, e.g. `pipeline.steps[2].on.done`. */
  path: string;
  message: string;
  /** The action that fixes it — one sentence, imperative. */
  fix: string;
}

export interface SpecValidation {
  ok: boolean;
  issues: SpecIssue[];
  /** Present when ok (warnings do not block). */
  spec?: EngagementSpec;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonNegNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

class Ctx {
  issues: SpecIssue[] = [];
  constructor(readonly baseDir: string) {}
  error(path: string, message: string, fix: string): void {
    this.issues.push({ severity: "error", path, message, fix });
  }
  warn(path: string, message: string, fix: string): void {
    this.issues.push({ severity: "warning", path, message, fix });
  }
  get failed(): boolean {
    return this.issues.some((i) => i.severity === "error");
  }
  /** Flag keys not in `allowed`; returns true when the object is usable. */
  only(path: string, v: unknown, allowed: readonly string[], required: readonly string[] = []): v is Obj {
    if (!isObj(v)) {
      this.error(path, `expected a mapping, got ${describe(v)}`, `Write \`${path}\` as a YAML mapping with keys: ${allowed.join(", ")}.`);
      return false;
    }
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) {
        this.error(`${path}.${k}`, `unknown key "${k}"`, `Remove it or use one of: ${allowed.join(", ")}. The spec carries no free-form fields.`);
      }
    }
    for (const k of required) {
      if (!(k in v)) this.error(`${path}.${k}`, `required key "${k}" is missing`, `Add \`${k}\` under \`${path}\`.`);
    }
    return true;
  }
  resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.baseDir, p);
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return typeof v;
}

/** Durations: number = ms; "90s" | "15m" | "2h" | "250ms". */
export function parseDuration(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h";
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
}

/** Shell-style split (quotes, backslash escapes), no expansion — the runtime runs argv, not a shell. */
export function splitArgv(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

function lookup(config: unknown, dotted: string): unknown {
  let cur: unknown = config;
  for (const part of dotted.split(".")) {
    if (!isObj(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Validate a parsed YAML document and map it onto EngagementSpec.
 * `baseDir` anchors relative paths (goalSpec, briefing, contract files).
 */
export function validateSpecDocument(doc: unknown, opts: { baseDir: string }): SpecValidation {
  const ctx = new Ctx(opts.baseDir);
  const TOP = ["specVersion", "engagement", "work", "tools", "policy", "scheduling", "roles", "adapters", "pipeline"];
  if (!ctx.only("", doc, TOP, ["specVersion", "engagement", "work", "roles", "pipeline"])) {
    return { ok: false, issues: ctx.issues };
  }
  // The root path prefix is "" — tidy the leading dot on root-level issues.
  const tidy = () => { for (const i of ctx.issues) i.path = i.path.replace(/^\./, ""); };

  // --- specVersion ---
  const specVersion = doc["specVersion"];
  if (!isStr(specVersion) || !/^\d+\.\d+$/.test(specVersion)) {
    ctx.error("specVersion", `expected "<major>.<minor>" as a string, got ${JSON.stringify(specVersion)}`, 'Set `specVersion: "0.2"` (quoted — YAML would read 0.2 as a number).');
  } else if (!(SUPPORTED_SPEC_MAJORS as readonly string[]).includes(specVersion.split(".")[0] as string)) {
    ctx.error("specVersion", `major ${specVersion.split(".")[0]} is not supported by this loader (supports ${SUPPORTED_SPEC_MAJORS.join(", ")})`, "Upgrade percheron, or rewrite the spec against a supported major.");
  }

  // --- engagement ---
  let name = "";
  const engagement: NonNullable<EngagementSpec["engagement"]> = {};
  const eng = doc["engagement"];
  if (ctx.only("engagement", eng, ["name", "mode", "goalSpec", "briefing"], ["name"])) {
    if (isStr(eng["name"]) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(eng["name"])) name = eng["name"];
    else if (eng["name"] !== undefined) ctx.error("engagement.name", "must be a slug ([A-Za-z0-9._-], leading alphanumeric)", "Use a slug like `checkout-2026-11`; it keys ledgers and idempotency keys.");
    if (eng["mode"] !== undefined) {
      if (eng["mode"] === "build" || eng["mode"] === "investigate") engagement.mode = eng["mode"];
      else ctx.error("engagement.mode", `unknown mode ${JSON.stringify(eng["mode"])}`, "Use `build` or `investigate`.");
    }
    for (const k of ["goalSpec", "briefing"] as const) {
      if (eng[k] === undefined) continue;
      if (isStr(eng[k])) engagement[k] = ctx.resolvePath(eng[k] as string);
      else ctx.error(`engagement.${k}`, "must be a path string", `Point \`${k}\` at a committed file beside the spec.`);
    }
  }

  // --- work ---
  let work: EngagementSpec["work"] | null = null;
  const w = doc["work"];
  if (ctx.only("work", w, ["provider", "config", "transitions"], ["provider", "config"])) {
    if (w["provider"] !== undefined && !isStr(w["provider"])) ctx.error("work.provider", "must be a registered provider id", "Name the provider (code), e.g. `em`.");
    if (w["config"] !== undefined && !isObj(w["config"])) ctx.error("work.config", `expected a mapping, got ${describe(w["config"])}`, "Give the provider its config block; the provider schema-checks it at plan().");
    let transitions: EngagementSpec["work"]["transitions"];
    if (w["transitions"] !== undefined) {
      const T = ["onDispatch", "onGateParked", "onGateCleared", "onEscalate"] as const;
      if (ctx.only("work.transitions", w["transitions"], T)) {
        transitions = {};
        for (const k of T) {
          const v = (w["transitions"] as Obj)[k];
          if (v === undefined) continue;
          if (isStr(v)) transitions[k] = v;
          else ctx.error(`work.transitions.${k}`, "must be a provider business-state name", "Use the provider's own state vocabulary (em: building, awaiting-merge, merged, held).");
        }
      }
    }
    if (isStr(w["provider"]) && isObj(w["config"])) {
      work = { provider: w["provider"], config: w["config"], ...(transitions ? { transitions } : {}) };
    }
  }

  // --- tools (carried, not checked here) ---
  let tools: Record<string, unknown> | undefined;
  if (doc["tools"] !== undefined) {
    if (isObj(doc["tools"])) tools = doc["tools"];
    else ctx.error("tools", `expected a mapping, got ${describe(doc["tools"])}`, "Map tool ids to semver ranges; `schemas` may nest schema pins.");
  }

  // --- policy ---
  let policy: EngagementSpec["policy"];
  let budgets: EngagementSpec["budgets"];
  const pol = doc["policy"];
  if (pol !== undefined && ctx.only("policy", pol, ["ratifiers", "mergeAuthority", "exceptionRouting", "budgets"])) {
    policy = {};
    if (pol["ratifiers"] !== undefined) {
      if (Array.isArray(pol["ratifiers"]) && pol["ratifiers"].every(isStr)) policy.ratifiers = pol["ratifiers"] as string[];
      else ctx.error("policy.ratifiers", "must be a list of handles", "List who may clear human gates, e.g. `[mikey]`.");
    }
    if (pol["mergeAuthority"] !== undefined) {
      if (pol["mergeAuthority"] === "human") policy.mergeAuthority = "human";
      else ctx.error("policy.mergeAuthority", `${JSON.stringify(pol["mergeAuthority"])} is not implemented; only \`human\` is`, "Set `mergeAuthority: human` (a controller-merge policy would be a lie until it exists).");
    }
    if (pol["exceptionRouting"] !== undefined) {
      if (pol["exceptionRouting"] === "human_only") policy.exceptionRouting = "human_only";
      else ctx.error("policy.exceptionRouting", `${JSON.stringify(pol["exceptionRouting"])} is not implemented; only \`human_only\` is`, "Set `exceptionRouting: human_only`.");
    }
    const b = pol["budgets"];
    if (b !== undefined && ctx.only("policy.budgets", b, ["perNode", "perTask", "total"])) {
      budgets = {};
      const pn = b["perNode"];
      if (pn !== undefined && ctx.only("policy.budgets.perNode", pn, ["usd", "dispatchFloorUsd"])) {
        if (pn["usd"] !== undefined) {
          if (isNonNegNum(pn["usd"])) budgets.perNodeUsd = pn["usd"];
          else ctx.error("policy.budgets.perNode.usd", "must be a non-negative number (USD)", "Write the cap as a number, e.g. `usd: 15`.");
        }
        if (pn["dispatchFloorUsd"] !== undefined) {
          if (isNonNegNum(pn["dispatchFloorUsd"])) budgets.dispatchFloorUsd = pn["dispatchFloorUsd"];
          else ctx.error("policy.budgets.perNode.dispatchFloorUsd", "must be a non-negative number (USD)", "Write the floor as a number, e.g. `dispatchFloorUsd: 0.5`.");
        }
      }
      const pt = b["perTask"];
      if (pt !== undefined && ctx.only("policy.budgets.perTask", pt, ["usd", "maxTurns", "wallClock"])) {
        const perTask: NonNullable<NonNullable<EngagementSpec["budgets"]>["perTask"]> = {};
        if (pt["usd"] !== undefined) {
          if (isNonNegNum(pt["usd"])) perTask.usd = pt["usd"];
          else ctx.error("policy.budgets.perTask.usd", "must be a non-negative number (USD)", "Write the per-task cap as a number.");
        }
        if (pt["maxTurns"] !== undefined) {
          if (isPosInt(pt["maxTurns"])) perTask.maxTurns = pt["maxTurns"];
          else ctx.error("policy.budgets.perTask.maxTurns", "must be a positive integer", "e.g. `maxTurns: 60`.");
        }
        if (pt["wallClock"] !== undefined) {
          const ms = parseDuration(pt["wallClock"]);
          if (ms === null) ctx.error("policy.budgets.perTask.wallClock", `unreadable duration ${JSON.stringify(pt["wallClock"])}`, "Use `90s`, `15m`, `2h`, or milliseconds as a number.");
          else perTask.timeoutMs = ms;
        }
        if (Object.keys(perTask).length) budgets.perTask = perTask;
      }
      if (b["total"] !== undefined) {
        ctx.warn("policy.budgets.total", "engagement-wide totals are not enforced by this controller version", "Keep it for intent, or remove it; per-node and per-task caps are the enforced ones.");
      }
      if (!Object.keys(budgets).length) budgets = undefined;
    }
  }

  // --- scheduling ---
  let scheduling: EngagementSpec["scheduling"];
  const sch = doc["scheduling"];
  if (sch !== undefined && ctx.only("scheduling", sch, ["dispatchWhen", "maxConcurrent", "levels"])) {
    scheduling = {};
    if (sch["dispatchWhen"] !== undefined && sch["dispatchWhen"] !== "upstreamsMerged && ready") {
      ctx.error("scheduling.dispatchWhen", `only \`upstreamsMerged && ready\` is implemented`, "Set `dispatchWhen: upstreamsMerged && ready` (dependsOn terminal + provider readiness are the only routing inputs).");
    }
    if (sch["levels"] !== undefined && sch["levels"] !== "orderingHintOnly") {
      ctx.error("scheduling.levels", "levels never gate dispatch; the only value is `orderingHintOnly`", "Set `levels: orderingHintOnly` or remove the key.");
    }
    if (sch["maxConcurrent"] !== undefined) {
      if (isPosInt(sch["maxConcurrent"])) scheduling.maxConcurrent = sch["maxConcurrent"];
      else ctx.error("scheduling.maxConcurrent", "must be a positive integer", "e.g. `maxConcurrent: 4`.");
    }
  }

  // --- adapters (config only) ---
  let adapters: Record<string, unknown> | undefined;
  if (doc["adapters"] !== undefined) {
    if (isObj(doc["adapters"])) {
      adapters = doc["adapters"];
      for (const [id, cfg] of Object.entries(adapters)) {
        if (!isObj(cfg)) ctx.error(`adapters.${id}`, `expected a mapping (adapter config), got ${describe(cfg)}`, "Use `{}` for defaults.");
      }
    } else ctx.error("adapters", `expected a mapping, got ${describe(doc["adapters"])}`, "Map adapter ids to their config blocks.");
  }

  // --- roles ---
  const roles: Record<string, RoleBinding> = {};
  const r = doc["roles"];
  if (!isObj(r)) {
    ctx.error("roles", `expected a mapping of role → binding, got ${describe(r)}`, "Declare each role the pipeline uses: `implementer: { adapter: local-subagent, model: sonnet }`.");
  } else {
    for (const [role, raw] of Object.entries(r)) {
      const p = `roles.${role}`;
      if (!ctx.only(p, raw, ["adapter", "model", "independence"], ["adapter"])) continue;
      if (!isStr(raw["adapter"])) { if (raw["adapter"] !== undefined) ctx.error(`${p}.adapter`, "must be an adapter id", "Name a registered adapter, e.g. `local-subagent`."); continue; }
      if (adapters && !(raw["adapter"] in adapters)) {
        ctx.error(`${p}.adapter`, `"${raw["adapter"]}" is not declared under \`adapters\``, `Add \`${raw["adapter"]}: {}\` under \`adapters\`, or fix the id.`);
      }
      const binding: RoleBinding = { adapter: raw["adapter"] };
      if (raw["model"] !== undefined) {
        if (isStr(raw["model"])) binding.model = raw["model"];
        else ctx.error(`${p}.model`, "must be a model name", "e.g. `model: sonnet`.");
      }
      const ind = raw["independence"];
      if (ind !== undefined && ctx.only(`${p}.independence`, ind, ["freshContext", "modelNot", "blindTo"])) {
        binding.independence = {};
        if (ind["freshContext"] !== undefined) {
          if (typeof ind["freshContext"] === "boolean") binding.independence.freshContext = ind["freshContext"];
          else ctx.error(`${p}.independence.freshContext`, "must be a boolean", "`freshContext: true`.");
        }
        for (const k of ["modelNot", "blindTo"] as const) {
          if (ind[k] === undefined) continue;
          if (Array.isArray(ind[k]) && (ind[k] as unknown[]).every(isStr)) binding.independence[k] = ind[k] as string[];
          else ctx.error(`${p}.independence.${k}`, "must be a list of names", k === "modelNot" ? "List role names whose model this role must not share." : "List step ids whose outputs are withheld.");
        }
      }
      roles[role] = binding;
    }
    // Static independence: modelNot must name known roles with a different model.
    for (const [role, b] of Object.entries(roles)) {
      for (const other of b.independence?.modelNot ?? []) {
        const o = roles[other];
        if (!o) { ctx.error(`roles.${role}.independence.modelNot`, `"${other}" is not a declared role`, "Name a role declared under `roles`."); continue; }
        if (b.model && o.model && b.model === o.model) {
          ctx.error(`roles.${role}.model`, `independence violated: ${role} and ${other} both bind model "${b.model}"`, `Give ${role} a different model, or drop "${other}" from modelNot.`);
        }
        if (!b.model || !o.model) {
          ctx.warn(`roles.${role}.independence.modelNot`, `cannot check ${role} ≠ ${other}: a model is unbound (adapter default applies)`, "Bind both models explicitly so independence is checkable.");
        }
      }
    }
  }

  // --- pipeline ---
  let pipeline: EngagementSpec["pipeline"] | null = null;
  const pl = doc["pipeline"];
  if (ctx.only("pipeline", pl, ["entry", "exits", "guards", "steps"], ["entry", "guards", "steps"])) {
    if (pl["exits"] !== undefined) {
      const ex = pl["exits"];
      if (!Array.isArray(ex) || ex.length !== EXIT_KINDS.length || !EXIT_KINDS.every((k) => ex.includes(k))) {
        ctx.error("pipeline.exits", `the exit enum is closed: ${EXIT_KINDS.join(", ")}`, "Set `exits: [done, handoff, blocked, failed]` or remove the key (it is declarative confirmation only).");
      }
    }
    let guards: EngagementSpec["pipeline"]["guards"] | null = null;
    if (ctx.only("pipeline.guards", pl["guards"], ["maxRounds", "maxHops"], ["maxRounds", "maxHops"])) {
      const g = pl["guards"];
      const okR = isPosInt(g["maxRounds"]);
      const okH = isPosInt(g["maxHops"]);
      if (!okR && g["maxRounds"] !== undefined) ctx.error("pipeline.guards.maxRounds", "must be a positive integer", "e.g. `maxRounds: 2` — findings loops before escalation.");
      if (!okH && g["maxHops"] !== undefined) ctx.error("pipeline.guards.maxHops", "must be a positive integer", "e.g. `maxHops: 12` — total step transitions a node may make.");
      if (okR && okH) guards = { maxRounds: g["maxRounds"] as number, maxHops: g["maxHops"] as number };
    }

    const steps: StepSpec[] = [];
    const rawSteps = pl["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      if (rawSteps !== undefined) ctx.error("pipeline.steps", "must be a non-empty list of steps", "Declare at least the entry step.");
    } else {
      const ids = new Set<string>();
      // Every declared id resolves routes, even when its step fails to parse —
      // one broken step must not cascade into "unknown target" everywhere.
      const declared = new Set<string>(
        rawSteps.filter(isObj).map((s) => s["id"]).filter((x): x is string => isStr(x) && !(RESERVED_TARGETS as readonly string[]).includes(x)),
      );
      rawSteps.forEach((raw, i) => {
        const s = parseStep(ctx, `pipeline.steps[${i}]`, raw, work?.config, roles);
        if (!s) return;
        if (ids.has(s.id)) ctx.error(`pipeline.steps[${i}].id`, `duplicate step id "${s.id}"`, "Step ids must be unique within the pipeline.");
        ids.add(s.id);
        steps.push(s);
      });
      // Cross-step checks: entry exists, routes resolve, groups symmetric.
      const entry = pl["entry"];
      if (entry !== undefined && !isStr(entry)) ctx.error("pipeline.entry", "must name a step id", "Set `entry` to the first step's id.");
      else if (isStr(entry) && !declared.has(entry)) ctx.error("pipeline.entry", `step "${entry}" is not defined`, `Define a step with id "${entry}" or point entry at an existing one.`);
      steps.forEach((s, i) => {
        for (const [exit, target] of Object.entries(s.on as Record<string, RouteTarget>)) {
          if ((RESERVED_TARGETS as readonly string[]).includes(target) || declared.has(target)) continue;
          ctx.error(`pipeline.steps[${i}].on.${exit}`, `route target "${target}" is not a step id`, `Route to an existing step id, or to \`node-done\` / \`escalate\`.`);
        }
        if (s.kind === "agent" && s.parallelWith?.length) {
          for (const other of s.parallelWith) {
            const o = steps.find((x) => x.id === other);
            if (!o && declared.has(other)) continue; // already reported on its own step
            if (!o || o.kind !== "agent") { ctx.error(`pipeline.steps[${i}].parallelWith`, `"${other}" is not an agent step`, "Parallel groups contain agent steps only."); continue; }
            if (!(o.parallelWith ?? []).includes(s.id)) ctx.error(`pipeline.steps[${i}].parallelWith`, `asymmetric group: "${other}" does not list "${s.id}"`, `Add \`parallelWith: [${s.id}]\` to step "${other}".`);
            if (JSON.stringify(o.on) !== JSON.stringify(s.on)) ctx.error(`pipeline.steps[${i}].on`, `parallel group members "${s.id}" and "${other}" must share an identical \`on\` map`, "Give both members the same routes; the group joins and routes once.");
          }
        }
      });
      const humans = steps.filter((s) => s.kind === "human");
      if (humans.length > 1) ctx.warn("pipeline.steps", `${humans.length} human steps: provider adoption of "awaiting-merge" re-parks at the FIRST one`, "Keep one human gate per pipeline, or order the merge gate first.");
    }
    if (guards && isStr(pl["entry"])) pipeline = { entry: pl["entry"], guards, steps };
  }

  tidy();
  if (ctx.failed || !work || !pipeline || !name) return { ok: false, issues: ctx.issues };

  const spec: EngagementSpec = {
    specVersion: specVersion as string,
    name,
    ...(Object.keys(engagement).length ? { engagement } : {}),
    ...(tools ? { tools } : {}),
    ...(adapters ? { adapters } : {}),
    ...(policy && Object.keys(policy).length ? { policy } : {}),
    work,
    roles,
    pipeline,
    ...(scheduling && Object.keys(scheduling).length ? { scheduling } : {}),
    ...(budgets ? { budgets } : {}),
  };
  return { ok: true, issues: ctx.issues, spec };
}

function parseOn<K extends string>(
  ctx: Ctx,
  path: string,
  raw: unknown,
  allowedExits: readonly K[],
  required: boolean,
): Partial<Record<K, RouteTarget>> | null {
  if (raw === undefined) {
    if (required) ctx.error(path, "missing `on` routes", `Add \`on: { ${allowedExits.map((e) => `${e}: <step|node-done|escalate>`).join(", ")} }\`.`);
    return required ? null : {};
  }
  if (!isObj(raw)) { ctx.error(path, `expected a mapping exit → target, got ${describe(raw)}`, "e.g. `on: { done: validate, failed: escalate }`."); return null; }
  const on: Partial<Record<K, RouteTarget>> = {};
  for (const [exit, target] of Object.entries(raw)) {
    if (!(allowedExits as readonly string[]).includes(exit)) { ctx.error(`${path}.${exit}`, `"${exit}" is not an exit this step kind can produce (${allowedExits.join(", ")})`, "Route only on the closed exit enum."); continue; }
    if (!isStr(target)) { ctx.error(`${path}.${exit}`, "target must be a step id, `node-done` or `escalate`", "Name the next step."); continue; }
    on[exit as K] = target;
  }
  return on;
}

function parseStep(ctx: Ctx, path: string, raw: unknown, config: unknown, roles: Record<string, RoleBinding>): StepSpec | null {
  if (!isObj(raw)) { ctx.error(path, `expected a step mapping, got ${describe(raw)}`, "Each step is a mapping with `id` and `kind`."); return null; }
  const id = raw["id"];
  const kind = raw["kind"];
  if (!isStr(id)) { ctx.error(`${path}.id`, "step id is required", "Give the step a unique id."); return null; }
  if ((RESERVED_TARGETS as readonly string[]).includes(id)) {
    ctx.error(`${path}.id`, `"${id}" is a reserved route target, not a step`, id === "escalate" ? "Remove the step: escalation is built in (a guard or an `escalate` route ends the node with the evidence attached)." : "Rename the step.");
    return null;
  }
  switch (kind) {
    case "agent": {
      if (!ctx.only(path, raw, ["id", "kind", "role", "contract", "produces", "readOnly", "parallelWith", "on"], ["role", "contract", "produces"])) return null;
      const role = raw["role"];
      if (!isStr(role)) { if (role !== undefined) ctx.error(`${path}.role`, "must name a role", "Use a role declared under `roles`."); return null; }
      if (!(role in roles)) ctx.error(`${path}.role`, `role "${role}" has no binding under \`roles\``, `Add \`${role}: { adapter: …, model: … }\` to \`roles\`.`);
      if (!isStr(raw["contract"])) { if (raw["contract"] !== undefined) ctx.error(`${path}.contract`, "must be a path to the role's node contract (L1)", "e.g. `contract: roles/implementer.md`."); return null; }
      const produces: ArtifactKind[] = [];
      if (!Array.isArray(raw["produces"]) || raw["produces"].length === 0) {
        if (raw["produces"] !== undefined) ctx.error(`${path}.produces`, "every agent step declares at least one artifact", `List from the closed registry: ${ARTIFACT_KINDS.join(", ")}.`);
      } else {
        for (const k of raw["produces"] as unknown[]) {
          if ((ARTIFACT_KINDS as readonly string[]).includes(k as string)) produces.push(k as ArtifactKind);
          else ctx.error(`${path}.produces`, `"${String(k)}" is not a registered artifact kind`, `Use one of: ${ARTIFACT_KINDS.join(", ")} (closed registry; grows only by a schema bump).`);
        }
      }
      if (raw["readOnly"] !== undefined && typeof raw["readOnly"] !== "boolean") ctx.error(`${path}.readOnly`, "must be a boolean", "`readOnly: true` for reviewers/critics.");
      let parallelWith: string[] | undefined;
      if (raw["parallelWith"] !== undefined) {
        if (Array.isArray(raw["parallelWith"]) && raw["parallelWith"].every(isStr)) parallelWith = raw["parallelWith"] as string[];
        else ctx.error(`${path}.parallelWith`, "must be a list of step ids", "e.g. `parallelWith: [critique]`.");
      }
      const on = parseOn(ctx, `${path}.on`, raw["on"], EXIT_KINDS, true);
      if (!on) return null;
      const contractRef = ctx.resolvePath(raw["contract"]);
      if (!existsSync(contractRef)) ctx.warn(`${path}.contract`, `contract file not found: ${contractRef}`, "Commit the role's node contract beside the spec; the worker reads it first.");
      const step: AgentStepSpec = {
        id, kind: "agent", role, contractRef, produces,
        ...(raw["readOnly"] === true ? { readOnly: true } : {}),
        ...(parallelWith ? { parallelWith } : {}),
        on: on as Partial<Record<ExitKind, RouteTarget>>,
      };
      return step;
    }
    case "check": {
      if (!ctx.only(path, raw, ["id", "kind", "run", "on"], ["run"])) return null;
      const run: string[][] = [];
      if (!Array.isArray(raw["run"]) || raw["run"].length === 0) {
        if (raw["run"] !== undefined) ctx.error(`${path}.run`, "must be a non-empty list of commands", "Each row is a command string (split shell-style, no shell) or an argv list.");
      } else {
        (raw["run"] as unknown[]).forEach((row, j) => {
          const rp = `${path}.run[${j}]`;
          let argv: string[] | null = null;
          if (isStr(row)) argv = splitArgv(row);
          else if (Array.isArray(row) && row.every(isStr)) argv = row as string[];
          if (!argv || argv.length === 0) { ctx.error(rp, "unreadable command (unbalanced quotes, empty, or not a string/list)", "Write the command as a plain string or an argv list."); return; }
          const resolved: string[] = [];
          for (const arg of argv) {
            let bad = false;
            const out = arg.replace(/\{([^{}]+)\}/g, (_m, inner: string) => {
              if (inner === "node.key" || inner === "key") return "{key}";
              if (inner.startsWith("config.")) {
                const v = lookup(config, inner.slice("config.".length));
                if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
                ctx.error(rp, `placeholder {${inner}} does not resolve to a scalar in work.config`, `Add \`${inner.slice("config.".length)}\` to \`work.config\`, or fix the placeholder.`);
                bad = true;
                return _m;
              }
              ctx.error(rp, `unknown placeholder {${inner}}`, "Only `{node.key}` (runtime) and `{config.<path>}` (load-time) are substituted; everything else must be literal.");
              bad = true;
              return _m;
            });
            if (!bad) resolved.push(out);
          }
          if (resolved.length === argv.length) run.push(resolved);
        });
      }
      const on = parseOn(ctx, `${path}.on`, raw["on"], ["done", "failed"] as const, true);
      if (!on) return null;
      const step: CheckStepSpec = { id, kind: "check", run, on };
      return step;
    }
    case "judge": {
      if (!ctx.only(path, raw, ["id", "kind", "rubrics", "advisory", "on"], ["rubrics"])) return null;
      if (raw["rubrics"] !== undefined && (!Array.isArray(raw["rubrics"]) || !raw["rubrics"].every(isStr) || raw["rubrics"].length === 0)) ctx.error(`${path}.rubrics`, "must be a non-empty list of rubric ids", "e.g. `rubrics: [slice-doc-quality]`.");
      if (raw["advisory"] !== undefined && raw["advisory"] !== true) ctx.error(`${path}.advisory`, "judge steps are advisory by design; `advisory: false` is not implemented", "Set `advisory: true` or remove the key. A judge never blocks a failed check, and never unblocks one.");
      const on = parseOn(ctx, `${path}.on`, raw["on"], ["done"] as const, true);
      if (!on) return null;
      const step: JudgeStepSpec = { id, kind: "judge", rubrics: (raw["rubrics"] as string[]) ?? [], on };
      return step;
    }
    case "human": {
      if (!ctx.only(path, raw, ["id", "kind", "gate", "acceptance", "on"], ["gate", "acceptance"])) return null;
      let gate: HumanStepSpec["gate"] | null = null;
      if (ctx.only(`${path}.gate`, raw["gate"], ["summary", "evidenceRef"], ["summary"])) {
        const g = raw["gate"];
        if (isStr(g["summary"])) gate = { summary: g["summary"], ...(isStr(g["evidenceRef"]) ? { evidenceRef: g["evidenceRef"] } : {}) };
        else if (g["summary"] !== undefined) ctx.error(`${path}.gate.summary`, "must be a one-line summary for the human", "Say what the human is being asked to accept.");
        if (g["evidenceRef"] !== undefined && !isStr(g["evidenceRef"])) ctx.error(`${path}.gate.evidenceRef`, "must be a path/URL string", "Point at the evidence bundle.");
      }
      let acceptance: HumanStepSpec["acceptance"] | null = null;
      if (ctx.only(`${path}.acceptance`, raw["acceptance"], ["observer", "candidate", "candidateRef", "verdicts"], ["observer", "verdicts"])) {
        const a = raw["acceptance"];
        let candidateRef: string | null = null;
        if (isStr(a["candidateRef"])) candidateRef = a["candidateRef"];
        else if (isStr(a["candidate"])) {
          const m = /^\{([A-Za-z]+)(?:\.[A-Za-z.]+)?\}$/.exec(a["candidate"]);
          if (m) candidateRef = m[1] as string;
          else ctx.error(`${path}.acceptance.candidate`, `must be a node-ref placeholder like "{pr}" or "{branch}", got ${JSON.stringify(a["candidate"])}`, "The candidate is a ref the pipeline harvested (pr, branch); write `candidateRef: pr`.");
        } else if (a["candidate"] !== undefined) ctx.error(`${path}.acceptance.candidate`, "must be a string placeholder", "Write `candidateRef: pr`.");
        else ctx.error(`${path}.acceptance.candidateRef`, "which harvested ref is the candidate (pr | branch)", "Add `candidateRef: pr`.");
        if (a["observer"] !== undefined && !isStr(a["observer"])) ctx.error(`${path}.acceptance.observer`, "must name a registered AcceptanceObserver", "e.g. `observer: git-merged` — the wake signal is an observed fact, never a chat reply.");
        const verdictsOk = Array.isArray(a["verdicts"]) && a["verdicts"].length > 0 && a["verdicts"].every(isStr);
        if (!verdictsOk && a["verdicts"] !== undefined) ctx.error(`${path}.acceptance.verdicts`, "must be a non-empty list of accepted verdicts", "e.g. `verdicts: [merged]`.");
        if (candidateRef && isStr(a["observer"]) && verdictsOk) acceptance = { observer: a["observer"], candidateRef, verdicts: a["verdicts"] as string[] };
      }
      const on = parseOn(ctx, `${path}.on`, raw["on"], ["done", "failed"] as const, false);
      if (!gate || !acceptance || !on) return null;
      const step: HumanStepSpec = { id, kind: "human", gate, acceptance, on };
      return step;
    }
    default:
      ctx.error(`${path}.kind`, `unknown step kind ${JSON.stringify(kind)}`, "Use one of: check, judge, agent, human (the evidence hierarchy).");
      return null;
  }
}

/** Parse YAML text and validate. `baseDir` anchors relative paths. */
export function validateSpecText(text: string, opts: { baseDir: string }): SpecValidation {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      issues: [{ severity: "error", path: "", message: `YAML parse error: ${(err as Error).message}`, fix: "Fix the YAML syntax; nothing was validated." }],
    };
  }
  return validateSpecDocument(doc, opts);
}

/** Read + validate a spec file. Relative paths resolve against the file's directory. */
export async function validateSpecFile(file: string): Promise<SpecValidation> {
  const abs = resolve(file);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    return { ok: false, issues: [{ severity: "error", path: "", message: `cannot read ${abs}: ${(err as Error).message}`, fix: "Check the path." }] };
  }
  return validateSpecText(text, { baseDir: dirname(abs) });
}

export class SpecValidationError extends Error {
  constructor(readonly file: string, readonly issues: SpecIssue[]) {
    super(`${file}: ${issues.filter((i) => i.severity === "error").length} spec error(s)\n${formatIssues(issues)}`);
  }
}

/** Load a spec file or throw a SpecValidationError listing every issue. */
export async function loadSpecFile(file: string): Promise<{ spec: EngagementSpec; warnings: SpecIssue[] }> {
  const v = await validateSpecFile(file);
  if (!v.ok || !v.spec) throw new SpecValidationError(file, v.issues);
  return { spec: v.spec, warnings: v.issues.filter((i) => i.severity === "warning") };
}

export function formatIssues(issues: SpecIssue[]): string {
  return issues
    .map((i) => `  ${i.severity.toUpperCase().padEnd(7)} ${i.path || "(root)"}: ${i.message}\n          fix: ${i.fix}`)
    .join("\n");
}
