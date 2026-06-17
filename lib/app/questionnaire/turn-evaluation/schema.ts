/**
 * The turn-evaluator's structured-output contract.
 *
 * A **hybrid** shape: the headline numbers and ratings are typed/enum'd (so they can be
 * rendered as chips and, later, tracked/trended), while each prose section is a bounded
 * markdown string (robust to validate — the model can't fail validation on the wording of
 * a paragraph, only on a malformed score). Validated deterministically with Zod the same
 * way the design-evaluation judge is (`validate → tryParseJson → retry-once-at-temp-0`),
 * so a parse failure yields the field paths that were wrong.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

/** Coarse effectiveness band, mirroring the 0–100 score. */
export const TURN_EFFECTIVENESS = ['Excellent', 'Good', 'Mixed', 'Weak', 'Poor'] as const;
export type TurnEffectiveness = (typeof TURN_EFFECTIVENESS)[number];

/** Was the extractor's stated confidence appropriate to the evidence? */
export const CONFIDENCE_QUALITY = ['too high', 'too low', 'reasonable'] as const;
export type ConfidenceQuality = (typeof CONFIDENCE_QUALITY)[number];

/** How much new information the turn gained. */
export const INFO_GAIN_RATING = ['High', 'Medium', 'Low'] as const;
export type InfoGainRating = (typeof INFO_GAIN_RATING)[number];

/** How far the generation calls drifted from their instructions. */
export const PROMPT_DRIFT_RATING = ['None', 'Minor', 'Moderate', 'Significant'] as const;
export type PromptDriftRating = (typeof PROMPT_DRIFT_RATING)[number];

/** Whether the call count / spend was justified by the value produced. */
export const EFFICIENCY_RATING = ['Excellent', 'Good', 'Mixed', 'Poor'] as const;
export type EfficiencyRating = (typeof EFFICIENCY_RATING)[number];

/**
 * Upper bound on the per-call array. A turn fires a handful of calls; this caps a runaway
 * response (and a malicious/garbled dump) without constraining any real turn.
 */
export const MAX_EVALUATED_CALLS = 40;

/** Field-length caps — generous for real analysis, bounded against a runaway response. */
const MD_MAX = 4_000;
const SHORT_MD_MAX = 2_000;
const LABEL_MAX = 200;
const LIST_ITEM_MAX = 1_000;
const MAX_LIST_ITEMS = 30;

/** A bounded markdown prose field. */
const md = z.string().max(MD_MAX);
/** A shorter bounded markdown prose field for tighter sections. */
const shortMd = z.string().max(SHORT_MD_MAX);
/** A bounded list of short strings (violations, evidence, strengths…). */
const stringList = z.array(z.string().max(LIST_ITEM_MAX)).max(MAX_LIST_ITEMS);
/** A 0–100 score. */
const score100 = z.number().min(0).max(100);
/** A 1–10 sub-score. */
const score10 = z.number().min(1).max(10);

/** One call's evaluation — one entry per call present in the dump. */
export const callEvaluationSchema = z.object({
  /** The call's label, echoed from the dump (e.g. "Answer extraction"). */
  name: z.string().min(1).max(LABEL_MAX),
  /** What the call is for, in the evaluator's words. */
  purpose: z.string().max(LABEL_MAX),
  score: score100,
  /** Instruction compliance: what was followed, what was violated, format/scope/alignment. */
  instructionCompliance: md,
  /** Output quality: correctness, usefulness, robustness, clarity. */
  outputQuality: md,
  /** Risks: hallucination, over-inference, under-extraction, prompt drift, brittleness. */
  risks: shortMd,
  /** Specific improvement recommendations. */
  improvements: shortMd,
});
export type CallEvaluation = z.infer<typeof callEvaluationSchema>;

/** Interviewer question-quality sub-scores (1–10) plus prompt-compliance violations. */
export const interviewerEvaluationSchema = z.object({
  openEndedness: score10,
  singleTopicFocus: score10,
  nonLeading: score10,
  conversational: score10,
  cognitiveLoad: score10,
  specificity: score10,
  warmth: score10,
  stageAlignment: score10,
  /** Concrete prompt-compliance violations (bundled questions, persona breaks, …). */
  violations: stringList,
});

