/**
 * Shared types for the questionnaire app module.
 *
 * Deliberately small at the foundation stage — each phase adds the types it
 * needs alongside the models and capabilities it introduces.
 */

/**
 * Lifecycle status shared by `AppQuestionnaire` and `AppQuestionnaireVersion`.
 *
 * Mirrors the schema's `status` column (default `draft`). Declared as a `const`
 * tuple so it is the **single source of truth**: the type, the route's Zod query
 * enum (`z.enum(APP_QUESTIONNAIRE_STATUSES)`), and the admin UI's filter/badge
 * options all derive from it — adding a status here updates every consumer rather
 * than leaving hard-coded lists to drift. Treat the set as the current
 * vocabulary, not the final one (later phases formalise launch + versioning).
 */
export const APP_QUESTIONNAIRE_STATUSES = ['draft', 'launched', 'archived'] as const;
export type AppQuestionnaireStatus = (typeof APP_QUESTIONNAIRE_STATUSES)[number];

/**
 * Where a resolved `goal` / `audience` field's value came from — the
 * admin-wins-per-field merge outcome (admin-supplied > inferred > pre-existing).
 * Persisted per field on the version (`goalProvenance`, `audienceProvenance`) so
 * the admin UI can mark inferred values as "the AI guessed this" without
 * re-deriving from the change log. A `const` tuple for the same single-source
 * reason as the status set above.
 */
export const FIELD_PROVENANCES = ['admin-supplied', 'inferred', 'pre-existing'] as const;
export type FieldProvenance = (typeof FIELD_PROVENANCES)[number];

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

/**
 * The `AudienceShape` field names, as a `const` tuple — the single source of
 * truth for iterating audience fields key-by-key. The ingestion merge
 * (admin-wins-per-field) walks this to resolve each field's value and
 * provenance independently. Kept in lock-step with `AudienceShape` above.
 */
export const AUDIENCE_FIELDS = [
  'description',
  'role',
  'expertiseLevel',
  'estimatedDurationMinutes',
  'locale',
  'sensitivity',
  'notes',
] as const satisfies ReadonlyArray<keyof AudienceShape>;

/**
 * Per-field provenance for a version's `audience` — one {@link FieldProvenance}
 * entry per resolved audience field (unresolved fields are absent). Stored as the
 * `audienceProvenance` JSON column and surfaced by the admin read API so the UI
 * can mark each inferred field independently.
 */
export type AudienceProvenance = Partial<Record<keyof AudienceShape, FieldProvenance>>;
