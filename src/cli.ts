#!/usr/bin/env node
/**
 * percheron CLI (v0.2):
 *
 *   percheron validate <engagement.yaml> [--json]
 *   percheron run      <engagement.yaml> [--plan] [--once] [--poll-ms N] [--max-ticks N]
 *   percheron status   <engagement.yaml> [--json]
 *   percheron reopen   <engagement.yaml> <node> --reason "<why>"
 *   percheron reject   <engagement.yaml> <node> --reason "<why>" [--feedback "<note>"]
 *   percheron stop     <engagement.yaml>
 *
 * validate: static spec validation — ok/issues with severity, exact field path
 *   and the fixing action. Exit 0 ok (warnings allowed), 1 errors, 2 usage.
 * run: wire provider/adapters/observers from the spec and drive the controller
 *   until settled (every node terminal, or only parked gates remain). Resumable:
 *   rerun with the same spec and the same ledger continues. `--plan` derives
 *   and prints the graph without dispatching; `--once` runs a single tick.
 * status: the ledger's per-node view plus the settle summary.
 * stop: end the running controller for this spec and nothing else. Agents are
 *   detached and keep running; a running check is re-run on resume.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatIssues, validateSpecFile } from "./controller/spec-loader.js";
import type { NodePipelineState } from "./contracts/ledger.js";
import { readPidFile, removePidFile, stopPid, writePidFile } from "./pidfile.js";
import { buildRuntime } from "./run.js";

const USAGE = [
  "usage:",
  "  percheron validate <engagement.yaml> [--json]",
  "  percheron run      <engagement.yaml> [--plan] [--once] [--poll-ms N] [--max-ticks N]",
  "  percheron status   <engagement.yaml> [--json]",
  "  percheron reopen   <engagement.yaml> <node> --reason \"<why>\" [--feedback \"<note for the retry>\" | --clear-feedback]   (controller stopped)",
  "  percheron reject   <engagement.yaml> <node> --reason \"<why>\" [--feedback \"<note for the retry>\"]   (parked gate; controller stopped)",
  "  percheron stop     <engagement.yaml>                  (ends the controller only; agents keep running)",
  "",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function validate(file: string, args: string[]): Promise<number> {
  const v = await validateSpecFile(file);
  if (args.includes("--json")) {
    const { spec: _spec, ...report } = v;
    process.stdout.write(JSON.stringify({ file, ...report }, null, 2) + "\n");
  } else {
    const errors = v.issues.filter((i) => i.severity === "error").length;
    const warnings = v.issues.length - errors;
    process.stdout.write(
      `${v.ok ? "ok" : "FAILED"}: ${file}, ${errors} error(s), ${warnings} warning(s)` +
        (v.spec ? ` · ${v.spec.name} · ${v.spec.pipeline.steps.length} step(s), entry ${v.spec.pipeline.entry}` : "") +
        "\n" +
        (v.issues.length ? formatIssues(v.issues) + "\n" : ""),
    );
  }
  return v.ok ? 0 : 1;
}

async function run(file: string, args: string[]): Promise<number> {
  const rt = await buildRuntime(file);
  for (const w of rt.warnings) process.stderr.write(`[percheron] spec warning ${w.path}: ${w.message}\n`);
  process.stderr.write(`[percheron] ${rt.spec.name}: repo ${rt.repoRoot}, ledger ${rt.ledgerPath}\n`);
  const graph = await rt.controller.plan();
  if (args.includes("--plan")) {
    for (const n of [...graph.nodes].sort((a, b) => (a.orderingHint ?? 0) - (b.orderingHint ?? 0))) {
      process.stdout.write(
        `L${n.orderingHint ?? "?"}  ${n.key.padEnd(26)} deps=[${n.dependsOn.join(",")}]` +
          `${n.meta["held"] ? ` HELD(${n.meta["held"]})` : ""}${n.meta["state"] ? ` state=${n.meta["state"]}` : ""}\n`,
      );
    }
    return 0;
  }
  if (args.includes("--once")) {
    const progressed = await rt.controller.tick();
    const s = await rt.controller.summary();
    process.stdout.write(JSON.stringify({ progressed, ...s }, null, 2) + "\n");
    return 0;
  }
  const pollMs = Number(flag(args, "--poll-ms") ?? 5000);
  const maxTicks = Number(flag(args, "--max-ticks") ?? 100000);
  const pidPath = pidFile(rt.stateDir, rt.spec.name);
  const other = await readPidFile(pidPath);
  if (other !== null) {
    process.stderr.write(`percheron: a controller for ${rt.spec.name} is already running (pid ${other}); \`percheron stop\` it first\n`);
    return 1;
  }
  await writePidFile(pidPath, process.pid);
  // `percheron stop` / Ctrl-C: end our own check commands, leave the agents,
  // exit. The ledger is already up to date; resume picks everything back up.
  const stop = (signal: string) => {
    process.stderr.write(`[percheron] ${signal}: stopping the controller; agents keep running, checks re-run on resume\n`);
    void rt.controller.shutdown().finally(() => removePidFile(pidPath).finally(() => process.exit(0)));
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  try {
    const summary = await rt.controller.runUntilSettled({ pollMs, maxTicks });
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.escalated.length ? 1 : 0;
  } finally {
    await removePidFile(pidPath);
  }
}

function pidFile(stateDir: string, name: string): string {
  return join(stateDir, `controller-${name}.pid`);
}

async function stop(file: string): Promise<number> {
  const rt = await buildRuntime(file, { log: () => {} });
  const pidPath = pidFile(rt.stateDir, rt.spec.name);
  const pid = await readPidFile(pidPath);
  if (pid === null) {
    process.stdout.write(`${rt.spec.name}: no controller running\n`);
    return 0;
  }
  const outcome = await stopPid(pid);
  if (outcome === "stopped") {
    await removePidFile(pidPath);
    process.stdout.write(`${rt.spec.name}: controller ${pid} stopped; agents keep running, resume with \`percheron run\`\n`);
    return 0;
  }
  process.stderr.write(`${rt.spec.name}: controller ${pid} did not exit within 15s; it may be mid-write. Try again, then \`kill ${pid}\`\n`);
  return 1;
}

async function status(file: string, args: string[]): Promise<number> {
  const rt = await buildRuntime(file, { log: () => {} });
  await rt.controller.plan();
  const summary = await rt.controller.summary();
  let nodes: NodePipelineState[] = [];
  try {
    const doc = JSON.parse(await readFile(rt.ledgerPath, "utf8")) as { nodes: Record<string, NodePipelineState> };
    nodes = Object.values(doc.nodes);
  } catch {
    /* no ledger yet */
  }
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ summary, nodes }, null, 2) + "\n");
    return 0;
  }
  const spend = nodes.reduce((a, n) => a + (n.spend.usd ?? 0), 0);
  const pid = await readPidFile(pidFile(rt.stateDir, rt.spec.name));
  process.stdout.write(`${rt.spec.name}: done ${summary.done.length} · parked ${summary.parked.length} · pending ${summary.pending.length} · escalated ${summary.escalated.length} · spend $${spend.toFixed(2)} · controller ${pid === null ? "not running" : `running (pid ${pid})`}\n`);
  for (const n of nodes.sort((a, b) => a.nodeKey.localeCompare(b.nodeKey))) {
    const where = n.terminal ? n.terminal.toUpperCase() : n.parked ? `parked@${n.parked.gateStepId}` : `${n.stepId ?? "-"}${n.activeTask || n.groupTasks ? " (running)" : ""}`;
    const edges = Object.entries(n.rounds ?? {}).map(([e, c]) => `${e}:${c}`).join(" ");
    process.stdout.write(`  ${n.nodeKey.padEnd(26)} ${where.padEnd(22)} round ${n.round}${edges ? ` [${edges}]` : ""} hops ${n.hops} $${(n.spend.usd ?? 0).toFixed(2)}\n`);
  }
  return 0;
}

