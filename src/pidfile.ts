/**
 * The controller's pid file: `<stateDir>/controller-<engagement>.pid`, written
 * when `percheron run` starts driving and removed when it exits. `percheron
 * stop` reads it; `percheron status` reports it. A stale file (its pid dead)
 * is treated as absent so a crashed controller never blocks the next run.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live controller's pid, or null when there is none (no file, or a stale one). */
export async function readPidFile(path: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pidAlive(pid) ? pid : null;
}

export async function writePidFile(path: string, pid: number): Promise<void> {
  await writeFile(path, `${pid}\n`, "utf8");
}

export async function removePidFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

/**
 * Ask a controller to stop and wait for it to go: SIGTERM, then poll the pid
 * up to `waitMs`. Returns how it ended. The controller handles SIGTERM by
 * ending its own check commands and exiting; detached agents keep running.
 */
export async function stopPid(pid: number, waitMs = 15000): Promise<"stopped" | "still-running"> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return "stopped";
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return "stopped";
    await new Promise((r) => setTimeout(r, 200));
  }
  return "still-running";
}
