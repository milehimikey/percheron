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
  mkdir,
  readFile,
  writeFile,
  access,
  open,
} from "node:fs/promises";
import { join } from "node:path";

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
    Pick<LocalSubagentConfig, "repoRoot" | "stateDir" | "claudeBin">
  > &
    LocalSubagentConfig;

  constructor(config: LocalSubagentConfig) {
    this.cfg = {
      ...config,
      stateDir: config.stateDir ?? join(config.repoRoot, ".percheron"),
      claudeBin: config.claudeBin ?? "claude",
    };
  }

  info(): AdapterInfo {
    return {
      id: "local-subagent",
      version: "0.1.0",
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

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allowedTools",
      tools.join(","),
      ...(request.readOnly ? [] : ["--permission-mode", "acceptEdits"]),
      ...(model ? ["--model", model] : []),
      "--add-dir",
      artifactsDir,
    ];

    const out = await open(stdoutFile, "w");
    const child = spawn(this.cfg.claudeBin, args, {
      cwd: request.workspace.location,
      stdio: ["ignore", out.fd, "ignore"],
      detached: true,
    });
    child.unref();
    await out.close();

    const record: TaskRecord = {
      id,
      idempotencyKey: request.idempotencyKey,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      role: request.role,
      workspace: request.workspace,
      produces: request.produces,
      artifactsDir,
      stdoutFile,
    };
    await this.writeRecord(record);
    return { adapterId: "local-subagent", id };
  }

  async status(ref: TaskRef): Promise<TaskStatus> {
    const record = await this.readRecord(ref.id);
    if (!record) throw new Error(`local-subagent: unknown task ${ref.id}`);
    if (record.result) return { state: "exited", result: record.result };

    const running = record.pid !== null && pidAlive(record.pid);
    const result = await this.tryCollect(record);
    if (result) {
      record.result = result;
      await this.writeRecord(record);
      return { state: "exited", result };
    }
    if (running) return { state: "running" };

    // Dead pid, no parseable result: INDETERMINATE, surfaced honestly.
    const indeterminate: TaskResult = {
      exit: "failed",
      artifacts: [],
      spend: {},
      transcriptRef: record.stdoutFile,
    };
    record.result = indeterminate;
    await this.writeRecord(record);
    return { state: "exited", result: indeterminate };
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
    throw new Error("local-subagent: poll via status(); no event stream in v0.1");
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
        : "Work only inside the current directory (your workspace).",
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

    return { exit, artifacts, spend, transcriptRef: record.stdoutFile };
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
