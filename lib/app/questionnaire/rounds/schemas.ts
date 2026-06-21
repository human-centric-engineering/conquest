/**
 * Cohorts & Rounds — request-body schemas for the admin API.
 *
 * Pure Zod (no Prisma / Next) so the routes validate at the boundary and the form
 * components share the inferred types — the demo-clients `schemas.ts` precedent. The DB
 * enforces uniqueness (`@@unique([cohortId, email])`, `@@unique([roundId, questionnaireId])`);
 * a collision surfaces as a 409 in the route.
 */

import { z } from 'zod';

import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';
import { MIN_RESPONDENTS_FLOOR } from '@/lib/app/questionnaire/rounds/types';

const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const NOTES_MAX = 1000;

// Learning Mode k-anonymity ceiling — a sane upper bound so the field can't be set absurdly high.
const MIN_RESPONDENTS_CEILING = 100;

const nameField = z.string().trim().min(1, 'Name is required').max(NAME_MAX);

// Empty string from a form field means "clear" — coerce to null so the column stores null.
const optionalTextField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable();

// ISO datetime → Date, or null to clear the bound. Absent (undefined) means "leave unchanged".
const nullableInstant = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .nullable();

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

/** Create a cohort under a demo client. */
export const createCohortSchema = z.object({
  demoClientId: z.string().min(1, 'Demo client is required'),
  name: nameField,
  description: optionalTextField(DESCRIPTION_MAX).optional(),
  // Respondent intro background override — replaces the questionnaire-level text for this cohort's
  // respondents when set; empty/absent inherits. Respondent-facing (distinct from `description`).
  introBackground: optionalTextField(INTRO_BACKGROUND_MAX_LENGTH).optional(),
});

/** Edit a cohort's identity + intro override. At least one field. */
export const updateCohortSchema = z
  .object({
    name: nameField,
    description: optionalTextField(DESCRIPTION_MAX),
    introBackground: optionalTextField(INTRO_BACKGROUND_MAX_LENGTH),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' });

// ---------------------------------------------------------------------------
// Cohort members
// ---------------------------------------------------------------------------

/** Add one person to a cohort's roster. */
export const createCohortMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required').max(254),
  name: nameField,
  notes: optionalTextField(NOTES_MAX).optional(),
});

/**
 * Edit a roster member: identity fields, re-activation, and/or subgroup assignment. `status` accepts
 * only `active` here — REMOVING a member is the soft DELETE on the member route (it also stamps
 * `removedAt`); PATCH `status: active` is how you put a removed member back. `subgroupId: null`
 * unassigns the member from any subgroup; a non-null value must reference a subgroup of the SAME
 * cohort (the route validates). At least one field.
 */
