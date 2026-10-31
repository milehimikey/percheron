/**
 * The local-subagent adapter — percheron's reference Adapter.
 *
 * Executor: headless Claude Code (`claude -p --output-format json`), one
 * process per task, cwd'd into the node's git worktree. A standalone
 * controller has no in-session Agent tool; the CLI is the honest local
 * dispatch surface, and its flags are the guarantee layer:
 *
 *   - readOnly tasks get `--allowedTools Read Grep Glob` — the harness denies
 *     writes; the prompt never has to ask (request vs. guarantee).
 *   - write tasks get acceptEdits + an explicit tool list.
 *   - `--model` carries the role binding's model (independence is enforced by
 *     the controller before dispatch; this adapter just honors the value).
 *   - `limits` become `--max-budget-usd` / `--max-turns` and a deadline the
 *     adapter enforces by killing the process (v0.2).
 *
 * Workspace confinement (v0.2, benchmark finding 3 — a wave-1 agent wrote its
 * slice into the MAIN checkout, not its worktree) is two layers, both the
 * harness's, neither the prompt's:
 *
 *   1. Preventive: `--settings` carries `Edit(//…)` deny rules for every
 *      top-level entry of the main checkout (except the adapter's own state
 *      dir, where worktrees and evidence live). Edit rules cover the file
 *      tools, the file commands Claude Code recognizes in Bash (`sed`, `tee`,
 *      `cat`), and shell redirections. Deny beats allow; nothing the agent
 *      says can lift it.
 *   2. Guarantee: the main checkout's `git status` is snapshotted at dispatch
 *      and swept at collect. Anything new is a workspace escape: the stray
 *      content is QUARANTINED under `<stateDir>/quarantine/<task>/`, the
 *      checkout is restored, and the task exits `failed` with the violation
 *      named — the controller feeds it back into the retry. This catches what
 *      rules cannot (a Node script, a gradle task, `git -C ..`).
 *
 * Durability: every task has a disk record under `<stateDir>/tasks/`, and the
 * child's stdout streams to a file. If the controller dies, `status()` on a
 * fresh adapter recovers the result from disk; a dead pid with no parseable
 * result is reported as a failed exit marked INDETERMINATE — never silently
 * retried (the agent-operated-workflows rule: an interrupted mutation is
 * indeterminate, not failed-by-assumption; routing it is the controller's
 * decision, made visible).
 *
 * Idempotency: `createTask` keys the disk record by `idempotencyKey`; a
 * repeated key returns the existing task, running or finished.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type {
  Adapter,
  AdapterInfo,
  ExecResult,
  TaskEvent,
  TaskRef,
  TaskRequest,
  TaskResult,
  TaskStatus,
  WorkspaceRef,
} from "../contracts/adapter.js";
import type { Artifact, ArtifactKind, ExitKind } from "../contracts/core.js";
import { EXIT_KINDS } from "../contracts/core.js";

const execFileAsync = promisify(execFile);

export interface LocalSubagentConfig {
  /** The target project repo (worktrees are cut from here). */
  repoRoot: string;
  /** Adapter state root; MUST be gitignored. Default: `<repoRoot>/.percheron`. */
  stateDir?: string;
  claudeBin?: string; // default "claude"
  defaultModel?: string;
  /** Tool grants for readOnly tasks. Default: Read, Grep, Glob. */
  readOnlyTools?: string[];
  /** Tool grants for writing tasks. Default includes Bash (tests must run). */
  writeTools?: string[];
  maxConcurrentTasks?: number;
  /**
   * Workspace confinement (default true): deny rules on the main checkout +
   * the post-task sweep/quarantine. Turn off only for a repo you do not care
   * about — there is no "trust the agent" setting in between.
   */
  confine?: boolean;
}

