/**
 * Typed-judge contract — L2 tier 2, between deterministic checks and LLM
 * review. Advisory by construction: a verdict ANNOTATES evidence; nothing in
 * the controller routes on it, and it can never unblock a failed check.
 *
 * This is deliberately the thin end of the em-judge design (vault:
 * jev-for-em.md, Foundation section): rubrics are versioned data, extractors
 * and caching are the runner's job, verdicts are cached by
 * (stateHash, rubricVersion, judgeModelVersion) and committed.
 */

export interface RubricRef {
  id: string; // e.g. "slice-doc-quality"
  version: number;
}

export interface TypedVerdict {
  rubric: RubricRef;
  /** "noul" -> boolean-ish, "choice" -> option, "score" -> level. */
  answer: string;
  probability?: number;
  judgeModelVersion: string;
  stateHash: string;
  cached: boolean;
}

export interface Judge {
  id: string; // "em-judge" | "llm-rubric" (no-key fallback)
  judge(rubric: RubricRef, state: string): Promise<TypedVerdict>;
}
