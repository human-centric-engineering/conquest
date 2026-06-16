/**
 * Dedicated sensitivity detector — the structured LLM output contract (pure Zod).
 *
 * Mirrors the seriousness judge's schema: a minimal, tolerant verdict the invoker validates the
 * model's JSON against before acting on it. Unlike the extractor's optional `sensitivity` field
 * (which the model silently drops on busy turns — the same failure the `suspectedNonGenuine` hint
 * showed), this detector's ONLY job is the disclosure ruling, so it is far more reliable.
 *
 * The schema is deliberately permissive (`detected` plus optional fields) so a half-populated
 * "detected": true is NEVER discarded — {@link normalizeSensitivityVerdict} fills safe defaults
 * rather than dropping a possible safeguarding disclosure.
 */

import { z } from 'zod';

import { SENSITIVITY_SEVERITIES } from '@/lib/app/questionnaire/types';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';

/** Max length of the detector's careful, non-graphic one-line restatement. */
export const SENSITIVITY_SUMMARY_MAX = 300;
/** Max length of the short category label. */
export const SENSITIVITY_CATEGORY_MAX = 80;

/** Safe fallbacks used when the detector flags a disclosure but under-populates a field. We default
 *  rather than drop — a flagged disclosure must never be lost to a missing label. */
export const SENSITIVITY_DEFAULT_CATEGORY = 'safeguarding concern';
export const SENSITIVITY_DEFAULT_SUMMARY = 'The respondent disclosed something sensitive.';

export const sensitivityDetectVerdictSchema = z.object({
  /** `true` = the message carries a genuine sensitive/contentious disclosure. */
  detected: z.boolean(),
  /** Severity of the disclosure; required by the prompt when `detected`, but tolerated absent. */
  severity: z.enum(SENSITIVITY_SEVERITIES).optional(),
  /** Short category label, e.g. "workplace abuse", "self-harm". */
  category: z.string().max(SENSITIVITY_CATEGORY_MAX).optional(),
  /** A careful, NON-GRAPHIC one-line restatement — the only field that may carry disclosure content. */
  summary: z.string().max(SENSITIVITY_SUMMARY_MAX).optional(),
});

export type SensitivityDetectVerdictRaw = z.infer<typeof sensitivityDetectVerdictSchema>;

/** Validate parsed JSON against the verdict schema, returning the issues on failure. */
export function validateSensitivityDetectVerdict(
  parsed: unknown
): { ok: true; value: SensitivityDetectVerdictRaw } | { ok: false; issues: z.ZodIssue[] } {
  const result = sensitivityDetectVerdictSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * Turn a validated raw verdict into a {@link SensitivityAssessment} (or `null` when nothing was
 * detected). When the detector flagged a disclosure but omitted a field, we fill a safe default —
 * defaulting an absent severity to `high` (the cautious choice for safeguarding) — so a flagged
 * disclosure is never silently lost to an incomplete object.
 */
export function normalizeSensitivityVerdict(
  raw: SensitivityDetectVerdictRaw
): SensitivityAssessment | null {
  if (!raw.detected) return null;
  return {
    detected: true,
    severity: raw.severity ?? 'high',
    category: raw.category?.trim() || SENSITIVITY_DEFAULT_CATEGORY,
    summary: raw.summary?.trim() || SENSITIVITY_DEFAULT_SUMMARY,
  };
}
