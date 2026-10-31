/**
 * local-subagent adapter: confinement (deny rules + sweep/quarantine), limit
 * flags, limit-hit mapping, deadline kill. A fake `claude` binary stands in
 * for the real one — the guarantees under test are the ADAPTER's, and they
 * must hold no matter what the executor does.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubagentAdapter } from "./local-subagent.js";
import type { TaskRequest, TaskStatus } from "../contracts/adapter.js";

const execFileAsync = promisify(execFile);

let root: string;
let repo: string;
let fakeClaude: string;

/**
 * The fake executor. Behaviour is driven by env (set per test before
 * createTask; the detached child inherits it):
 *   FAKE_STRAY=<abs path>     write a stray file there (an escape)
 *   FAKE_CLOBBER=<abs path>   overwrite a tracked file there (an escape)
 *   FAKE_SUBTYPE=<subtype>    emit that result subtype instead of success
 *   FAKE_SLEEP=<seconds>      sleep before exiting (deadline test)
 * It records its argv to <artifactsDir>/argv.txt and writes report.md.
 */
const FAKE = `#!/bin/bash
set -u
add_dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--add-dir" ]; then add_dir="$a"; fi
  prev="$a"
done
printf '%s\\n' "$@" > "$add_dir/argv.txt"
[ -n "\${FAKE_SLEEP:-}" ] && sleep "$FAKE_SLEEP"
[ -n "\${FAKE_STRAY:-}" ] && { mkdir -p "$(dirname "$FAKE_STRAY")"; echo stray > "$FAKE_STRAY"; }
[ -n "\${FAKE_CLOBBER:-}" ] && echo clobbered > "$FAKE_CLOBBER"
echo "in-workspace work" > ./work.txt
echo "# report" > "$add_dir/report.md"
if [ -n "\${FAKE_SUBTYPE:-}" ]; then
  printf '{"type":"result","subtype":"%s","is_error":true,"num_turns":7,"total_cost_usd":0.42,"duration_ms":10,"errors":[]}' "$FAKE_SUBTYPE"
else
  printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.05,"duration_ms":10,"result":"ok {\\\\"exit\\\\":\\\\"done\\\\",\\\\"summary\\\\":\\\\"did it\\\\"}"}'
fi
`;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "percheron-adapter-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "hello\n");
  await writeFile(join(repo, "src", "a.txt"), "original\n");
  await writeFile(join(repo, ".gitignore"), ".percheron/\n");
  const git = (...a: string[]) => execFileAsync("git", a, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
  fakeClaude = join(root, "claude");
  await writeFile(fakeClaude, FAKE);
  await chmod(fakeClaude, 0o755);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter() {
  return new LocalSubagentAdapter({ repoRoot: repo, claudeBin: fakeClaude });
}

function request(key: string, extra: Partial<TaskRequest> = {}): TaskRequest {
  return {
    idempotencyKey: `t/${key}/${Math.random()}`,
    role: "implementer",
    contractRef: "roles/implementer.md",
    context: { key, briefRefs: [], facts: {} },
    workspace: { id: key, kind: "worktree", location: "" },
    produces: ["report"],
    ...extra,
  };
}

async function settle(a: LocalSubagentAdapter, ref: { adapterId: string; id: string }, ms = 10_000): Promise<TaskStatus> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await a.status(ref);
    if (s.state === "exited") return s;
    if (Date.now() > until) throw new Error("task did not exit in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

test("deny rules fence every top-level entry of the main checkout except the state dir", async () => {
  const rules = await adapter().confinementDenyRules();
  const real = (await execFileAsync("realpath", [repo])).stdout.trim();
  assert.ok(rules.includes(`Edit(//${real.slice(1)}/README.md)`), rules.join("\n"));
  assert.ok(rules.includes(`Edit(//${real.slice(1)}/src/**)`));
  assert.ok(rules.includes(`Edit(//${real.slice(1)}/.git/**)`));
  assert.ok(!rules.some((r) => r.includes(".percheron")), "state dir must stay writable");
});

test("flags: limits become --max-budget-usd/--max-turns; prompts denied; deny rules passed as settings", async () => {
  const a = adapter();
  const ws = await a.provisionWorkspace("flags");
  const ref = await a.createTask(
    request("flags", { workspace: ws, limits: { usd: 1.234, maxTurns: 12, timeoutMs: 60_000 } }),
  );
  const s = await settle(a, ref);
  assert.equal(s.state, "exited");
  const report = s.state === "exited" ? s.result.artifacts.find((x) => x.kind === "report") : undefined;
  assert.ok(report);
  const argv = (await readFile(join(report.ref, "..", "argv.txt"), "utf8")).split("\n");
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.equal(flag("--max-budget-usd"), "1.23");
  assert.equal(flag("--max-turns"), "12");
  assert.equal(flag("--permission-prompts"), "none");
  const settings = JSON.parse(flag("--settings") ?? "{}") as { permissions?: { deny?: string[] } };
  assert.ok((settings.permissions?.deny ?? []).some((r) => r.endsWith("/src/**)")));
  if (s.state === "exited") {
    assert.equal(s.result.exit, "done");
    assert.equal(s.result.violations, undefined);
    assert.equal(s.result.spend.usd, 0.05);
  }
  await a.releaseWorkspace(ws);
});

test(
  "sweep: a stray file in the main checkout fails the task, is quarantined, and the checkout is restored",
  withEnv({ FAKE_STRAY: "", FAKE_CLOBBER: "" }, async () => {
    process.env["FAKE_STRAY"] = join(repo, "src", "escaped.kt");
    process.env["FAKE_CLOBBER"] = join(repo, "src", "a.txt");
    const a = adapter();
    const ws = await a.provisionWorkspace("escape");
    const ref = await a.createTask(request("escape", { workspace: ws }));
    const s = await settle(a, ref);
    assert.equal(s.state, "exited");
    if (s.state !== "exited") return;
    assert.equal(s.result.exit, "failed", "escaping task must not pass");
    assert.equal(s.result.violations?.length, 1);
    assert.match(s.result.violations?.[0] ?? "", /workspace-escape: 2 path\(s\)/);
    assert.match(s.result.violations?.[0] ?? "", /src\/escaped\.kt/);
    assert.match(s.result.violations?.[0] ?? "", /src\/a\.txt/);
    // Main checkout restored.
    assert.ok(!existsSync(join(repo, "src", "escaped.kt")), "stray file still in main checkout");
    assert.equal(await readFile(join(repo, "src", "a.txt"), "utf8"), "original\n");
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(stdout.trim(), "", `main checkout dirty after sweep:\n${stdout}`);
    // Evidence kept.
    const q = join(repo, ".percheron", "quarantine", ref.id);
    assert.equal(await readFile(join(q, "src", "escaped.kt"), "utf8"), "stray\n");
    assert.equal(await readFile(join(q, "src", "a.txt"), "utf8"), "clobbered\n");
    // In-workspace work untouched; artifacts still collected.
    assert.ok(existsSync(join(ws.location, "work.txt")));
    assert.equal(s.result.artifacts.length, 1);
    // Idempotent: a second status() returns the same verdict from disk.
    const again = await a.status(ref);
    assert.deepEqual(again, s);
    await a.releaseWorkspace(ws);
  }),
);

test(
  "sweep ignores pre-existing dirt: only what appeared since dispatch counts",
  withEnv({}, async () => {
    await writeFile(join(repo, "preexisting.txt"), "was here\n");
    try {
      const a = adapter();
      const ws = await a.provisionWorkspace("dirt");
      const ref = await a.createTask(request("dirt", { workspace: ws }));
      const s = await settle(a, ref);
      assert.ok(s.state === "exited" && s.result.exit === "done" && !s.result.violations);
      assert.ok(existsSync(join(repo, "preexisting.txt")), "sweep must not touch pre-existing files");
      await a.releaseWorkspace(ws);
    } finally {
      await rm(join(repo, "preexisting.txt"), { force: true });
    }
  }),
);

test(
  "limit hits are named: error_max_turns → failed with a max-turns violation",
  withEnv({ FAKE_SUBTYPE: "error_max_turns" }, async () => {
    const a = adapter();
    const ws = await a.provisionWorkspace("turns");
    const ref = await a.createTask(request("turns", { workspace: ws, limits: { maxTurns: 7 } }));
    const s = await settle(a, ref);
    assert.ok(s.state === "exited");
    assert.equal(s.result.exit, "failed");
    assert.match(s.result.violations?.[0] ?? "", /^max-turns: run stopped at 7 turns \(limit 7\)/);
    assert.equal(s.result.spend.usd, 0.42, "spend is still accounted on a limit stop");
    await a.releaseWorkspace(ws);
  }),
);

test(
  "limit hits are named: error_max_budget_usd → failed with a max-budget-usd violation",
  withEnv({ FAKE_SUBTYPE: "error_max_budget_usd" }, async () => {
    const a = adapter();
    const ws = await a.provisionWorkspace("budget");
    const ref = await a.createTask(request("budget", { workspace: ws, limits: { usd: 0.4 } }));
    const s = await settle(a, ref);
    assert.ok(s.state === "exited");
    assert.equal(s.result.exit, "failed");
    assert.match(s.result.violations?.[0] ?? "", /^max-budget-usd: run stopped at \$0\.42 \(limit \$0\.40\)/);
    await a.releaseWorkspace(ws);
  }),
);

test(
  "deadline: a task past limits.timeoutMs is killed and exits failed with a timeout violation",
  withEnv({ FAKE_SLEEP: "30" }, async () => {
    const a = adapter();
    const ws = await a.provisionWorkspace("slow");
    const ref = await a.createTask(request("slow", { workspace: ws, limits: { timeoutMs: 300 } }));
    const first = await a.status(ref);
    assert.equal(first.state, "running");
    const s = await settle(a, ref, 5_000);
    assert.ok(s.state === "exited");
    assert.equal(s.result.exit, "failed");
    assert.match(s.result.violations?.[0] ?? "", /^timeout: killed after exceeding 300ms/);
    await a.releaseWorkspace(ws);
  }),
);