interface TaskRecord {
  id: string;
  idempotencyKey: string;
  pid: number | null;
  startedAt: string;
  role: string;
  workspace: WorkspaceRef;
  produces: ArtifactKind[];
  artifactsDir: string;
  stdoutFile: string;
  limits?: TaskRequest["limits"];
  /** ISO time after which a still-running process is killed (limits.timeoutMs). */
  deadlineAt?: string;
  /** `git status --porcelain` of the main checkout at dispatch (`XY path` lines). */
  mainSnapshot?: string[];
  /** Set when the adapter killed the process; names the reason. */
  killedFor?: "timeout";
  result?: TaskResult;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export class LocalSubagentAdapter implements Adapter {
  private readonly cfg: Required<
    Pick<LocalSubagentConfig, "repoRoot" | "stateDir" | "claudeBin" | "confine">
  > &
    LocalSubagentConfig;

  constructor(config: LocalSubagentConfig) {
    this.cfg = {
      ...config,
      stateDir: config.stateDir ?? join(config.repoRoot, ".percheron"),
      claudeBin: config.claudeBin ?? "claude",
      confine: config.confine ?? true,
    };
  }

  info(): AdapterInfo {
    return {
      id: "local-subagent",
      version: "0.2.0",
      observation: ["poll"],
      workspaceKinds: ["worktree"],
      maxConcurrentTasks: this.cfg.maxConcurrentTasks ?? 4,
    };
  }

  async provisionWorkspace(
    nodeKey: string,
    opts?: { branch?: string; base?: string },
  ): Promise<WorkspaceRef> {
    const location = join(this.cfg.stateDir, "worktrees", nodeKey);
    if (!(await exists(location))) {
      const branch = opts?.branch ?? `impl/${nodeKey}`;
      const base = opts?.base ?? "main";
      await mkdir(join(this.cfg.stateDir, "worktrees"), { recursive: true });
      await execFileAsync(
        "git",
        ["worktree", "add", location, "-b", branch, base],
        { cwd: this.cfg.repoRoot },
      );
    }
    return { id: nodeKey, kind: "worktree", location };
  }

  async releaseWorkspace(ws: WorkspaceRef): Promise<void> {
    await execFileAsync("git", ["worktree", "remove", "--force", ws.location], {
      cwd: this.cfg.repoRoot,
    }).catch(() => {});
  }

  async createTask(request: TaskRequest): Promise<TaskRef> {
    const id = sha256(request.idempotencyKey).slice(0, 16);
    const existing = await this.readRecord(id);
    if (existing) return { adapterId: "local-subagent", id };

    const taskDir = join(this.cfg.stateDir, "tasks", id);
    const artifactsDir = join(
      this.cfg.stateDir,
      "evidence",
      request.context.key,
      `${request.role}-${id.slice(0, 8)}`,
    );
    await mkdir(taskDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const stdoutFile = join(taskDir, "stdout.json");
    const prompt = this.buildPrompt(request, artifactsDir);

    const tools = request.readOnly
      ? (this.cfg.readOnlyTools ?? ["Read", "Grep", "Glob"])
      : (this.cfg.writeTools ?? ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
    const model = request.model ?? this.cfg.defaultModel;
    const limits = request.limits;

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allowedTools",
      tools.join(","),
      ...(request.readOnly ? [] : ["--permission-mode", "acceptEdits"]),
      // Nobody answers prompts here: deny, tell the agent not to retry.
      "--permission-prompts",
      "none",
      ...(model ? ["--model", model] : []),
      "--add-dir",
      artifactsDir,
      ...(limits?.usd !== undefined ? ["--max-budget-usd", limits.usd.toFixed(2)] : []),
      ...(limits?.maxTurns !== undefined ? ["--max-turns", String(limits.maxTurns)] : []),
    ];

    // Confinement layer 1: deny rules on the main checkout, as settings.
    let mainSnapshot: string[] | undefined;
    if (this.cfg.confine) {
      const deny = await this.confinementDenyRules();
      if (deny.length) {
        args.push("--settings", JSON.stringify({ permissions: { deny } }));
      }
      mainSnapshot = await this.mainStatus();
    }

    const out = await open(stdoutFile, "w");
    const child = spawn(this.cfg.claudeBin, args, {
      cwd: request.workspace.location,
      stdio: ["ignore", out.fd, "ignore"],
      detached: true,
    });
    child.unref();
    await out.close();

    const startedAt = new Date();
    const record: TaskRecord = {
      id,
      idempotencyKey: request.idempotencyKey,
      pid: child.pid ?? null,
      startedAt: startedAt.toISOString(),
      role: request.role,
      workspace: request.workspace,
      produces: request.produces,
      artifactsDir,
      stdoutFile,
      ...(limits ? { limits } : {}),
      ...(limits?.timeoutMs !== undefined
        ? { deadlineAt: new Date(startedAt.getTime() + limits.timeoutMs).toISOString() }
        : {}),
      ...(mainSnapshot ? { mainSnapshot } : {}),
    };
    await this.writeRecord(record);
    return { adapterId: "local-subagent", id };
  }

  async status(ref: TaskRef): Promise<TaskStatus> {
    const record = await this.readRecord(ref.id);
    if (!record) throw new Error(`local-subagent: unknown task ${ref.id}`);
    if (record.result) return { state: "exited", result: record.result };

    const running = record.pid !== null && pidAlive(record.pid);

    // Deadline enforcement (limits.timeoutMs): kill, remember why, collect
    // on the next poll. SIGTERM: claude exits 143 and records no result.
    if (running && record.deadlineAt && !record.killedFor && Date.now() > Date.parse(record.deadlineAt)) {
      try {
        process.kill(record.pid as number, "SIGTERM");
      } catch {
        /* already gone */
      }
      record.killedFor = "timeout";
      await this.writeRecord(record);
      return { state: "running" };
    }

    const collected = await this.tryCollect(record);
    if (collected) return { state: "exited", result: await this.finalize(record, collected) };
    if (running) return { state: "running" };

    // Dead pid, no parseable result: INDETERMINATE, surfaced honestly — or a
    // deadline kill, which is a named limit violation.
    const indeterminate: TaskResult = {
      exit: "failed",
      artifacts: [],
      spend: {},
      transcriptRef: record.stdoutFile,
      ...(record.killedFor === "timeout"
        ? { violations: [`timeout: killed after exceeding ${record.limits?.timeoutMs}ms`] }
        : {}),
    };
    return { state: "exited", result: await this.finalize(record, indeterminate) };
  }

  async cancel(ref: TaskRef): Promise<void> {
    const record = await this.readRecord(ref.id);
    if (record?.pid && pidAlive(record.pid)) process.kill(record.pid);
  }

  async exec(
    ws: WorkspaceRef,
    command: string[],
    opts?: { timeoutMs?: number },
  ): Promise<ExecResult> {
    const [bin, ...rest] = command;
    if (!bin) throw new Error("local-subagent: exec needs a command");
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(bin, rest, {
        cwd: ws.location,
        timeout: opts?.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        durationMs: Date.now() - started,
      };
    }
  }

  events?(ref: TaskRef): AsyncIterable<TaskEvent> {
    throw new Error("local-subagent: poll via status(); no event stream in v0.2");
  }

  // ----- confinement -----

  /**
   * `Edit(//abs/**)` deny rules for every top-level entry of the main checkout
   * except the adapter's state dir (worktrees + evidence live there and must
   * stay writable). Absolute `//` patterns: the rules must not move with the
   * agent's cwd.
   */
  async confinementDenyRules(): Promise<string[]> {
    const root = await realpath(this.cfg.repoRoot);
    await mkdir(this.cfg.stateDir, { recursive: true });
    const stateReal = await realpath(this.cfg.stateDir);
    const rules: string[] = [];
    for (const e of await readdir(root, { withFileTypes: true })) {
      const abs = join(root, e.name);
      if (abs === stateReal || stateReal.startsWith(abs + sep)) continue;
      rules.push(e.isDirectory() ? `Edit(//${abs.slice(1)}/**)` : `Edit(//${abs.slice(1)})`);
    }
    return rules;
  }

  /** `XY path` lines of the main checkout, state dir excluded, sorted. */
  private async mainStatus(): Promise<string[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      { cwd: this.cfg.repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    const stateRel = relative(this.cfg.repoRoot, this.cfg.stateDir);
    const insideRepo = stateRel && !stateRel.startsWith("..");
    return stdout
      .split("\0")
      .filter((l) => l.length > 3)
      .filter((l) => !(insideRepo && (l.slice(3) === stateRel || l.slice(3).startsWith(stateRel + "/"))))
      .sort();
  }

  /**
   * Confinement layer 2: compare the main checkout against the dispatch
   * snapshot; quarantine and restore anything new; name the violation.
   */
  private async sweepMainCheckout(record: TaskRecord): Promise<string[]> {
    if (!record.mainSnapshot) return [];
    const before = new Set(record.mainSnapshot.map((l) => l.slice(3)));
    const escaped = (await this.mainStatus()).filter((l) => !before.has(l.slice(3)));
    if (!escaped.length) return [];

    const qdir = join(this.cfg.stateDir, "quarantine", record.id);
    const rels: string[] = [];
    for (const line of escaped) {
      const code = line.slice(0, 2);
      const rel = line.slice(3);
      const abs = join(this.cfg.repoRoot, rel);
      const dest = join(qdir, rel);
      await mkdir(dirname(dest), { recursive: true });
      if (code === "??") {
        await rename(abs, dest).catch(async () => {
          await copyFile(abs, dest);
          await rm(abs, { force: true });
        });
      } else {
        // Tracked path touched (modified / staged / deleted): keep the stray
        // content as evidence, then put HEAD back.
        if (await exists(abs)) await copyFile(abs, dest).catch(() => {});
        await execFileAsync("git", ["restore", "--staged", "--worktree", "--source=HEAD", "--", rel], {
          cwd: this.cfg.repoRoot,
        }).catch(() => {});
        // A staged-new file becomes untracked after restore; remove it too.
        const still = (await this.mainStatus()).some((l) => l.slice(3) === rel);
        if (still && (await exists(abs))) await rm(abs, { force: true });
      }
      rels.push(rel);
    }

    const concurrent = await this.otherLiveTasks(record.id);
    const attribution = concurrent.length
      ? ` (tasks ${concurrent.join(", ")} were live at the same time; the escape is attributed to the first task collected)`
      : "";
    return [
      `workspace-escape: ${rels.length} path(s) written to the main checkout ${this.cfg.repoRoot} instead of the workspace ${record.workspace.location}; quarantined to ${qdir}, checkout restored: ${rels.join(", ")}${attribution}`,
    ];
  }

  private async otherLiveTasks(exceptId: string): Promise<string[]> {
    const live: string[] = [];
    let ids: string[] = [];
    try {
      ids = await readdir(join(this.cfg.stateDir, "tasks"));
    } catch {
      return live;
    }
    for (const id of ids) {
      if (id === exceptId) continue;
      const r = await this.readRecord(id);
      if (r && !r.result && r.pid !== null && pidAlive(r.pid)) live.push(id);
    }
    return live;
  }

  /** Apply the sweep, demote on violations, persist. Single exit path. */
  private async finalize(record: TaskRecord, result: TaskResult): Promise<TaskResult> {
    const violations = [...(result.violations ?? [])];
    if (this.cfg.confine) violations.push(...(await this.sweepMainCheckout(record)));
    const final: TaskResult = {
      ...result,
      ...(violations.length ? { exit: "failed" as ExitKind, violations } : {}),
    };
    record.result = final;
    await this.writeRecord(record);
    return final;
  }

  // ----- internals -----

  private buildPrompt(request: TaskRequest, artifactsDir: string): string {
    const lines = [
      `You are the "${request.role}" worker for work node "${request.context.key}".`,
      request.context.title ? `Node title: ${request.context.title}` : "",
      "",
      `Your role contract (read it FIRST and follow it exactly): ${request.contractRef}`,
      request.context.briefRefs.length
        ? `Then read, in order: ${request.context.briefRefs.join(", ")}`
        : "",
      Object.keys(request.context.facts).length
        ? `Facts: ${Object.entries(request.context.facts)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ")}`
        : "",
      request.readOnly
        ? "You are READ-ONLY: report, never modify."
        : "Work only inside the current directory (your workspace). Writes anywhere else are denied by the harness and swept afterwards; a stray write fails the task.",
      "",
      `Deliverables — write each as a file in ${artifactsDir}:`,
      ...request.produces.map((kind) => `  - ${kind}: ${artifactsDir}/${kind}.md`),
      "",
      'Your FINAL message must be exactly one JSON object, nothing else:',
      '{"exit":"done"|"handoff"|"blocked"|"failed","summary":"<one sentence>"}',
    ];
    return lines.filter((l) => l !== "").join("\n");
  }

  /** Parse the headless-json output + collect declared artifacts from disk. */
  private async tryCollect(record: TaskRecord): Promise<TaskResult | null> {
    let raw: string;
    try {
      raw = await readFile(record.stdoutFile, "utf8");
    } catch {
      return null;
    }
    if (!raw.trim()) return null;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null; // still streaming
    }

    // The agent's own last message carries {"exit": ...}; find it in `result`.
    let exit: ExitKind = "failed";
    const text = String(doc["result"] ?? "");
    const match = text.match(/\{[^{}]*"exit"[^{}]*\}/g);
    const last = match?.at(-1);
    if (last) {
      try {
        const parsed = JSON.parse(last) as { exit?: string };
        if ((EXIT_KINDS as readonly string[]).includes(parsed.exit ?? "")) {
          exit = parsed.exit as ExitKind;
        }
      } catch {
        /* exit stays failed */
      }
    }
    if (doc["is_error"] === true) exit = "failed";

    // Limit hits are the harness's stops, named (subtype per the SDK result
    // schema: error_max_turns / error_max_budget_usd).
    const violations: string[] = [];
    const subtype = String(doc["subtype"] ?? "");
    const turns = doc["num_turns"];
    if (subtype === "error_max_turns") {
      violations.push(`max-turns: run stopped at ${turns ?? "?"} turns (limit ${record.limits?.maxTurns ?? "?"})`);
    } else if (subtype === "error_max_budget_usd") {
      violations.push(
        `max-budget-usd: run stopped at $${Number(doc["total_cost_usd"] ?? 0).toFixed(2)} (limit $${record.limits?.usd?.toFixed(2) ?? "?"})`,
      );
    }

    const artifacts: Artifact[] = [];
    for (const kind of record.produces) {
      const ref = join(record.artifactsDir, `${kind}.md`);
      try {
        const content = await readFile(ref);
        artifacts.push({ kind, ref, sha256: sha256(content) });
      } catch {
        /* missing artifact: controller compares against `produces` and refuses */
      }
    }

    const spend: TaskResult["spend"] = {};
    if (typeof doc["total_cost_usd"] === "number") spend.usd = doc["total_cost_usd"];
    if (typeof doc["duration_ms"] === "number") spend.wallClockMs = doc["duration_ms"];

    return {
      exit,
      artifacts,
      spend,
      transcriptRef: record.stdoutFile,
      ...(violations.length ? { violations } : {}),
    };
  }

  private recordPath(id: string): string {
    return join(this.cfg.stateDir, "tasks", id, "record.json");
  }

  private async readRecord(id: string): Promise<TaskRecord | null> {
    try {
      return JSON.parse(await readFile(this.recordPath(id), "utf8")) as TaskRecord;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: TaskRecord): Promise<void> {
    await mkdir(join(this.cfg.stateDir, "tasks", record.id), { recursive: true });
    await writeFile(this.recordPath(record.id), JSON.stringify(record, null, 2));
  }
}
