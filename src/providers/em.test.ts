/**
 * em provider: config parsing and the branch-prefix override (pure parts —
 * everything else shells out to the em CLI).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EmProvider, resolveBranch } from "./em.js";

test("parseConfig: branchPrefix is optional and must be a branch-name fragment", () => {
  const p = new EmProvider();
  assert.deepEqual(p.parseConfig({ model: "m.em", engagement: "e" }), { model: "m.em", engagement: "e" });
  assert.equal(p.parseConfig({ model: "m.em", engagement: "e", branchPrefix: "percheron/" }).branchPrefix, "percheron/");
  assert.throws(() => p.parseConfig({ model: "m.em", engagement: "e", branchPrefix: "bad prefix" }), /branchPrefix/);
  assert.throws(() => p.parseConfig({ model: "m.em", engagement: "e", branchPrefix: 7 }), /branchPrefix/);
});

test("resolveBranch: em's plan branch unless the prefix overrides it (finding 10: two harnesses, one model)", () => {
  const slice = { key: "fulfill-hold", branch: "impl/fulfill-hold" };
  assert.equal(resolveBranch({}, slice), "impl/fulfill-hold");
  assert.equal(resolveBranch({ branchPrefix: "percheron/" }, slice), "percheron/fulfill-hold");
  assert.equal(resolveBranch({ branchPrefix: "p-" }, slice), "p-fulfill-hold");
});
