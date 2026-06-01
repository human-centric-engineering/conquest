/**
 * Shared types for the questionnaire app module.
 *
 * Deliberately small at the foundation stage — each phase adds the types it
 * needs alongside the models and capabilities it introduces.
 */

/**
 * Lifecycle status shared by `AppQuestionnaire` and `AppQuestionnaireVersion`.
 *
 * Mirrors the schema's `status` column (default `draft`). Extended as later
 * phases formalise launch + versioning semantics (P2/P3); treat this as the
 * current vocabulary, not the final one.
 */
export type AppQuestionnaireStatus = 'draft' | 'launched' | 'archived';

/**
 * Canonical question-type vocabulary for `AppQuestionSlot.type` (schema default
 * `free_text`). Declared as a `const` tuple so it is the single source of truth:
 * the ingestion Zod schema derives its enum from it (`z.enum(QUESTION_TYPES)`)
 * and downstream consumers (F4 selection, F5 judges, F6 agent, P2 UI) share the
 * `QuestionType` union rather than re-listing strings.
 *
 * Kept dependency-light (no Zod import) so leaf consumers can reference it
 * without pulling validation machinery; ingestion owns the schema that uses it.
 */
export const QUESTION_TYPES = [
  'free_text',
  'single_choice',
  'multi_choice',
  'likert',
  'numeric',
  'date',
  'boolean',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const AUDIENCE_EXPERTISE_LEVELS = ['novice', 'intermediate', 'expert'] as const;
export type AudienceExpertiseLevel = (typeof AUDIENCE_EXPERTISE_LEVELS)[number];

export const AUDIENCE_SENSITIVITY_LEVELS = ['low', 'moderate', 'high'] as const;
export type AudienceSensitivity = (typeof AUDIENCE_SENSITIVITY_LEVELS)[number];

/**
 * Structured shape of `AppQuestionnaireVersion.audience` (stored as `Json`).
 * Every field is optional — the extractor infers a subset (the rest stay
 * unknown) and an admin may supply any field, which suppresses inference for
 * exactly that field (admin-wins-per-field; see F1.1 ingestion). One shape so
 * every later consumer (F5 judges, F6 agent, P2 UI) reads the same type.
 */
export type AudienceShape = {
  description?: string;
  role?: string;
  expertiseLevel?: AudienceExpertiseLevel;
  estimatedDurationMinutes?: number;
  locale?: string; // BCP-47, default 'en'
  sensitivity?: AudienceSensitivity;
  notes?: string;
};
