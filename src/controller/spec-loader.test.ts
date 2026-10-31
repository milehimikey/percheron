/**
 * Spec loader: the canonical example loads and maps; every strictness rule
 * refuses with the exact field path; the Controller accepts what the loader
 * produces.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Controller } from "./controller.js";
import {
  parseDuration,
  splitArgv,
  validateSpecDocument,
  validateSpecFile,
  validateSpecText,
  loadSpecFile,
  SpecValidationError,
} from "./spec-loader.js";
import type { SpecIssue } from "./spec-loader.js";
import type { Provider } from "../contracts/provider.js";
import type { Ledger } from "../contracts/ledger.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const EXAMPLE = join(repoRoot, "examples", "em-engagement.yaml");

type Issues = SpecIssue[] | { issues: SpecIssue[] };
const errors = (v: Issues) => (Array.isArray(v) ? v : v.issues).filter((i) => i.severity === "error");
const paths = (v: Issues) => errors(v).map((i) => i.path);

/** A minimal valid document to mutate in the negative tests. */
function base(): Record<string, unknown> {
  return {
    specVersion: "0.2",
    engagement: { name: "t" },
    work: { provider: "em", config: { model: "m.em", engagement: "t" } },
    roles: {
      implementer: { adapter: "local-subagent", model: "sonnet" },
      critic: { adapter: "local-subagent", model: "opus", independence: { modelNot: ["implementer"] } },
    },
    pipeline: {
      entry: "implement",
      guards: { maxRounds: 2, maxHops: 10 },
      steps: [
        {
          id: "implement", kind: "agent", role: "implementer", contract: "roles/implementer.md",
          produces: ["pr"], on: { done: "validate", failed: "implement", blocked: "escalate" },
        },
        { id: "validate", kind: "check", run: ["true"], on: { done: "gate", failed: "implement" } },
        {
          id: "gate", kind: "human", gate: { summary: "merge?" },
          acceptance: { observer: "git-merged", candidateRef: "branch", verdicts: ["merged"] },
          on: { done: "node-done" },
        },
      ],
    },
  };
}

function check(mutate: (d: Record<string, unknown>) => void) {
  const d = base();
  mutate(d);
  return validateSpecDocument(d, { baseDir: repoRoot });
}

test("the canonical example validates with no errors and maps onto EngagementSpec", async () => {
  const v = await validateSpecFile(EXAMPLE);
  assert.deepEqual(errors(v.issues), [], JSON.stringify(v.issues, null, 1));
  assert.ok(v.ok && v.spec);
  const s = v.spec;
  assert.equal(s.name, "checkout-2026-11");
  assert.equal(s.specVersion, "0.2");
  assert.equal(s.engagement?.mode, "build");
  assert.equal(s.engagement?.goalSpec, join(repoRoot, "examples", "goal-spec.md"));
  assert.deepEqual(s.work.transitions, {
    onDispatch: "building", onGateParked: "awaiting-merge", onGateCleared: "merged", onEscalate: "held",
  });
  assert.deepEqual(s.budgets, {
    perNodeUsd: 15, dispatchFloorUsd: 0.5, perTask: { usd: 6, maxTurns: 80, timeoutMs: 20 * 60_000 },
  });
  assert.deepEqual(s.scheduling, { maxConcurrent: 4 });
  assert.deepEqual(s.policy, { ratifiers: ["mikey"], mergeAuthority: "human", exceptionRouting: "human_only" });
  assert.deepEqual(s.roles["critic"]?.independence, { freshContext: true, modelNot: ["implementer"], blindTo: ["review"] });
  assert.ok(s.tools && "em" in s.tools);
  assert.deepEqual(s.adapters, { "local-subagent": {} });

  const impl = s.pipeline.steps[0];
  assert.ok(impl?.kind === "agent");
  assert.equal(impl.contractRef, join(repoRoot, "roles", "implementer.md"));
  assert.deepEqual(impl.produces, ["pr", "evidenceMap", "continuationNote"]);

  const validate = s.pipeline.steps[1];
  assert.ok(validate?.kind === "check");
  assert.deepEqual(validate.run, [
    ["em", "validate", "models/checkout.em", "--slice-ready", "{key}", "--json"],
    ["./gradlew", "test", "--quiet"],
  ]);

  const review = s.pipeline.steps.find((x) => x.id === "review");
  assert.ok(review?.kind === "agent" && review.readOnly === true && review.parallelWith?.[0] === "critique");

  const gate = s.pipeline.steps.at(-1);
  assert.ok(gate?.kind === "human");
  assert.deepEqual(gate.acceptance, { observer: "git-merged", candidateRef: "branch", verdicts: ["merged"] });
  assert.deepEqual(gate.on, { done: "node-done", failed: "escalate" });
});