/** Extraction-quality evaluation. */
export const extractionEvaluationSchema = z.object({
  score: score100,
  confidenceQuality: z.enum(CONFIDENCE_QUALITY),
  /** What information from the answer was successfully captured. */
  coverage: md,
  /** Meaningful information that was not extracted. */
  missedSignals: shortMd,
  /** Inferences not adequately supported by the respondent's words. */
  overreach: shortMd,
});

/** Question-selection evaluation. */
export const questionSelectionEvaluationSchema = z.object({
  score: score100,
  /** Did it build naturally on what the respondent said? */
  relevance: shortMd,
  /** Did it maximise questionnaire coverage? */
  coverageStrategy: shortMd,
  /** Was this the right moment to ask it? */
  timing: shortMd,
  /** Potentially stronger next questions. */
  alternatives: shortMd,
});

/** What was learned this turn. */
export const informationGainSchema = z.object({
  rating: z.enum(INFO_GAIN_RATING),
  /** New slots filled, slots strengthened, high-value insights, novel vs redundant info. */
  analysis: md,
});

/** Drift of the generation calls from their instructions (a single top-level rollup). */
export const promptDriftSchema = z.object({
  rating: z.enum(PROMPT_DRIFT_RATING),
  evidence: stringList,
});

/** Cost & efficiency evaluation. */
export const efficiencySchema = z.object({
  rating: z.enum(EFFICIENCY_RATING),
  /** Were the calls justified? Any redundant? Could fewer calls have produced equal value? */
  analysis: shortMd,
});

/** The closing summary. */
export const turnSummarySchema = z.object({
  strengths: stringList,
  weaknesses: stringList,
  biggestRisk: z.string().max(LIST_ITEM_MAX),
  biggestOpportunity: z.string().max(LIST_ITEM_MAX),
  recommendedAction: z.string().max(LIST_ITEM_MAX),
});

/** The full turn-evaluation verdict. */
export const turnEvaluationSchema = z.object({
  overallScore: score100,
  effectiveness: z.enum(TURN_EFFECTIVENESS),
  calls: z.array(callEvaluationSchema).max(MAX_EVALUATED_CALLS),
  interviewer: interviewerEvaluationSchema,
  extraction: extractionEvaluationSchema,
  questionSelection: questionSelectionEvaluationSchema,
  informationGain: informationGainSchema,
  /** Anything meaningful surfaced but not explored (markdown). */
  missedOpportunities: md,
  promptDrift: promptDriftSchema,
  efficiency: efficiencySchema,
  summary: turnSummarySchema,
});

/** The validated verdict. */
export type TurnEvaluation = z.infer<typeof turnEvaluationSchema>;

/**
 * JSON-schema serialisation of {@link turnEvaluationSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 */
export const turnEvaluationJsonSchema: Record<string, unknown> = z.toJSONSchema(
  turnEvaluationSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type TurnEvaluationValidation =
  | { ok: true; value: TurnEvaluation }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link turnEvaluationSchema}. Returns the
 * typed value or the flat `issues` list (field path + message) — the service feeds those
 * into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateTurnEvaluation(p).ok ? … : null)`.
 */
export function validateTurnEvaluation(parsed: unknown): TurnEvaluationValidation {
  const result = turnEvaluationSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * The user message sent on the structured-completion retry. Lists the field paths that
 * failed (when known) so the model repairs the specific fields rather than re-guessing the
 * whole shape. Never includes the malformed prior response (the `runStructuredCompletion`
 * discipline).
 */
export function buildTurnEvaluatorRetryMessage(issuePaths: string[]): string {
  const base =
    'Your previous response did not match the required JSON schema. Return ONLY a single JSON ' +
    'object with EXACTLY these top-level keys and no others: overallScore, effectiveness, calls, ' +
    'interviewer, extraction, questionSelection, informationGain, missedOpportunities, ' +
    'promptDrift, efficiency, summary. Use the exact field names and shape shown earlier — no ' +
    'wrapper object, no prose, no code fence. Scores are numbers (overall and per-call 0–100; ' +
    'interviewer sub-scores 1–10); ratings use the exact allowed strings.';
  if (issuePaths.length === 0) return base;
  return `${base} The invalid fields were: ${issuePaths.join(', ')}.`;
}