async function reopen(file: string, args: string[]): Promise<number> {
  const node = args.filter((a) => !a.startsWith("--")).find((a) => a !== file && !/^\d+$/.test(a));
  const reason = flag(args, "--reason");
  if (!node || !reason) {
    process.stderr.write(USAGE);
    return 2;
  }
  const rt = await buildRuntime(file);
  const feedback = args.includes("--clear-feedback") ? null : flag(args, "--feedback");
  await rt.controller.reopen(node, reason, feedback === undefined ? {} : { feedback });
  return 0;
}

async function reject(file: string, args: string[]): Promise<number> {
  const node = args.filter((a) => !a.startsWith("--")).find((a) => a !== file && !/^\d+$/.test(a));
  const reason = flag(args, "--reason");
  if (!node || !reason) {
    process.stderr.write(USAGE);
    return 2;
  }
  const rt = await buildRuntime(file);
  const feedback = flag(args, "--feedback");
  await rt.controller.rejectGate(node, reason, feedback === undefined ? {} : { feedback });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const file = rest.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  if (!cmd || !file) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (cmd) {
    case "validate":
      return validate(file, rest);
    case "run":
      return run(file, rest);
    case "status":
      return status(file, rest);
    case "reopen":
      return reopen(file, rest);
    case "reject":
      return reject(file, rest);
    case "stop":
      return stop(file);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`percheron: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
