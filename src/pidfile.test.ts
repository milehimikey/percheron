import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPidFile, removePidFile, writePidFile } from "./pidfile.js";

test("pid file: written, read back while alive, stale when the pid is dead, absent after remove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "percheron-pid-"));
  const path = join(dir, "controller-x.pid");
  assert.equal(await readPidFile(path), null, "no file");
  await writePidFile(path, process.pid);
  assert.equal(await readPidFile(path), process.pid, "our own pid is alive");
  await writeFile(path, "999999999\n");
  assert.equal(await readPidFile(path), null, "a dead pid reads as no controller");
  await writeFile(path, "garbage\n");
  assert.equal(await readPidFile(path), null, "unparseable reads as no controller");
  await removePidFile(path);
  await removePidFile(path); // idempotent
  assert.equal(await readPidFile(path), null);
});
