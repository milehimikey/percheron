/**
 * Runtime wiring: engagement.yaml → a live Controller.
 *
 * Providers, adapters and observers are CODE registered by id; the spec only
 * names and configures them (spec-format principle). v0.2 registry:
 *   providers: em · adapters: local-subagent · observers: git-merged
 *
 * Paths: relative paths in the spec were resolved against the spec's directory
 * by the loader; the provider's `work.config` is opaque, so `run` chdirs to the
 * spec directory before touching the provider — a `model: ../toolshed.em`
 * resolves the same way everywhere. Check-step commands run in the node's
 * WORKSPACE (adapter-located), so paths there are workspace-relative.
 */

import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { LocalSubagentAdapter } from "./adapters/local-subagent.js";
import type { LocalSubagentConfig } from "./adapters/local-subagent.js";
import type { Adapter } from "./contracts/adapter.js";
import type { AcceptanceObserver } from "./contracts/ledger.js";
import type { Provider } from "./contracts/provider.js";
import { Controller } from "./controller/controller.js";
import { FileLedger } from "./controller/file-ledger.js";
import { loadSpecFile } from "./controller/spec-loader.js";
import type { SpecIssue } from "./controller/spec-loader.js";
import type { EngagementSpec } from "./controller/spec.js";
import { GitMergedObserver } from "./observers/git-merged.js";
import { EmProvider } from "./providers/em.js";

export interface Runtime {
  spec: EngagementSpec;
  specDir: string;
  warnings: SpecIssue[];
  controller: Controller;
  ledgerPath: string;
  repoRoot: string;
  stateDir: string;
}

const LOCAL_ADAPTER_KEYS = ["repoRoot", "stateDir", "claudeBin", "defaultModel", "maxConcurrentTasks", "confine", "readOnlyTools", "writeTools"] as const;

function gitToplevel(dir: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
}

export async function buildRuntime(
  specFile: string,
  opts: { log?: (line: string) => void } = {},
): Promise<Runtime> {
  const abs = resolve(specFile);
  const specDir = dirname(abs);
  const { spec, warnings } = await loadSpecFile(abs);
  const log = opts.log ?? ((l: string) => process.stderr.write(`[percheron ${new Date().toISOString().slice(11, 19)}] ${l}\n`));

  // Provider registry.
  let provider: Provider<unknown>;
  switch (spec.work.provider) {
    case "em":
      provider = new EmProvider() as Provider<unknown>;
      break;
    default:
      throw new Error(`run: no provider registered for "${spec.work.provider}" (known: em)`);
  }
  // The provider's config is opaque and path-bearing: resolve it where the spec lives.
  process.chdir(specDir);

  // Adapter registry — one instance per adapter id the roles bind to.
  const adapters: Record<string, Adapter> = {};
  let repoRoot: string | undefined;
  let stateDir: string | undefined;
  for (const id of new Set(Object.values(spec.roles).map((r) => r.adapter))) {
    const cfg = (spec.adapters?.[id] ?? {}) as Record<string, unknown>;
    if (id !== "local-subagent") throw new Error(`run: no adapter registered for "${id}" (known: local-subagent)`);
    for (const k of Object.keys(cfg)) {
      if (!(LOCAL_ADAPTER_KEYS as readonly string[]).includes(k)) {
        throw new Error(`run: adapters.${id}.${k} is not a local-subagent option (known: ${LOCAL_ADAPTER_KEYS.join(", ")})`);
      }
    }
    const rel = (p: unknown) => (typeof p === "string" ? (isAbsolute(p) ? p : resolve(specDir, p)) : undefined);
    repoRoot = rel(cfg["repoRoot"]) ?? gitToplevel(specDir);
    stateDir = rel(cfg["stateDir"]) ?? join(repoRoot, ".percheron");
    const local: LocalSubagentConfig = {
      repoRoot,
      stateDir,
      ...(typeof cfg["claudeBin"] === "string" ? { claudeBin: cfg["claudeBin"] } : {}),
      ...(typeof cfg["defaultModel"] === "string" ? { defaultModel: cfg["defaultModel"] } : {}),
      ...(typeof cfg["maxConcurrentTasks"] === "number" ? { maxConcurrentTasks: cfg["maxConcurrentTasks"] } : {}),
      ...(typeof cfg["confine"] === "boolean" ? { confine: cfg["confine"] } : {}),
      ...(Array.isArray(cfg["readOnlyTools"]) ? { readOnlyTools: cfg["readOnlyTools"] as string[] } : {}),
      ...(Array.isArray(cfg["writeTools"]) ? { writeTools: cfg["writeTools"] as string[] } : {}),
    };
    adapters[id] = new LocalSubagentAdapter(local);
  }
  if (!repoRoot || !stateDir) throw new Error("run: the pipeline binds no adapter");

  // Observer registry — every observer the human steps name must exist.
  const observers: Record<string, AcceptanceObserver> = {};
  for (const step of spec.pipeline.steps) {
    if (step.kind !== "human") continue;
    const id = step.acceptance.observer;
    if (observers[id]) continue;
    if (id !== "git-merged") throw new Error(`run: no observer registered for "${id}" (known: git-merged)`);
    observers[id] = new GitMergedObserver(repoRoot, "main");
  }

  const ledgerPath = join(stateDir, `ledger-${spec.name}.json`);
  const ledger = new FileLedger(ledgerPath);
  const controller = new Controller(spec, { provider, adapters, observers, ledger, log });
  return { spec, specDir, warnings, controller, ledgerPath, repoRoot, stateDir };
}
