/**
 * Grader registry — shared types.
 *
 * A **grader** is a small unit that takes the output of a subject
 * (an agent's chat response or a workflow's selected step output)
 * and returns a score plus optional reasoning. Graders are pluggable
 * via the registry in `./registry.ts`; each one ships as a small
 * module that calls `registerGrader(...)` at import time.
 *
 * Three families, deliberately split into separate input/output shapes
 * so the registry stays strongly typed and the worker's dispatch path
 * is unambiguous:
 *
 *  - **heuristic**: deterministic code-based checks (exact_match, regex,
 *    json_schema, …). No LLM call. Cheap, runs on every case.
 *  - **model**: LLM-as-judge graders (faithfulness, custom_rubric, …).
 *    One LLM call per case. Reasoning string is stored for the UI.
 *  - **pairwise**: compare *two* subject outputs side-by-side. Used by
 *    the experiment compare view in Phase 3 (declared here so the
 *    registry shape doesn't need a breaking change later).
 *
 * Platform-agnostic — no Next.js, no DB, no provider SDKs at this
 * layer.
 */

import type { ZodSchema } from 'zod';
import type { Citation } from '@/types/orchestration';
import type { getProvider } from '@/lib/orchestration/llm/provider-manager';

type LlmProvider = Awaited<ReturnType<typeof getProvider>>;

/** Provider/model pair the worker resolves once per run and reuses per case. */
export interface JudgeBinding {
  provider: LlmProvider;
  /** Slug used for cost logging — kept alongside the live provider handle. */
  providerSlug: string;
  model: string;
}

/** Family of grader — drives the registry's dispatch type. */
export type GraderFamily = 'heuristic' | 'model' | 'pairwise';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * What a single-output grader sees for one case. Both heuristic and
 * model graders accept this shape; the worker fills the same struct
 * for every grader configured on the run.
 */
export interface GraderInput {
  /** The user's question (agent) or stringified workflow input. */
  userInput: string;
  /** The subject's output text — assistant turn, or workflow step output. */
  modelOutput: string;
  /** Optional reference. Required only by reference-dependent graders. */
  expectedOutput?: string;
  /** Citations the subject emitted, used by faithfulness / RAG graders. */
  citations?: Citation[];
  /** Tool/capability calls the subject made — used by trajectory graders. */
  toolCalls?: Array<{ slug: string; args?: Record<string, unknown> }>;
  /** Judge binding for model graders. Heuristic graders ignore this. */
  judge?: JudgeBinding;
  /** Validated grader-specific config (faithfulness has none; regex has `pattern`). */
  config: unknown;
  /** Optional cancellation signal — graders SHOULD honour this for long calls. */
  signal?: AbortSignal;
}

/** Two-output input for pairwise graders. */
export interface PairwiseGraderInput {
  userInput: string;
  outputA: string;
  outputB: string;
  expectedOutput?: string;
  judge?: JudgeBinding;
  config: unknown;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * One grader's verdict on one case. Stored on
 * `AiEvaluationCaseResult.metricScores[graderSlug]`.
 */
export interface GraderResult {
  /** 0..1 (or grader-defined scale, with `scaleMax` on the entry to interpret). */
  score: number | null;
  /** True/false derived from a threshold. Graders MAY set this for UI badges. */
  passed?: boolean;
  /** Free-text reasoning. Optional — heuristic graders usually skip it. */
  reasoning?: string;
  /** Tokens consumed by a model grader. Heuristic graders skip. */
  tokenUsage?: { input: number; output: number };
  /** USD spent on this single grade call. */
  costUsd?: number;
}

/** Pairwise verdict: which output won and the reasoning. */
export interface PairwiseGraderResult {
  /** 'A' | 'B' | 'tie' — the winner from the judge's perspective. */
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

/**
 * Registry entry for a heuristic or model grader. Type-parameterised
 * on the config shape so graders can declare a typed `grade` function
 * without resorting to `as` casts at the dispatch site.
 */
export interface Grader<TConfig = unknown> {
  slug: string;
  family: 'heuristic' | 'model';
  /**
   * Does this grader need `expectedOutput` on the dataset case?
   * The worker pre-flights the dataset against the run's grader list
   * and refuses to start if any reference-dependent grader is paired
   * with a dataset case that has no `expectedOutput`.
   */
  referenceRequired: boolean;
  /** Zod schema validating per-run grader config (e.g. regex `pattern`). */
  configSchema: ZodSchema<TConfig>;
  /**
   * Optional default config. When set, the run-creation UI can use this
   * as the starting form state and the API can fall back to it when the
   * caller submits an empty `config` object.
   */
  defaultConfig?: TConfig;
  /** Score the case. Throws only for transient infra errors. */
  grade: (input: GraderInput & { config: TConfig }) => Promise<GraderResult>;
  /**
   * One-line human-readable description shown in the run-creation UI
   * next to the slug. Tone: plain English, no AI flourishes, what it
   * does and when to use it.
   */
  description: string;
}

/** Registry entry for a pairwise grader. */
export interface PairwiseGrader<TConfig = unknown> {
  slug: string;
  family: 'pairwise';
  configSchema: ZodSchema<TConfig>;
  defaultConfig?: TConfig;
  grade: (input: PairwiseGraderInput & { config: TConfig }) => Promise<PairwiseGraderResult>;
  description: string;
}

/**
 * Discriminated union of every registered entry. Uses `any` for TConfig
 * because the per-grader `grade(...)` signature is contravariant in
 * config — a typed grader like `Grader<{ trim: boolean }>` cannot
 * structurally satisfy `Grader<unknown>` without it. The runtime
 * trade-off is benign: the worker calls `configSchema.parse(rawConfig)`
 * once per run before invoking any grader, so by the time we reach the
 * grade function the config is already runtime-validated and typed
 * locally inside the grader module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGrader = Grader<any> | PairwiseGrader<any>;
