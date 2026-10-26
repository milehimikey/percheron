/**
 * GitMergedObserver — the simplest real AcceptanceObserver: the gate's
 * candidate is a branch name, and the observed fact is "that branch's tip is
 * an ancestor of the base" (i.e. it was merged). Locally that is a human
 * running `git merge`; on a forge the sibling gh-pr-merged observer would ask
 * the API — same contract, same wake semantics.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AcceptanceObserver, AcceptanceSpec } from "../contracts/ledger.js";
import type { Artifact } from "../contracts/core.js";

const execFileAsync = promisify(execFile);

export class GitMergedObserver implements AcceptanceObserver {
  readonly id = "git-merged";

  constructor(
    private readonly repoRoot: string,
    private readonly base = "main",
  ) {}

  async check(
    acceptance: AcceptanceSpec,
  ): Promise<{ satisfied: boolean; evidence: Artifact[] }> {
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", acceptance.candidate, this.base],
        { cwd: this.repoRoot },
      );
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", acceptance.candidate],
        { cwd: this.repoRoot },
      );
      const evidence: Artifact[] = [
        {
          kind: "report",
          ref: `git:${acceptance.candidate}@${stdout.trim()}`,
          summary: `branch ${acceptance.candidate} is an ancestor of ${this.base}`,
        },
      ];
      return { satisfied: true, evidence };
    } catch {
      return { satisfied: false, evidence: [] };
    }
  }
}
