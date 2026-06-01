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
