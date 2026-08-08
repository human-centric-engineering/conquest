/**
 * The Glossary Analyst's structured-output contract (P16).
 *
 * The analyst is a PROPOSER, not an author: it reads the questionnaire (and the admin's
 * authoritative definitions document when there is one) and returns terms it judges genuinely open
 * to interpretation, each with the readings it thinks this questionnaire actually intends. Nothing
 * it returns is live — every term lands as `proposed` for an admin to adjudicate.
 *
 * Caps are deliberate. A questionnaire whose every noun "needs defining" is a glossary nobody will
 * curate, so the analyst is bounded to 40 candidate terms and 4 readings each; the prompt tells it
 * to prefer precision over recall, and these caps stop a runaway response regardless.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { GLOSSARY_MAX_DEFINITIONS_PER_TERM } from '@/lib/app/questionnaire/glossary/types';

/** Hard cap on proposals from one analysis run. */
export const GLOSSARY_ANALYSIS_MAX_TERMS = 40;

const proposedDefinitionSchema = z.object({
  /** The reading itself, written as a definition the respondent could be shown verbatim. */
  text: z.string().min(1).max(2000),
  /**
   * The span from the admin's definitions document this reading was drawn from. Present ONLY when
   * the document actually says it — its presence is what lets the admin accept a definition
   * without re-reading the source, so a hallucinated quote would be worse than none.
   */
  sourceQuote: z.string().max(2000).optional(),
});

const proposedTermSchema = z.object({
  /** The term as it appears in the questionnaire. */
  term: z.string().min(1).max(120),
  /** Other surfaces meaning the same thing — spellings, acronyms, irregular plurals. */
  aliases: z.array(z.string().min(1).max(120)).max(8).default([]),
  /** Why this term is open to interpretation HERE. The admin's main adjudication signal. */
  rationale: z.string().min(1).max(2000),
  /** A span from the questionnaire showing the term in use. */
  contextQuote: z.string().max(2000).optional(),
  /**
   * The candidate readings. At least one: a term with no proposed meaning is not a proposal, it
   * is a complaint, and there would be nothing for the admin to tick.
   */
  definitions: z.array(proposedDefinitionSchema).min(1).max(GLOSSARY_MAX_DEFINITIONS_PER_TERM),
});

export type ProposedGlossaryTerm = z.infer<typeof proposedTermSchema>;

export const glossaryAnalysisSchema = z.object({
  terms: z.array(proposedTermSchema).max(GLOSSARY_ANALYSIS_MAX_TERMS),
});

export type GlossaryAnalysisResult = z.infer<typeof glossaryAnalysisSchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const glossaryAnalysisJsonSchema: Record<string, unknown> = z.toJSONSchema(
  glossaryAnalysisSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type GlossaryAnalysisValidation =
  { ok: true; value: GlossaryAnalysisResult } | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link glossaryAnalysisSchema}. */
export function validateGlossaryAnalysis(parsed: unknown): GlossaryAnalysisValidation {
  const result = glossaryAnalysisSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
