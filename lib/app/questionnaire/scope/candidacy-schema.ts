/**
 * Ingestion-time Conditional Topics candidacy check's structured-output contract (P17.19).
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

/**
 * Clip an over-long string to its cap instead of rejecting it.
 *
 * These caps exist to bound what is stored and shown, not to judge the answer. A `.max()` that
 * REJECTS turns "a good verdict with a twenty-character-too-long quote" into no verdict at all —
 * and because candidacy is fail-soft, the whole Conditional Topics chain then vanishes silently.
 * Measured on the routing corpus: every model tested overflowed one cap or another (the small ones
 * a long `sourceQuote`, `gpt-5.4` the eight-signal array), and doc 05 failed 3/3 on every one of
 * them. That is a deterministic loss of the feature, caused by a limit the model was never told
 * about — see {@link buildScopeCandidacyPrompt}, which now states all three.
 *
 * Clipping is safe here in a way it would not be for the analyst: a `sourceQuote` is corroborating
 * evidence an admin skims, not a span anything is matched against.
 */
const clippedString = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .pipe(z.string());

const candidacySignalSchema = z.object({
  /** One short reason this signal counts, in the check's own words. Clipped, never rejected. */
  note: clippedString(SIGNAL_NOTE_MAX_LENGTH).pipe(z.string().min(1)),
  /**
   * The exact span that said so. Absent when the note is an inference rather than a quote.
   *
   * An explicit `null` is accepted as "absent". The prompt says to OMIT the key, but models
   * routinely spell the same thing as `"sourceQuote": null` — and a plain `.optional()` rejects
   * that, taking the whole verdict (and with it the Conditional Topics chain) down over a JSON
   * idiom. Normalised to `undefined` so consumers keep one shape for "no quote".
   */
  sourceQuote: clippedString(SOURCE_QUOTE_MAX_LENGTH)
    .nullish()
    .transform((value) => value ?? undefined),
});
export type CandidacySignal = z.infer<typeof candidacySignalSchema>;

export const scopeCandidacySchema = z.object({
  /** True only when the document's own words plausibly describe routing different respondents differently. */
  isCandidate: z.boolean(),
  confidence: z.number().min(0).max(1),
  /**
   * Trimmed to the cap rather than rejected, for the reason on {@link clippedString}: `gpt-5.4`
   * reliably returns nine or ten signals on a richly-signposted document, and throwing the verdict
   * away over the ninth is the worst possible trade.
   *
   * **The slice happens BEFORE the items are validated, and the order is the whole point.**
   * Validating first and slicing after — the obvious spelling — checks all ten signals and then
   * discards two, so a malformed NINTH signal still rejects the entire verdict. That is exactly
   * the over-cap output this is here to tolerate, so the obvious spelling leaves the original
   * failure reachable while looking like it fixed it.
   */
  signals: z
    .array(z.unknown())
    .transform((items) => items.slice(0, MAX_CANDIDACY_SIGNALS))
    .pipe(z.array(candidacySignalSchema))
    .default([]),
  /** One or two sentences: what was found, or why nothing was. */
  summary: clippedString(SUMMARY_MAX_LENGTH).pipe(z.string().min(1)),
});
export type ScopeCandidacyResult = z.infer<typeof scopeCandidacySchema>;

/**
 * The same contract WITHOUT the leniency — bounds declared, nothing clipped.
 *
 * Two schemas, deliberately, because the two directions want opposite postures. What we send the
 * provider should be as tight as possible (it is what constrains generation); what we accept back
 * should be as forgiving as it can be without losing meaning, because a rejected reply costs the
 * whole feature. `z.toJSONSchema` cannot serialise a `.transform()` — fed the lenient schema it
 * silently emitted `"signals": { "default": [] }`, dropping the item shape at precisely the field
 * where the malformed output was observed, which would have made wiring the schema pointless.
 *
 * Kept honest by `candidacy-schema.test.ts`, which asserts the serialised shape still exposes the
 * signal item's properties and that both schemas accept the same well-formed verdict. Exported for
 * exactly that second test: the two can only be checked for drift from outside if both are
 * reachable, and drift between them is the failure this split creates.
 */
export const candidacyWireSchema = z.object({
  isCandidate: z.boolean(),
  confidence: z.number().min(0).max(1),
  signals: z
    .array(
      z.object({
        note: z.string().min(1).max(SIGNAL_NOTE_MAX_LENGTH),
        sourceQuote: z.string().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
      })
    )
    .max(MAX_CANDIDACY_SIGNALS),
  summary: z.string().min(1).max(SUMMARY_MAX_LENGTH),
});

/**
 * JSON-schema serialisation for a provider structured-output request.
 *
 * Forwarded by `detect-scope-candidacy.ts` as `responseSchema` on both the first attempt and the
 * temp-0 retry. Before it was wired, the cheapest model in the stack was hand-writing this JSON
 * from prose alone and getting it wrong on roughly one call in six.
 */
export const scopeCandidacyJsonSchema: Record<string, unknown> = z.toJSONSchema(
  candidacyWireSchema,
  { unrepresentable: 'any' }
);

/** The caps the prompt states to the model, so it is never held to a limit it was not told. */
export const CANDIDACY_LIMITS = {
  maxSignals: MAX_CANDIDACY_SIGNALS,
  noteChars: SIGNAL_NOTE_MAX_LENGTH,
  sourceQuoteChars: SOURCE_QUOTE_MAX_LENGTH,
  summaryChars: SUMMARY_MAX_LENGTH,
} as const;

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
