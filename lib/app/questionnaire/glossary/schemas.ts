/**
 * Zod schemas for the definitions / glossary feature (P16).
 *
 * Dependency-light (only `zod` + the local vocabulary) so the routes, the capability, and the
 * admin client all import without pulling server deps.
 */

import { z } from 'zod';

import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';
import {
  GLOSSARY_DEFINITION_SOURCES,
  GLOSSARY_MAX_ALIASES_PER_TERM,
  GLOSSARY_MAX_DEFINITIONS_PER_TERM,
  GLOSSARY_MAX_TERMS_PER_VERSION,
  GLOSSARY_TERM_SOURCES,
  GLOSSARY_TERM_STATUSES,
} from '@/lib/app/questionnaire/glossary/types';

/**
 * A term surface: the display form, or one alias. Capped well below a sentence — a "term" that
 * runs to 120 characters is a definition the admin has pasted into the wrong box, and letting it
 * through would produce an unmatchable surface and a nonsense underline.
 */
const surfaceSchema = z.string().trim().min(1, 'Term is required').max(120, 'Term is too long');

/** Definition prose. Generous, but bounded — the injected form is truncated again at 280 chars. */
const definitionTextSchema = z
  .string()
  .trim()
  .min(1, 'Definition is required')
  .max(2000, 'Definition is too long');

/** One candidate reading of a term, as the curation surface sends it back. */
export const glossaryDefinitionInputSchema = z.object({
  text: definitionTextSchema,
  selected: z.boolean().default(false),
  source: z.enum(GLOSSARY_DEFINITION_SOURCES).default('ai_proposed'),
  sourceQuote: z.string().trim().max(2000).nullish(),
  edited: z.boolean().default(false),
});

export type GlossaryDefinitionInput = z.infer<typeof glossaryDefinitionInputSchema>;

/**
 * One term with its candidate definitions. No `id`: the save is a replace-set, so rows are
 * recreated and the durable identity of a term is its normalised surface, not a cuid.
 */
export const glossaryTermInputSchema = z.object({
  term: surfaceSchema,
  aliases: z.array(surfaceSchema).max(GLOSSARY_MAX_ALIASES_PER_TERM).default([]),
  status: z.enum(GLOSSARY_TERM_STATUSES).default('proposed'),
  source: z.enum(GLOSSARY_TERM_SOURCES).default('admin'),
  rationale: z.string().trim().max(2000).nullish(),
  contextQuote: z.string().trim().max(2000).nullish(),
  definitions: z.array(glossaryDefinitionInputSchema).max(GLOSSARY_MAX_DEFINITIONS_PER_TERM),
});

export type GlossaryTermInput = z.infer<typeof glossaryTermInputSchema>;

/**
 * Replace-set save of a version's whole curated glossary.
 *
 * A replace-set rather than per-row PATCH because the review UI already holds the entire set, and
 * one fork per save beats N forks — every write to a launched version forks a new draft.
 *
 * `superRefine` carries the two invariants the database cannot express:
 *
 *   1. **Normalised terms are unique within the payload.** The DB's `@@unique([versionId,
 *      normalizedTerm])` would catch this too, but only as a 500 after a fork has already
 *      happened. Catching it here fails the request cleanly, before any write.
 *   2. **An `accepted` term carries at least one `selected` definition.** Without this an admin
 *      could accept a term with nothing ticked, and the respondent would get a dotted underline
 *      opening an empty popover — the one failure mode that is visible to the end user.
 */
export const saveGlossarySchema = z
  .object({
    terms: z.array(glossaryTermInputSchema).max(GLOSSARY_MAX_TERMS_PER_VERSION),
  })
  .superRefine((body, ctx) => {
    const seen = new Map<string, number>();
    body.terms.forEach((entry, index) => {
      const normalized = normalizeGlossarySurface(entry.term);
      if (normalized.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['terms', index, 'term'],
          message: 'Term must contain at least one letter or number',
        });
        return;
      }
      const first = seen.get(normalized);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['terms', index, 'term'],
          message: `Duplicate term — "${entry.term}" is already defined at position ${first + 1}`,
        });
        return;
      }
      seen.set(normalized, index);

      if (entry.status === 'accepted' && !entry.definitions.some((d) => d.selected)) {
        ctx.addIssue({
          code: 'custom',
          path: ['terms', index, 'definitions'],
          message: `Select at least one definition for "${entry.term}" before accepting it`,
        });
      }
    });
  });

export type SaveGlossaryInput = z.infer<typeof saveGlossarySchema>;
