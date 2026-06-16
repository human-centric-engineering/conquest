/**
 * Questionnaire title (name) validation — the single source of truth shared by the
 * ingest upload parser, the rename endpoint, and the admin rename form.
 *
 * Pure Zod — no Prisma / Next — so it is safe to import from a client component as
 * well as the route. The cap matches the title-search column bound.
 */

import { z } from 'zod';

/** Upper bound on a questionnaire title — matches the title-search cap. */
export const MAX_QUESTIONNAIRE_TITLE_LENGTH = 200;

/** A non-empty, trimmed, length-capped questionnaire title. */
export const questionnaireTitleSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(
    MAX_QUESTIONNAIRE_TITLE_LENGTH,
    `Must be at most ${MAX_QUESTIONNAIRE_TITLE_LENGTH} characters`
  );

/** Rename request body for `PATCH /api/v1/app/questionnaires/:id`. */
export const renameQuestionnaireSchema = z.object({
  title: questionnaireTitleSchema,
});

export type RenameQuestionnaireInput = z.infer<typeof renameQuestionnaireSchema>;
