/**
 * Ingestion-time Adaptive Scope candidacy check's structured-output contract (P17.19).
 *
 * A cheap, fast triage — NOT the Routing Analyst (`analysis-schema.ts`). Its only job is to decide
 * whether a freshly-uploaded document's OWN WORDS describe conditional routing at all: eligibility
 * notes, routing or guardrail guidance, facilitator instructions naming who answers what. It never
 * proposes topics or rules — that stays the analyst's job, run automatically when this check fires.
 *
 * Same quote-or-absent grounding discipline as the analyst: a signal without a quote is a weaker
 * claim, and the check must not invent one.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

/** Signals are notes for an admin skimming why the check fired — a handful is plenty. */
const MAX_CANDIDACY_SIGNALS = 8;
const SIGNAL_NOTE_MAX_LENGTH = 300;
const SOURCE_QUOTE_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 500;

const candidacySignalSchema = z.object({
  /** One short reason this signal counts, in the check's own words. */
  note: z.string().trim().min(1).max(SIGNAL_NOTE_MAX_LENGTH),
  /** The exact span that said so. Absent when the note is an inference rather than a quote. */
  sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
});
export type CandidacySignal = z.infer<typeof candidacySignalSchema>;

export const scopeCandidacySchema = z.object({
  /** True only when the document's own words plausibly describe routing different respondents differently. */
  isCandidate: z.boolean(),
  confidence: z.number().min(0).max(1),
  signals: z.array(candidacySignalSchema).max(MAX_CANDIDACY_SIGNALS).default([]),
  /** One or two sentences: what was found, or why nothing was. */
  summary: z.string().trim().min(1).max(SUMMARY_MAX_LENGTH),
});
export type ScopeCandidacyResult = z.infer<typeof scopeCandidacySchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const scopeCandidacyJsonSchema: Record<string, unknown> = z.toJSONSchema(
  scopeCandidacySchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type ScopeCandidacyValidation =
  { ok: true; value: ScopeCandidacyResult } | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link scopeCandidacySchema}. */
export function validateScopeCandidacy(parsed: unknown): ScopeCandidacyValidation {
  const result = scopeCandidacySchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * The trimmed verdict threaded through the ingest response/stream and cached on the version.
 * Deliberately smaller than {@link ScopeCandidacyResult}: `signals` (which may carry document
 * quotes) stays server-side on the `AppAiRun` snapshot for now — a future Topics-tab surface can
 * read the full result when it needs to show them.
 */
export interface ScopeCandidacyVerdict {
  isCandidate: boolean;
  confidence: number;
  summary: string;
}
