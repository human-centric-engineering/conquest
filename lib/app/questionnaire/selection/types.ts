/**
 * Selection-strategy contract and tuning constants (F4.1).
 *
 * The conversational engine asks one question at a time. A *selection strategy*
 * answers "which question next?" given the questionnaire's slots, what's been
 * answered so far, and the version's config. The four strategies
 * (`sequential | random | weighted | adaptive`, see `SELECTION_STRATEGIES` in
 * `../types`) are pluggable: each registers under its slug and the engine looks
 * one up by the version's `selectionStrategy` config.
 *
 * **Pure by design.** Session/turn/answer tables don't exist yet (they land in
 * F4.6/P6). So a strategy never touches Prisma — it reads an in-memory
 * {@link SelectionContext} that a caller assembles (a Vitest harness today, the
 * streaming engine later). That keeps every per-turn behaviour exhaustively
 * unit-testable by hand, which is the P4 definition of done.
 *
 * The one impure strategy, `adaptive`, embeds text and calls an LLM. It does so
 * through injected {@link StrategyDeps} rather than importing Prisma/LLM modules,
 * so this module stays Prisma-free and the adaptive logic stays mockable. The
 * three deterministic strategies ignore `deps` entirely.
 */

import type {
  QuestionType,
  QuestionnaireConfigShape,
  SelectionStrategy,
} from '@/lib/app/questionnaire/types';

/**
 * A question slot projected into the minimal shape a strategy reads. The caller
 * maps `AppQuestionSlot` (+ its section + tag links) into this — strategies see
 * no Prisma rows.
 */
export interface QuestionView {
  /** `AppQuestionSlot.id`. */
  id: string;
  /** Stable slug, unique per version — how callers address a question. */
  key: string;
  /** `AppQuestionnaireSection.id` the slot belongs to. */
  sectionId: string;
  /** The section's ordinal — primary sort key for deterministic ordering. */
  sectionOrdinal: number;
  /** The slot's ordinal within its section — secondary sort key. */
  ordinal: number;
  /** Admin-set importance (schema default 1.0); the `weighted` scorer's base. */
  weight: number;
  /** Whether an answer is mandatory — required slots are asked before optional. */
  required: boolean;
  /** Question type; carried for future heuristics (e.g. variety), not yet scored. */
  type: QuestionType;
  /**
   * `AppQuestionTag` ids assigned to this slot (F2.2). Plumbed into the context for a
   * future tag-aware strategy, but currently read by NO selection strategy — tags only
   * drive analytics/export filtering. (Per-question `weight`, not tags, steers selection.)
   */
  tagIds: string[];
  /**
   * The question prompt text. Optional because only `adaptive` needs it (to give
   * the LLM something to judge flow against); the deterministic strategies work
   * off ordinal/weight/required alone, so a caller may omit it for them.
   */
  prompt?: string;
  /**
   * Admin/extractor guidance on what a good answer looks like. Optional and read
   * only by `adaptive` — handed to the selector LLM so it judges flow on intent,
   * not just the prompt wording. `null`/absent when the slot has none.
   */
  guidelines?: string | null;
  /**
   * Why this question exists (the extractor's editorial note). Optional and read
   * only by `adaptive`, for the same reason as {@link guidelines}.
   */
  rationale?: string | null;
}

/**
 * One answer already captured this session. Strategies read which question was
 * answered (to exclude it) and the extraction confidence (the `weighted` scorer
 * boosts sections holding a low-confidence answer so they get revisited).
 */
export interface AnsweredView {
  /** `QuestionView.id` that was answered. */
  questionId: string;
  /** Extraction confidence 0–1, or `null` when not scored. */
  confidence: number | null;
}

/**
 * Everything a strategy reads to make one selection — entirely in-memory.
 */
export interface SelectionContext {
  /** Every question slot in the version. */
  questions: QuestionView[];
  /** Answers captured so far this session. */
  answered: AnsweredView[];
  /** The version's resolved config (defaults when no row was ever saved). */
  config: QuestionnaireConfigShape;
  /**
   * Zero-based selection round — the number of prior picks. Seeds `random` so a
   * crash-replay of the same round re-picks the same question, and is available
   * for cap arithmetic.
   */
  round: number;
  /** Stable session identity — the other half of `random`'s deterministic seed. */
  sessionId: string;
  /**
   * Recent user messages, oldest → newest. Only `adaptive` reads these (to embed
   * the latest one); the harness/engine supplies them. Absent/empty makes
   * `adaptive` fall back to `weighted`.
   */
  recentMessages?: string[];
  /**
   * The questionnaire's goal (version-level). Optional and read only by `adaptive` —
   * given to the selector LLM as framing so it picks the question that best advances
   * the goal, not just the one nearest the last message. `null`/absent when unset.
   */
  goal?: string | null;
  /**
   * Learning Mode (adaptive probing): per-question-**key** peer divergence (0–1) from the round's
   * digest — how much EARLIER respondents split on that topic. Read only by `adaptive`, which hands
   * it to the selector LLM so it can lean toward probing high-divergence topics harder. Absent unless
   * Learning Mode is active for the session's round. Other strategies ignore it (phrasing-only there).
   */
  peerDivergenceByKey?: Record<string, number>;
}

/**
 * The outcome of one selection.
 *
 * - `ask` — ask `questionId` next. `costUsd` is any spend incurred choosing it
 *   (0 for the deterministic strategies; >0 only when `adaptive` calls the LLM).
 * - `complete` — the terminal condition is met (cap hit, or coverage + min
 *   answered satisfied). F4.1 only *computes* this; the offer-to-submit flow is
 *   F4.5. The engine decides what to do with it.
 * - `none` — nothing left to ask, but the completion thresholds are *not* met
 *   (e.g. `minQuestionsAnswered` exceeds the question count). Surfaced for the
 *   engine to resolve; distinct from a clean `complete`.
 */