test("the Controller accepts the loaded example (constructor validation parity)", async () => {
  const { spec, warnings } = await loadSpecFile(EXAMPLE);
  assert.deepEqual(warnings, []);
  const provider = {
    info: () => ({ id: "em", version: "0", requires: [] }),
    parseConfig: (raw: unknown) => raw,
    preflight: async () => [],
    deriveGraph: async () => ({ nodes: [], derivedFrom: { id: "x", version: "0" } }),
    readiness: async () => ({ ready: true, blockedBy: [] }),
    nodeContext: async () => ({ key: "k", briefRefs: [], facts: {} }),
    onTransition: async () => {},
  } satisfies Provider<unknown>;
  const ledger = { load: async () => ({ nodes: [], events: [] }), setNodeState: async () => {}, append: async () => {} } satisfies Ledger;
  assert.doesNotThrow(() => new Controller(spec, { provider, adapters: {}, observers: {}, ledger, log: () => {} }));
});

test("the minimal base is valid", () => {
  const v = check(() => {});
  assert.deepEqual(errors(v.issues), []);
  assert.ok(v.ok);
});

test("unknown keys are refused with their path — anywhere", () => {
  assert.deepEqual(paths(check((d) => { d["prose"] = "never"; })), ["prose"]);
  assert.deepEqual(paths(check((d) => { (d["work"] as Record<string, unknown>)["notes"] = 1; })), ["work.notes"]);
  const v = check((d) => { ((d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[])[0]!["prompt"] = "be careful"; });
  assert.deepEqual(paths(v.issues), ["pipeline.steps[0].prompt"]);
});

test("specVersion: must be a quoted string with a supported major", () => {
  const num = check((d) => { d["specVersion"] = 0.2; });
  assert.deepEqual(paths(num.issues), ["specVersion"]);
  assert.match(errors(num.issues)[0]?.fix ?? "", /quoted/);
  const major = check((d) => { d["specVersion"] = "1.0"; });
  assert.match(errors(major.issues)[0]?.message ?? "", /major 1 is not supported/);
});

test("closed enums: exits, produces, step kinds, exit names in `on`", () => {
  assert.deepEqual(paths(check((d) => { (d["pipeline"] as Record<string, unknown>)["exits"] = ["done", "failed"]; })), ["pipeline.exits"]);
  const steps = (d: Record<string, unknown>) => (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
  assert.deepEqual(paths(check((d) => { steps(d)[0]!["produces"] = ["pr", "poem"]; })), ["pipeline.steps[0].produces"]);
  assert.deepEqual(paths(check((d) => { steps(d)[1]!["kind"] = "llm"; })), ["pipeline.steps[1].kind"]);
  assert.deepEqual(paths(check((d) => { (steps(d)[0]!["on"] as Record<string, string>)["maybe"] = "validate"; })), ["pipeline.steps[0].on.maybe"]);
});

test("routes must resolve; node-done and escalate are keywords, never step ids", () => {
  const steps = (d: Record<string, unknown>) => (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
  assert.deepEqual(paths(check((d) => { (steps(d)[0]!["on"] as Record<string, string>)["done"] = "nowhere"; })), ["pipeline.steps[0].on.done"]);
  const v = check((d) => { steps(d).push({ id: "escalate", kind: "human", gate: { summary: "x" }, acceptance: { observer: "o", candidateRef: "pr", verdicts: ["ok"] } }); });
  assert.deepEqual(paths(v.issues), ["pipeline.steps[3].id"]);
  assert.match(errors(v.issues)[0]?.fix ?? "", /built in/);
  assert.deepEqual(paths(check((d) => { (d["pipeline"] as Record<string, unknown>)["entry"] = "ghost"; })), ["pipeline.entry"]);
});

test("parallel groups: symmetric membership and identical routes", () => {
  const v = check((d) => {
    const steps = (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
    steps.splice(2, 0,
      { id: "review", kind: "agent", role: "implementer", contract: "roles/reviewer.md", produces: ["findings"], parallelWith: ["critique"], on: { done: "gate", failed: "implement" } },
      { id: "critique", kind: "agent", role: "critic", contract: "roles/critic.md", produces: ["findings"], on: { done: "gate" } },
    );
    (steps[1]!["on"] as Record<string, string>)["done"] = "review";
  });
  const p = paths(v.issues);
  assert.ok(p.includes("pipeline.steps[2].parallelWith"), p.join());
  assert.ok(p.includes("pipeline.steps[2].on"), p.join());
});

test("independence.modelNot is checked statically", () => {
  const v = check((d) => { ((d["roles"] as Record<string, Record<string, unknown>>)["critic"] as Record<string, unknown>)["model"] = "sonnet"; });
  assert.deepEqual(paths(v.issues), ["roles.critic.model"]);
  assert.match(errors(v.issues)[0]?.message ?? "", /independence violated/);
  const unknownRole = check((d) => { (((d["roles"] as Record<string, Record<string, unknown>>)["critic"] as Record<string, unknown>)["independence"] as Record<string, unknown>)["modelNot"] = ["ghost"]; });
  assert.deepEqual(paths(unknownRole.issues), ["roles.critic.independence.modelNot"]);
});

test("check.run placeholders: {node.key} → {key}, {config.*} substituted, anything else refused", () => {
  const steps = (d: Record<string, unknown>) => (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
  const ok = check((d) => { steps(d)[1]!["run"] = ['em validate {config.model} --slice-ready {node.key} --json "quoted arg"']; });
  assert.deepEqual(errors(ok.issues), []);
  const run = (ok.spec?.pipeline.steps[1] as { run: string[][] }).run;
  assert.deepEqual(run, [["em", "validate", "m.em", "--slice-ready", "{key}", "--json", "quoted arg"]]);
  const bad = check((d) => { steps(d)[1]!["run"] = ["em coverage {model} --tests {constitution.testDir}"]; });
  assert.deepEqual(paths(bad.issues), ["pipeline.steps[1].run[0]", "pipeline.steps[1].run[0]"]);
  const missing = check((d) => { steps(d)[1]!["run"] = ["em x {config.nope}"]; });
  assert.match(errors(missing.issues)[0]?.message ?? "", /does not resolve to a scalar/);
  const unbalanced = check((d) => { steps(d)[1]!["run"] = ['echo "oops']; });
  assert.deepEqual(paths(unbalanced.issues), ["pipeline.steps[1].run[0]"]);
});

test("policy: only implemented authority values; totals warn but do not block", () => {
  const v = check((d) => { d["policy"] = { mergeAuthority: "controller", exceptionRouting: "orchestrator" }; });
  assert.deepEqual(paths(v.issues), ["policy.mergeAuthority", "policy.exceptionRouting"]);
  const t = check((d) => { d["policy"] = { budgets: { total: { usd: 600 }, perNode: { usd: 15 } } }; });
  assert.ok(t.ok);
  assert.deepEqual(errors(t.issues), []);
  assert.equal(t.issues[0]?.severity, "warning");
  assert.equal(t.issues[0]?.path, "policy.budgets.total");
  assert.equal(t.spec?.budgets?.perNodeUsd, 15);
});

test("scheduling accepts only the implemented semantics", () => {
  const v = check((d) => { d["scheduling"] = { dispatchWhen: "levelComplete", levels: "barrier", maxConcurrent: 0 }; });
  assert.deepEqual(paths(v.issues), ["scheduling.dispatchWhen", "scheduling.levels", "scheduling.maxConcurrent"]);
});

test("human gates need an observer and a harvested candidate ref; {pr.url} maps to pr", () => {
  const steps = (d: Record<string, unknown>) => (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
  const noObs = check((d) => { steps(d)[2]!["acceptance"] = { candidateRef: "pr", verdicts: ["merged"] }; });
  assert.deepEqual(paths(noObs.issues), ["pipeline.steps[2].acceptance.observer"]);
  const docStyle = check((d) => { steps(d)[2]!["acceptance"] = { observer: "gh-merged", candidate: "{pr.url}", verdicts: ["merged"] }; });
  assert.deepEqual(errors(docStyle.issues), []);
  assert.equal((docStyle.spec?.pipeline.steps[2] as { acceptance: { candidateRef: string } }).acceptance.candidateRef, "pr");
});

test("judge steps are advisory only", () => {
  const v = check((d) => {
    const steps = (d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[];
    steps.splice(2, 0, { id: "judge", kind: "judge", rubrics: ["q"], advisory: false, on: { done: "gate" } });
    (steps[1]!["on"] as Record<string, string>)["done"] = "judge";
  });
  assert.deepEqual(paths(v.issues), ["pipeline.steps[2].advisory"]);
});

test("roles must be declared under adapters when an adapters block exists", () => {
  const v = check((d) => { d["adapters"] = { "claude-cloud": {} }; });
  assert.deepEqual(paths(v.issues), ["roles.implementer.adapter", "roles.critic.adapter"]);
});

test("a missing contract file is a warning, not an error", () => {
  const v = check((d) => {
    (((d["pipeline"] as Record<string, unknown>)["steps"] as Record<string, unknown>[])[0] as Record<string, unknown>)["contract"] = "roles/nope.md";
  });
  assert.ok(v.ok);
  assert.equal(v.issues[0]?.severity, "warning");
  assert.equal(v.issues[0]?.path, "pipeline.steps[0].contract");
});

test("YAML syntax errors come back as one issue, nothing validated", () => {
  const v = validateSpecText("pipeline: [unclosed", { baseDir: repoRoot });
  assert.equal(v.ok, false);
  assert.equal(v.issues.length, 1);
  assert.match(v.issues[0]?.message ?? "", /YAML parse error/);
});

test("loadSpecFile throws a SpecValidationError that lists every issue", async () => {
  await assert.rejects(loadSpecFile(join(repoRoot, "examples", "does-not-exist.yaml")), (e: unknown) => {
    assert.ok(e instanceof SpecValidationError);
    assert.equal(e.issues.length, 1);
    return true;
  });
});

test("helpers: durations and argv splitting", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration(1500), 1500);
  assert.equal(parseDuration("soon"), null);
  assert.deepEqual(splitArgv(`a "b c" d\\ e 'f"g'`), ["a", "b c", "d e", 'f"g']);
  assert.equal(splitArgv(`a "b`), null);
  assert.deepEqual(splitArgv("   "), []);
});