export const updateCohortMemberSchema = z
  .object({
    name: nameField,
    notes: optionalTextField(NOTES_MAX),
    status: z.literal('active'),
    subgroupId: z.string().min(1).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' });

// ---------------------------------------------------------------------------
// Cohort subgroups
// ---------------------------------------------------------------------------

/** Create a subgroup under a cohort. Name is unique within the cohort (DB-enforced → 409). */
export const createCohortSubgroupSchema = z.object({
  name: nameField,
  description: optionalTextField(DESCRIPTION_MAX).optional(),
  ordinal: z.coerce.number().int().min(0).optional(),
});

/** Edit a subgroup's identity / order. At least one field. */
export const updateCohortSubgroupSchema = z
  .object({
    name: nameField,
    description: optionalTextField(DESCRIPTION_MAX),
    ordinal: z.coerce.number().int().min(0),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' });

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

const windowRefinement = (b: { opensAt?: Date | null; closesAt?: Date | null }) =>
  !(b.opensAt && b.closesAt) || b.closesAt.getTime() > b.opensAt.getTime();
const windowMessage = { message: 'The close date must be after the open date', path: ['closesAt'] };

/**
 * Create a round for a cohort. `name` is optional — when absent the route derives a default
 * from the cohort name + window (see {@link defaultRoundName}). Both window bounds are
 * optional and adjustable later.
 */
export const createRoundSchema = z
  .object({
    cohortId: z.string().min(1, 'Cohort is required'),
    name: nameField.optional(),
    description: optionalTextField(DESCRIPTION_MAX).optional(),
    opensAt: nullableInstant.optional(),
    closesAt: nullableInstant.optional(),
  })
  .refine(windowRefinement, windowMessage);

/**
 * Learning Mode tuning, as accepted on a round PATCH. Today one knob: the k-anonymity threshold,
 * clamped to [{@link MIN_RESPONDENTS_FLOOR}, {@link MIN_RESPONDENTS_CEILING}]. Partial so the PATCH
 * can set the flags without resending tuning; the route merges it onto the stored JSON.
 */
export const learningConfigSchema = z
  .object({
    minRespondents: z.coerce.number().int().min(MIN_RESPONDENTS_FLOOR).max(MIN_RESPONDENTS_CEILING),
  })
  .partial();

/**
 * Edit a round: name / description / window / status / context + learning toggles. `status` may move
 * only between `draft` and `open` here — CLOSING is the dedicated `POST …/close` action (it stamps
 * `closedAt`/`closedBy`). At least one field.
 */
export const updateRoundSchema = z
  .object({
    name: nameField,
    description: optionalTextField(DESCRIPTION_MAX),
    opensAt: nullableInstant,
    closesAt: nullableInstant,
    status: z.enum(['draft', 'open']),
    // Additional Context ("interviewer briefing") on/off for this round.
    contextEnabled: z.boolean(),
    // Learning Mode on/off for this round (introduces bias by design — the UI warns).
    learningEnabled: z.boolean(),
    // Learning Mode tuning; merged onto the stored JSON by the route.
    learningConfig: learningConfigSchema,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' })
  .refine(windowRefinement, windowMessage);

/** Attach a questionnaire to a round (optionally pinning a version). */
export const attachRoundQuestionnaireSchema = z.object({
  questionnaireId: z.string().min(1, 'Questionnaire is required'),
  versionId: z.string().min(1).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Round Additional Context ("interviewer briefing") entries
// ---------------------------------------------------------------------------

const CONTEXT_TITLE_MAX = 200;
const CONTEXT_CONTENT_MAX = 5000;

/** Entry provenance — how the briefing note was authored (drives the admin-UI badge). */
export const ROUND_CONTEXT_SOURCES = ['manual', 'upload', 'ai_suggested'] as const;

/**
 * Create one briefing entry under a round. `versionId` scopes it to one bundled questionnaire
 * version; `questionSlotId` attributes it to a single question (omit/null = general briefing for the
 * whole version). The route validates that both ids belong to the round before persisting.
 */
export const createRoundContextEntrySchema = z.object({
  versionId: z.string().min(1, 'Version is required'),
  questionSlotId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(1, 'Title is required').max(CONTEXT_TITLE_MAX),
  content: z.string().trim().min(1, 'Content is required').max(CONTEXT_CONTENT_MAX),
  source: z.enum(ROUND_CONTEXT_SOURCES).optional(),
  ordinal: z.coerce.number().int().min(0).optional(),
});

/**
 * Edit a briefing entry: re-attribute (`questionSlotId`), retitle, rewrite, or reorder. At least one
 * field. `versionId` and `source` are immutable post-create (re-create to move an entry to another
 * version). `questionSlotId: null` explicitly makes an attributed entry general again.
 */
export const updateRoundContextEntrySchema = z
  .object({
    questionSlotId: z.string().min(1).nullable(),
    title: z.string().trim().min(1, 'Title is required').max(CONTEXT_TITLE_MAX),
    content: z.string().trim().min(1, 'Content is required').max(CONTEXT_CONTENT_MAX),
    ordinal: z.coerce.number().int().min(0),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be provided' });

export type CreateCohortInput = z.infer<typeof createCohortSchema>;
export type UpdateCohortInput = z.infer<typeof updateCohortSchema>;
export type CreateCohortMemberInput = z.infer<typeof createCohortMemberSchema>;
export type UpdateCohortMemberInput = z.infer<typeof updateCohortMemberSchema>;
export type CreateCohortSubgroupInput = z.infer<typeof createCohortSubgroupSchema>;
export type UpdateCohortSubgroupInput = z.infer<typeof updateCohortSubgroupSchema>;
export type CreateRoundInput = z.infer<typeof createRoundSchema>;
export type UpdateRoundInput = z.infer<typeof updateRoundSchema>;
export type LearningConfigInput = z.infer<typeof learningConfigSchema>;
export type AttachRoundQuestionnaireInput = z.infer<typeof attachRoundQuestionnaireSchema>;
export type CreateRoundContextEntryInput = z.infer<typeof createRoundContextEntrySchema>;
export type UpdateRoundContextEntryInput = z.infer<typeof updateRoundContextEntrySchema>;

/**
 * Derive the default round name when the admin doesn't supply one: the cohort name plus the
 * window dates ("Acme Team · 1 Jul – 31 Jul 2026"), or just the cohort name when undated.
 * Pure + deterministic (dates formatted in UTC) so it's safe to call from the route and to
 * unit-test. The admin can rename freely afterwards.
 */
export function defaultRoundName(
  cohortName: string,
  opensAt: Date | null,
  closesAt: Date | null
): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  if (opensAt && closesAt) return `${cohortName} · ${fmt(opensAt)} – ${fmt(closesAt)}`;
  if (opensAt) return `${cohortName} · from ${fmt(opensAt)}`;
  if (closesAt) return `${cohortName} · until ${fmt(closesAt)}`;
  return `${cohortName} round`;
}