export type SelectionDecision =
  | { kind: 'ask'; questionId: string; rationale: string; costUsd: number }
  | { kind: 'complete'; rationale: string }
  | { kind: 'none'; rationale: string };

/**
 * Injected side-effect surface for the `adaptive` strategy (wired at the route /
 * engine seam in PR3). Kept off the deterministic strategies, which never read
 * it. Defined here so the {@link SelectionStrategyPlugin} signature is stable
 * before adaptive's real implementation lands — "seam now, consumer later".
 */
export interface StrategyDeps {
  /** Embed a text into a vector (e.g. the knowledge module's `embedText`). */
  embedText(text: string): Promise<number[]>;
  /**
   * Rank `candidateQuestionIds` by vector similarity to `embedding`, returning at
   * most `k` question ids best-first. Backed by a pgvector query over slot
   * embeddings.
   */
  rankByVector(embedding: number[], candidateQuestionIds: string[], k: number): Promise<string[]>;
  /**
   * Ask the LLM which candidate flows most naturally given recent messages.
   * Returns the chosen question id (or `null` to defer to the fallback), a
   * rationale, and the USD spent.
   */
  llmPick(input: LlmPickInput): Promise<LlmPickResult>;
}

/** Input to {@link StrategyDeps.llmPick}. */
export interface LlmPickInput {
  /** Recent user messages, oldest → newest. */
  recentMessages: string[];
  /**
   * Candidate questions to choose among (already similarity-ranked). Each carries
   * optional `guidelines`/`rationale` so the selector judges intent, not just the
   * prompt wording.
   */
  candidates: Array<{
    id: string;
    key: string;
    prompt?: string;
    guidelines?: string | null;
    rationale?: string | null;
    /**
     * Learning Mode peer divergence (0–1) for this candidate's topic — how much earlier respondents
     * split on it. Present only when Learning Mode is active; the selector leans toward higher values
     * (richer follow-up territory) without letting it override conversational flow.
     */
    peerDivergence?: number;
    /**
     * True when this candidate sits in a section that already holds a low-confidence answer (a
     * terse, vague, or tangentially-inferred capture — confidence ≤ {@link LOW_CONFIDENCE_THRESHOLD}).
     * The selector leans toward such a candidate to DEEPEN shaky ground, framing it as a genuine
     * follow-up. Absent (omitted) when the section is confidently covered.
     */
    sectionLowConfidence?: boolean;
  }>;
  /** The questionnaire's goal (version-level), for framing. Absent when unset. */
  goal?: string | null;
  /**
   * Prompts of questions already answered this session, oldest → newest — so the
   * selector knows what's been covered and avoids re-treading it.
   */
  answeredQuestions?: string[];
  /** Session id, threaded into cost-log metadata. */
  sessionId: string;
}

/** Result of {@link StrategyDeps.llmPick}. */
export interface LlmPickResult {
  /** Chosen question id, or `null` to fall back to the deterministic scorer. */
  questionId: string | null;
  /** Why this candidate was chosen (or why none was). */
  rationale: string;
  /** USD spent on the embedding + completion. */
  costUsd: number;
}

/**
 * A pluggable next-question selector, keyed on its {@link SelectionStrategy}
 * slug. Modelled on the grader plugin (`lib/orchestration/evaluations/graders`):
 * a small object that self-registers at module load. Strategies carry no config
 * schema of their own — they read the questionnaire's `QuestionnaireConfigShape`.
 */
export interface SelectionStrategyPlugin {
  /** The slug this strategy registers under (matches a `SELECTION_STRATEGIES` value). */
  slug: SelectionStrategy;
  /** One-line description for operator-facing surfaces. */
  description: string;
  /**
   * Choose the next question. Async so `adaptive` can await I/O while the
   * deterministic strategies resolve immediately. `deps` is supplied only when a
   * caller has wired the impure surface; deterministic strategies ignore it and
   * `adaptive` falls back to `weighted` without it.
   */
  select(ctx: SelectionContext, deps?: StrategyDeps): Promise<SelectionDecision>;
}

// ── Weighted-scorer tuning constants ────────────────────────────────────────
// Module constants, not config fields — they tune the heuristic the same way the
// cost-estimation module keeps its token constants in code (F3.3). Adjust here;
// no migration. Adding them to `AppQuestionnaireConfig` is a future PR if admins
// ever need per-questionnaire control.

/**
 * How strongly an under-covered section is favoured. A section's
 * inverse-completion (1 − answered/total) scales this; the product is added to
 * the multiplier base of 1. At 0.5, a wholly untouched section's questions score
 * 1.5× their weight versus a fully-answered-bar-one section.
 */
export const UNDERCOVERED_SECTION_BONUS = 0.5;

/**
 * Multiplier applied to a question whose section already holds a low-confidence
 * answer — pulls the conversation back to shore up shaky ground.
 */
export const LOW_CONFIDENCE_MULT = 1.5;

/**
 * Confidence at or below which an answer counts as "low" for the bonus above.
 * Answers with `confidence === null` (unscored) never trip it.
 *
 * Set at 0.6 (not 0.5) to align with the finer extraction rubric (0.3–1.0 by
 * directness × elaboration × certainty): a terse/vague answer now lands ~0.45–0.6,
 * and that is exactly the "shaky ground worth revisiting" this bonus targets. A
 * clear, direct answer (≥0.75) sits safely above it and does not trip a pull-back.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
