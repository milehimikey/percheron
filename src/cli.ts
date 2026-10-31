#!/usr/bin/env node
/**
 * percheron CLI — v0.2 ships one command:
 *
 *   percheron validate <engagement.yaml> [--json]
 *
 * Static spec validation (spec-format "validation discipline"): ok/issues with
 * severity, exact field path and the fixing action. Exit 0 when ok (warnings
 * allowed), 1 on errors, 2 on usage. Never touches live tools or executors.
 */

import { formatIssues, validateSpecFile } from "./controller/spec-loader.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "validate" || rest.length === 0) {
    process.stderr.write("usage: percheron validate <engagement.yaml> [--json]\n");
    return 2;
  }
  const json = rest.includes("--json");
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    process.stderr.write("usage: percheron validate <engagement.yaml> [--json]\n");
    return 2;
  }
  const v = await validateSpecFile(file);
  if (json) {
    const { spec: _spec, ...report } = v;
    process.stdout.write(JSON.stringify({ file, ...report }, null, 2) + "\n");
  } else {
    const errors = v.issues.filter((i) => i.severity === "error").length;
    const warnings = v.issues.length - errors;
    process.stdout.write(
      `${v.ok ? "ok" : "FAILED"}: ${file} — ${errors} error(s), ${warnings} warning(s)` +
        (v.spec ? ` · ${v.spec.name} · ${v.spec.pipeline.steps.length} step(s), entry ${v.spec.pipeline.entry}` : "") +
        "\n" +
        (v.issues.length ? formatIssues(v.issues) + "\n" : ""),
    );
  }
  return v.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`percheron: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
