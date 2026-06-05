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
 * How a respondent's answer value was arrived at (F4.2 answer extraction). The
 * label travels on each extracted `AnswerSlotIntent` and (from F4.6) the
 * persisted answer, so a reviewer can see whether a value was stated outright or
 * derived:
 *
 * - `direct` — stated verbatim/near-verbatim in the message (carries a `sourceQuote`).
 * - `inferred` — follows by single-step reasoning from the message, not stated.
 * - `synthesised` — combines multiple turns / the wider transcript; no single span.
 * - `refined` — an earlier answer updated in light of later context (F4.4).
 *
 * The **full vocabulary** is the single source of truth (same reasoning as
 * `FIELD_PROVENANCES`/`QUESTION_TYPES` above). F4.2's extractor only ever emits
 * the {@link EXTRACTOR_EMITTED_PROVENANCES} subset; `refined` is reserved for the
 * F4.4 refinement flow, which starts emitting it without editing this tuple.
 */
export const ANSWER_PROVENANCES = ['direct', 'inferred', 'synthesised', 'refined'] as const;
export type AnswerProvenance = (typeof ANSWER_PROVENANCES)[number];

/**
 * The provenance labels the F4.2 extractor is allowed to emit — `ANSWER_PROVENANCES`
 * minus `refined` (which only the F4.4 refinement flow produces). The answer
 * extraction Zod contract derives its `provenance` enum from this subset so the
 * model can't return `refined` before there's a consumer for it; the normaliser
 * and tests assert against it too. A `satisfies` keeps it a true subset of the
 * vocabulary — dropping a label from `ANSWER_PROVENANCES` forces a fix here.
 */
export const EXTRACTOR_EMITTED_PROVENANCES = [
  'direct',
  'inferred',
  'synthesised',
] as const satisfies ReadonlyArray<AnswerProvenance>;
export type ExtractorEmittedProvenance = (typeof EXTRACTOR_EMITTED_PROVENANCES)[number];

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

/**
 * Human-readable labels for each {@link QuestionType}. Single source so the
 * read surface (`version-graph`) and the editor (`question-editor`) can't drift —
 * a renamed/added type updates both. `Record<QuestionType, string>` so adding a
 * type to the tuple forces a label here.
 */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  free_text: 'Free text',
  single_choice: 'Single choice',
  multi_choice: 'Multi choice',
  likert: 'Likert',
  numeric: 'Numeric',
  date: 'Date',
  boolean: 'Boolean',
};

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

/**
 * Allowlist of tag swatch colours (F2.2). `color` on `AppQuestionTag` is optional
 * and, when set, must be one of these — a closed vocabulary so the create/update
 * Zod schemas, the editor's swatch picker, and the read-view chips all derive from
 * one source (same single-source reasoning as the status/type tuples above). The
 * values are semantic names, not hex, so the UI maps them to its own palette and a
 * theme change doesn't require a data migration.
 */
export const TAG_COLORS = ['slate', 'red', 'amber', 'green', 'blue', 'violet', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/**
 * Per-version run-time configuration (F3.1) — the knobs that control how a session
 * runs, stored in `AppQuestionnaireConfig`. The `const` tuples below are the single
 * source of truth (same reasoning as the status/type sets above): the config Zod
 * schema (`authoring/config-schema.ts`), the read-view narrowing (`_lib/detail.ts`),
 * and the editor's `<Select>` options all derive from them, so adding a value
 * updates every consumer rather than leaving lists to drift.
 */

/**
 * How the agent picks the next question (consumed by F4.1 selection). Ordered
 * simple → complex, which is also the order the config editor's `<Select>`
 * renders them: `sequential` walks ordinal order; `random` picks uniformly
 * (seeded, so a replay re-picks); `weighted` scores by question weight +
 * coverage; `adaptive` uses prior answers + embeddings + an LLM. The selection
 * registry (`selection/`) keys its strategy plugins on these slugs.
 */
export const SELECTION_STRATEGIES = ['sequential', 'random', 'weighted', 'adaptive'] as const;
export type SelectionStrategy = (typeof SELECTION_STRATEGIES)[number];

/** Contradiction-detection mode (consumed by F4.3). `off` disables it; `flag`
 *  surfaces contradictions; `probe` follows up in-conversation. */
export const CONTRADICTION_MODES = ['off', 'flag', 'probe'] as const;
export type ContradictionMode = (typeof CONTRADICTION_MODES)[number];

/** Input type of a session-start profile field. Distinct from `QUESTION_TYPES` —
 *  these are lightweight identity/registration inputs, not questionnaire items. */
export const PROFILE_FIELD_TYPES = ['text', 'email', 'number', 'select'] as const;
export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

/**
 * Lifecycle status of an `AppQuestionnaireSession` (the respondent's run over a
 * version). A minimal vocabulary introduced with the F4.4 persistence foundation —
 * `active` while in progress, `completed` once submitted, `abandoned` if dropped.
 * The full session/turn lifecycle is F4.6's; this is the slice F4.4 needs to anchor
 * answer rows. A `const` tuple for the same single-source reason as the sets above
 * (the schema's `status` column, the Zod enum, and any UI filter derive from it).
 */
export const SESSION_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * One session-start profile field the admin chooses to collect (name, email,
 * role, organisation, custom…). Stored as an ordered JSON array on the config
 * (`profileFields`). `options` is present (and non-empty) only for `select`.
 */
export type ProfileFieldConfig = {
  /** Stable slug, unique within the config — keys the collected value. */
  key: string;
  label: string;
  type: ProfileFieldType;
  required: boolean;
  /** Choices for a `select` field; absent/empty for other types. */
  options?: string[];
};

/**
 * The full resolved shape of a version's configuration — one field per
 * `AppQuestionnaireConfig` column. The read view returns this (defaults when no
 * row exists); the editor and PATCH body are partials of it.
 */
export type QuestionnaireConfigShape = {
  selectionStrategy: SelectionStrategy;
  minQuestionsAnswered: number;
  coverageThreshold: number;
  costBudgetUsd: number | null;
  maxQuestionsPerSession: number | null;
  voiceEnabled: boolean;
  contradictionMode: ContradictionMode;
  contradictionWindowN: number;
  anonymousMode: boolean;
  profileFields: ProfileFieldConfig[];
};

/**
 * The resolved config for a version that has never been saved — mirrors the
 * schema column defaults. The read path returns this when no row exists (lazy
 * materialization), so the UI always renders a complete config and the launch
 * gate's "config saved" check is the only thing that distinguishes a deliberate
 * default-config from an untouched one.
 */
export const DEFAULT_QUESTIONNAIRE_CONFIG: QuestionnaireConfigShape = {
  selectionStrategy: 'sequential',
  minQuestionsAnswered: 0,
  coverageThreshold: 1,
  costBudgetUsd: null,
  maxQuestionsPerSession: null,
  voiceEnabled: false,
  contradictionMode: 'off',
  contradictionWindowN: 0,
  anonymousMode: false,
  profileFields: [],
};
