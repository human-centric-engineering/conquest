/**
 * Shared types for the questionnaire app module.
 *
 * Deliberately small at the foundation stage — each phase adds the types it
 * needs alongside the models and capabilities it introduces.
 */

/**
 * Narrow a stored string to one of a `const`-tuple enum's members, falling back to
 * `fallback` when the value isn't a member. The boundary guard for reading a plain
 * `String` column we validate at the app layer (house style — `status`,
 * `provenanceLabel`, `selectionStrategy` are columns, not Prisma enums), so a stray DB
 * value never escapes as an untyped string. One shared helper so the enum tuples below
 * stay the single source of truth instead of each read seam re-inlining the check.
 */
export function narrowToEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

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
  'matrix',
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
  single_choice: 'Multi-Choice (One Answer)',
  multi_choice: 'Multi-Choice (Multiple Answers)',
  likert: 'Likert',
  matrix: 'Rating grid (matrix)',
  numeric: 'Numeric',
  date: 'Date',
  boolean: 'Boolean',
};

/**
 * How a `free_text` comment field's living paraphrase is built (stored in the slot's
 * `typeConfig.commentAggregation`; classified by the extractor/composer, admin-overridable):
 *  - `isolated`  → paraphrase only this question's own answer + tangential chat mentions of it.
 *  - `section`   → ALSO synthesise from the section's data-slot understanding, so a "comments to
 *                  support your scores" field tracks the whole section as those slots fill.
 * Either way the paraphrase is living (re-evaluated each turn) and never a verbatim dump.
 */
export const FREE_TEXT_COMMENT_AGGREGATIONS = ['isolated', 'section'] as const;
export type FreeTextCommentAggregation = (typeof FREE_TEXT_COMMENT_AGGREGATIONS)[number];

export const FREE_TEXT_COMMENT_AGGREGATION_LABELS: Record<FreeTextCommentAggregation, string> = {
  isolated: 'Isolated',
  section: 'Section summary',
};

/**
 * Read the comment-aggregation mode from a free_text slot's `typeConfig` (an open JSON record).
 * Defaults to `isolated` when absent or malformed — the safe, narrow behaviour.
 */
export function readCommentAggregation(typeConfig: unknown): FreeTextCommentAggregation {
  if (typeConfig && typeof typeConfig === 'object' && !Array.isArray(typeConfig)) {
    const raw = (typeConfig as Record<string, unknown>).commentAggregation;
    if (raw === 'section') return 'section';
  }
  return 'isolated';
}

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

/** Semantic answer-fit resolver mode. A second, focused extraction pass that maps a clearly-given
 *  free-form answer onto a choice/likert question's options/scale when the primary extractor
 *  couldn't (e.g. "Marketing" → the `Other` option; "10 years" → the `3+ years` bucket). `off`
 *  disables it; `fallback` (default) runs it only for questions the respondent addressed but the
 *  extractor failed to map; `always` additionally resolves still-unanswered choice/likert questions
 *  each turn. Reuses the answer-extractor agent — no extra cost on the common path under `fallback`. */
export const ANSWER_FIT_MODES = ['off', 'fallback', 'always'] as const;
export type AnswerFitMode = (typeof ANSWER_FIT_MODES)[number];

/** Input type of a session-start profile field. Distinct from `QUESTION_TYPES` —
 *  these are lightweight identity/registration inputs, not questionnaire items. */
export const PROFILE_FIELD_TYPES = ['text', 'email', 'number', 'select'] as const;
export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

/**
 * How a captured profile field's value is validated (F-capture). `deterministic` runs only the
 * type-aware Zod/regex checks (format, required, select membership). `agentic` additionally runs a
 * best-effort LLM pass that normalises the value (proper-case names, tidy organisation, E.164-ish
 * phone) and flags implausible/garbage input (`asdf`, `test@test`). `hybrid` runs the deterministic
 * gate first (a format failure rejects without spending an LLM call) and, on pass, applies the
 * agentic normalise/flag. The agentic layer is always non-fatal — an LLM outage falls back to the
 * deterministic-passed value, never blocking a respondent (mirrors the `answerFitMode` convention).
 * See `lib/app/questionnaire/profile/validate-profile-fields.ts`. */
export const PROFILE_FIELD_VALIDATION_MODES = ['deterministic', 'agentic', 'hybrid'] as const;
export type ProfileFieldValidationMode = (typeof PROFILE_FIELD_VALIDATION_MODES)[number];

/**
 * How the admin-authored profile fields are collected from the respondent (F-capture). `form`
 * (default) presents them as a standard form that rides the carousel AFTER the intro and BEFORE the
 * chat/interviewer, blocking progress (and the opening LLM turn) until they're filled and validated.
 * `conversational` drops the gate — the interviewer collects the fields naturally in-chat and a
 * best-effort extraction pass maps the answers back to the fields. Neither collects anything when the
 * version is `anonymousMode` (the PII-free public path).
 *
 * `captureMode` is the version-wide DEFAULT placement; an individual field may override it via
 * {@link ProfileFieldConfig.captureVia}, which is how a **hybrid** questionnaire is expressed — e.g.
 * name + email in the form gate, everything else gathered conversationally. The runtime split lives in
 * `lib/app/questionnaire/profile/capture-placement.ts`; the resolver and interviewer read it from
 * there. See `lib/app/questionnaire/profile/resolve-capture.ts`. */
export const CAPTURE_MODES = ['form', 'conversational'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/**
 * How much of the questionnaire the respondent's live answer-slot panel shows
 * (F7.2). `full_progress` lists every slot grouped by section with an X-of-N
 * header (the conversation's running state); `answered_only` shows just the
 * captured answers, so the pending structure is never sent to the client. An
 * admin chooses per version in the config editor; the read endpoint enforces it.
 */
export const ANSWER_SLOT_PANEL_SCOPES = ['full_progress', 'answered_only'] as const;
export type AnswerSlotPanelScope = (typeof ANSWER_SLOT_PANEL_SCOPES)[number];

/**
 * How the per-turn "watch it think" reasoning trace reveals itself on the respondent surface (demo
 * feature). `overlay` ("Animated") mounts the newest turn's trace open, then animates it closed after
 * a brief dwell so the respondent glimpses the reasoning before it tucks away; `inline` renders a
 * quiet collapsible disclosure that stays closed until the respondent opens it. Both show the same
 * collapsed "Reasoning · N" chip on settled / historical turns. An admin chooses per version on the
 * Settings tab; both are gated by the platform flag `APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED`.
 * The enum value `overlay` is retained for config compatibility even though the UI now labels it
 * "Animated". See `lib/app/questionnaire/reasoning` and [[feature-flags-are-db-rows]].
 */
export const REASONING_PLACEMENTS = ['overlay', 'inline'] as const;
export type ReasoningPlacement = (typeof REASONING_PLACEMENTS)[number];

/**
 * How a respondent completes a session (P-presentation). `chat` is the streaming
 * conversation (the original surface, incl. the data-slots experience); `form`
 * renders the questionnaire as a raw, sectioned form with the right input per
 * question type; `both` offers both and lets the respondent toggle between them
 * mid-session (navigate sections, see a completeness map, and edit answers the
 * agent inferred — also an escape hatch when the chat struggles). An admin chooses
 * per version in the config editor; the server pages dispatch on it. `chat` is the
 * default so existing launched versions are unchanged.
 */
export const PRESENTATION_MODES = ['chat', 'form', 'both'] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];

/**
 * Who may START a session over a launched version (the access axis — ORTHOGONAL to
 * {@link QuestionnaireConfigShape.anonymousMode}, which is the identity axis). `invitation_only`
 * (default): a valid per-invitee token is required to begin. `public`: anyone with the link can
 * begin, no token. `both`: either works. The session-create gates and the public `/q/[versionId]`
 * page dispatch on this; the Invitations admin surface reshapes around it. Historically conflated
 * into `anonymousMode` (true ⇒ public) — the F-invitations migration backfills `accessMode` from it.
 */
export const ACCESS_MODES = ['invitation_only', 'public', 'both'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Human labels for the access-mode select in the config editor. */
export const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  invitation_only: 'Invitation only',
  public: 'Public link',
  both: 'Both (link + invitations)',
};

/**
 * The fixed, closed set of per-invitee detail fields an admin can choose to capture on the
 * Invitations surface. `email` is always shown + required (the dedup + delivery key); the rest are
 * admin-configurable via {@link InviteeFieldConfig}. Stored per-invitee as a JSON `profile` on the
 * invitation, and usable for analytics segmentation.
 */
export const INVITEE_FIELD_KEYS = [
  'firstName',
  'surname',
  'email',
  'jobTitle',
  'team',
  'organisation',
] as const;
export type InviteeFieldKey = (typeof INVITEE_FIELD_KEYS)[number];

/** Human labels for each invitee field (review grid columns + config toggles). */
export const INVITEE_FIELD_LABELS: Record<InviteeFieldKey, string> = {
  firstName: 'First name',
  surname: 'Surname',
  email: 'Email',
  jobTitle: 'Job title',
  team: 'Team',
  organisation: 'Organisation',
};

/**
 * One invitee field's per-version visibility config (stored as an ordered JSON array on the config,
 * `inviteeFields`). `email` is forced `shown: true, required: true` at every boundary regardless of
 * what's stored. Drives the import/verify grid columns and send validation.
 */
export type InviteeFieldConfig = {
  key: InviteeFieldKey;
  shown: boolean;
  required: boolean;
};

/**
 * The default invitee-field config: email (locked on), first/last name shown but optional, the rest
 * hidden. Mirrors the schema column default; the read path returns it when no row exists.
 */
export const DEFAULT_INVITEE_FIELDS: InviteeFieldConfig[] = [
  { key: 'firstName', shown: true, required: false },
  { key: 'surname', shown: true, required: false },
  { key: 'email', shown: true, required: true },
  { key: 'jobTitle', shown: false, required: false },
  { key: 'team', shown: false, required: false },
  { key: 'organisation', shown: false, required: false },
];

/**
 * The ways an admin can bulk-add invitees on the import wizard. `paste` is a heuristic free-text
 * parse (no AI); `csv` maps columns; `pdf`/`image` extract people via an AI agent (PDF text / vision)
 * and are gated by `isInvitationImportEnabled`. All converge on the editable verify grid before send.
 */
export const IMPORT_METHODS = ['paste', 'csv', 'pdf', 'image'] as const;
export type ImportMethod = (typeof IMPORT_METHODS)[number];

/**
 * Lifecycle status of an `AppQuestionnaireSession` (the respondent's run over a
 * version). F4.4 introduced a minimal slice (`active | completed | abandoned`) to
 * anchor answer rows; F4.6 completes the lifecycle by adding `paused` — `active`
 * while in progress, `paused` when the respondent steps away (resumable), `completed`
 * once submitted, `abandoned` if dropped. The legal transitions between these (and
 * the event written on each) live in the pure state machine at
 * `lib/app/questionnaire/session/`. A `const` tuple for the same single-source reason
 * as the sets above (the schema's `status` column, the Zod enum, and any UI filter
 * derive from it). The schema keeps `@default("active")` — a new session starts
 * in progress.
 */
export const SESSION_STATUSES = [
  'active',
  'paused',
  'completed',
  'abandoned',
  // Terminal, set ONLY by the seriousness/abuse gate when the strike threshold is hit. Distinct
  // from `abandoned` (admin/manual) so it reads as "Aborted" and analytics can tell the two apart.
  'aborted',
] as const;
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
  /**
   * How this field's value is validated. Defaulted to `deterministic` on read, so legacy stored
   * fields without the key keep their current format-only behaviour. See
   * {@link PROFILE_FIELD_VALIDATION_MODES}.
   */
  validation: ProfileFieldValidationMode;
  /**
   * Where THIS field is collected, overriding the version-wide {@link QuestionnaireConfig.captureMode}
   * default. Absent (the common case) means "inherit the default". Setting it per field is what makes a
   * questionnaire **hybrid** — e.g. `captureVia: 'form'` on name/email while the default mode is
   * `conversational`, so those two ride the blocking form gate and the rest are gathered in-chat. The
   * effective placement is resolved by `effectiveCaptureVia`
   * (`lib/app/questionnaire/profile/capture-placement.ts`). Ignored entirely when `anonymousMode` is on.
   */
  captureVia?: CaptureMode;
};

/**
 * Interviewer tone & persona (F-tone): per-version control over *how* the live
 * conversational interviewer responds — fed into its system prompt at turn time by
 * `buildToneInstructions` (`lib/app/questionnaire/chat/tone.ts`). Each dimension is an
 * independent enable-toggle + a 1–5 slider; everything is off by default so existing
 * questionnaires keep today's voice. Gated additionally by the platform flag
 * `APP_QUESTIONNAIRES_TONE_ENABLED`. Stored as a single `tone` Json column.
 *
 * The nine dimensions split into two kinds (see {@link TONE_DIMENSION_KEYS}):
 *   - **bipolar** (`empathy`, `formality`, `verbosity`, `readingComplexity`, `humour`):
 *     `1` and `5` are opposite poles, `3` is neutral.
 *   - **unipolar intensity** (`mirroring`, `mimicry`, `warmth`, `curiosity`):
 *     `1` = minimal, `5` = strong.
 */
export type ToneDimension = {
  enabled: boolean;
  /** 1–5 slider position (see the dimension's kind for what the poles mean). */
  level: number;
};

/** Free-text persona overlay — casts the agent ("You are an experienced career coach."). */
export type TonePersona = {
  enabled: boolean;
  text: string;
};

/** Ordered list of the nine tone-dimension keys (single source for editor + prompt). */
export const TONE_DIMENSION_KEYS = [
  'empathy',
  'mirroring',
  'formality',
  'mimicry',
  'verbosity',
  'warmth',
  'curiosity',
  'readingComplexity',
  'humour',
] as const;
export type ToneDimensionKey = (typeof TONE_DIMENSION_KEYS)[number];

/** The resolved tone block: one {@link ToneDimension} per key plus the free-text persona. */
export type ToneSettings = Record<ToneDimensionKey, ToneDimension> & {
  persona: TonePersona;
};

/** Lowest / highest valid slider position (STORED scale). */
export const TONE_LEVEL_MIN = 1;
export const TONE_LEVEL_MAX = 5;
/** Neutral midpoint a bipolar dimension defaults to (STORED scale). */
export const TONE_LEVEL_NEUTRAL = 3;

/**
 * Tone dials are STORED as 1–5 (min/neutral/max above) but PRESENTED to admins on a signed −2…+2
 * scale centred on 0, which reads more naturally: 0 is the balanced midpoint, negative/positive move
 * toward the two poles. These convert between the two — display = stored − 3. Storage stays 1–5 so no
 * migration of existing `tone` JSON is needed (mirrors the coverage fraction↔percent split in the
 * config editor). Preset personas author their dials on this display scale too (see `persona/presets.ts`).
 */
export const TONE_DISPLAY_MIN = -2;
export const TONE_DISPLAY_MAX = 2;
export const TONE_DISPLAY_NEUTRAL = 0;
/** Stored 1–5 level → displayed −2…+2 value (3 → 0). */
export const toDisplayLevel = (storedLevel: number): number => storedLevel - TONE_LEVEL_NEUTRAL;
/** Displayed −2…+2 value → stored 1–5 level (0 → 3). */
export const fromDisplayLevel = (displayLevel: number): number => displayLevel + TONE_LEVEL_NEUTRAL;

/** Max length of the free-text persona (matches the Zod bound). */
export const TONE_PERSONA_MAX_LENGTH = 600;

/** Every dimension disabled at the neutral midpoint, persona off — today's behaviour. */
export const DEFAULT_TONE_SETTINGS: ToneSettings = {
  empathy: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  mirroring: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  formality: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  mimicry: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  verbosity: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  warmth: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  curiosity: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  readingComplexity: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  humour: { enabled: false, level: TONE_LEVEL_NEUTRAL },
  persona: { enabled: false, text: '' },
};

/**
 * Selectable interviewer persona (F-persona): one named voice in the version's persona *library*.
 * Each option is a self-contained {@link ToneSettings} — its prose lives in `tone.persona.text` and
 * its character comes from preset tone dimensions — so a chosen persona plugs straight into the
 * existing `buildToneInstructions` pipeline with no new prompt machinery. When the admin enables
 * respondent selection ({@link PersonaSelectionSettings}), the respondent picks one of these and it
 * REPLACES the version's `tone` for their session.
 */
export type PersonaOption = {
  /** Stable slug, unique within the library — persisted as the session's choice. */
  key: string;
  /** Display name (admin + respondent facing), e.g. "The Straight-Talking Curmudgeon". */
  label: string;
  /** One-line respondent-facing description shown on the selection card. */
  description: string;
  /** The full voice for this persona — reuses the tone block wholesale. */
  tone: ToneSettings;
};

/**
 * How the respondent switches interviewer (F-persona), when respondent switching is allowed:
 *   - `page`      — a pre-chat "Choose your interviewer" step + the Interviewer segment in the
 *                   carousel toggle (the original behaviour). No in-chat chip.
 *   - `indicator` — no pre-chat page; the session opens on the default persona and an in-chat
 *                   "Interviewer: {name} · Change" chip opens a modal picker to switch anytime.
 *   - `both`      — the pre-chat page AND the in-chat chip; the chip's "Change" returns to the page.
 */
export const PERSONA_SWITCHERS = ['page', 'indicator', 'both'] as const;
export type PersonaSwitcher = (typeof PERSONA_SWITCHERS)[number];

/**
 * Built-in interviewer persona settings (F-persona). This is one half of an either/or against the
 * version's custom {@link ToneSettings}: `enabled` true ⇒ a built-in library persona governs the
 * interviewer (the chosen persona's tone REPLACES the version `tone`), false ⇒ the version's own
 * hand-tuned tone applies. The admin picks one, never both (enforced in the Settings UI).
 */
export type PersonaSelectionSettings = {
  /** On ⇒ built-in persona mode: the pinned/chosen library persona governs (replacing `tone`). */
  enabled: boolean;
  /** The pinned persona — applied to every respondent (and pre-selected when switching is allowed). */
  defaultPersonaKey: string;
  /**
   * When true, respondents may switch interviewer among the library (via {@link switcher}); when
   * false, everyone gets the pinned `defaultPersonaKey` and no picker/switcher renders. Only
   * meaningful while `enabled`.
   */
  allowRespondentSwitch: boolean;
  /** How the respondent picks/switches interviewer, when switching is allowed. See {@link PersonaSwitcher}. */
  switcher: PersonaSwitcher;
};

/** Max lengths for the editable persona fields (match the Zod bounds). */
export const PERSONA_LABEL_MAX_LENGTH = 60;
export const PERSONA_DESCRIPTION_MAX_LENGTH = 160;
export const PERSONA_KEY_MAX_LENGTH = 40;

/** Stable key of the neutral default persona (objective coach/consultant). */
export const DEFAULT_PERSONA_KEY = 'neutral-coach';

/** Selection off, default = the neutral coach — today's behaviour (version tone prevails). */
export const DEFAULT_PERSONA_SELECTION: PersonaSelectionSettings = {
  enabled: false,
  defaultPersonaKey: DEFAULT_PERSONA_KEY,
  allowRespondentSwitch: false,
  switcher: 'page',
};

/**
 * Interviewer strategy (questioning approach). When `enabled`, these OVERRIDE the default
 * questioning-approach prompt: a session-level openness `approach` (one of {@link
 * INTERVIEWER_APPROACHES}) plus additive tactics that combine with it. Disabled = today's default
 * voice unchanged. Stored as a Json config block (like {@link ToneSettings}); rendered into the
 * asking prompt by `buildInterviewerStrategyInstructions`.
 *
 * - `funnel` — open/general first to let people ramble and fill many slots at once, then narrow to
 *   targeted as coverage builds; goes targeted sooner when the respondent is terse, and re-opens as
 *   the form fills.
 * - `open` — broad and exploratory throughout, loosely guided by remaining gaps.
 * - `targeted` — one specific, concrete question at a time; efficient.
 */
export const INTERVIEWER_APPROACHES = ['funnel', 'open', 'targeted'] as const;
export type InterviewerApproach = (typeof INTERVIEWER_APPROACHES)[number];

/** Human labels — single source for the admin select + any display. */
export const INTERVIEWER_APPROACH_LABELS: Record<InterviewerApproach, string> = {
  funnel: 'Funnel (open → targeted)',
  open: 'Open throughout',
  targeted: 'Targeted / efficient',
};

export type InterviewerStrategySettings = {
  /** Off ⇒ the default questioning-approach prompt is used unchanged. */
  enabled: boolean;
  /** The session-level openness arc. */
  approach: InterviewerApproach;
  /** Tactic: dig into a shallow / low-confidence answer with one follow-up before moving on. */
  probeDepth: boolean;
  /** Tactic: briefly reflect the captured point back before the next question (also corroborates). */
  reflect: boolean;
  /** Tactic: invite a few closely-related gaps together rather than strictly one at a time. */
  batchRelated: boolean;
};

/** Disabled — today's default questioning approach, no override. */
export const DEFAULT_INTERVIEWER_STRATEGY: InterviewerStrategySettings = {
  enabled: false,
  approach: 'funnel',
  probeDepth: false,
  reflect: false,
  batchRelated: false,
};

/**
 * Respondent Report (report kind `respondent`) — the per-respondent report delivered after a
 * respondent completes the questionnaire. The first of two report kinds; the later cross-respondent
 * Cohort Report (`cohort`) gets its own config when built.
 *
 * Modes:
 *   - `raw` — answers only (data-slot values and/or the questions as presented). Deterministic,
 *     rendered on demand; needs no stored report row.
 *   - `raw_plus_insights` — the raw report plus an AI-generated, actionable insights section,
 *     assembled by the report agent (optionally grounded in the client knowledge base). Generated
 *     once, async, after submit (stored in `AppRespondentReport`).
 *   - `narrative` — a single woven report: the respondent's answers are integrated into flowing,
 *     analysed prose (analyses, insights, advice) rather than shown as a separate raw section. Same
 *     async lifecycle and stored content shape as `raw_plus_insights`; the deliverable is the woven
 *     report only (no separate raw answer list).
 *
 * `raw_plus_insights` and `narrative` are the AI modes — both stand up the report agent and persist a
 * row in `AppRespondentReport`; `raw` renders deterministically with no row.
 */
export const RESPONDENT_REPORT_MODES = ['raw', 'raw_plus_insights', 'narrative'] as const;
export type RespondentReportMode = (typeof RESPONDENT_REPORT_MODES)[number];

/**
 * Narrative style presets for the AI report (`raw_plus_insights`, `narrative`). Shapes how the
 * generated prose reads — orthogonal to the free-text `instructions` (tone/voice) and to `structure`
 * (which sections). All styles obey the same paragraph discipline (short, blank-line-separated
 * paragraphs, evidence-grounded); the preset tunes density and format:
 *   - `flowing` — connected, analysed prose in short paragraphs (the established default).
 *   - `concise` — tighter and more economical; shorter paragraphs, less scene-setting.
 *   - `structured` — highly scannable: a brief framing per section, then short paragraphs and
 *     bullet-style lists where enumerating factors/consequences/steps.
 */
export const RESPONDENT_REPORT_NARRATIVE_STYLES = ['flowing', 'concise', 'structured'] as const;
export type RespondentReportNarrativeStyle = (typeof RESPONDENT_REPORT_NARRATIVE_STYLES)[number];

/**
 * Default data-slot influence (`generation.dataSlotInfluence`) — a 0–100 weight balancing how much the
 * AI report is shaped by the contextual data-slot understanding vs the direct questionnaire answers.
 * 50 = an even split; questionnaire weight is always `100 - dataSlotInfluence`. Soft: it becomes a
 * weighting instruction in the writer prompt, and only bites when the version actually has data slots.
 */
export const DEFAULT_DATA_SLOT_INFLUENCE = 50;

/**
 * The AI modes: both stand up the report agent, generate async, and persist an `AppRespondentReport`
 * row. `raw` is excluded (deterministic, on-demand, no row). Use this wherever the code must decide
 * "does this mode generate insights?" so the two modes never drift apart.
 */
export function isAiRespondentReportMode(mode: RespondentReportMode): boolean {
  return mode === 'raw_plus_insights' || mode === 'narrative';
}

/** Lifecycle of a stored mode-2 report (the async tick-worker pipeline). */
export const RESPONDENT_REPORT_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export type RespondentReportStatus = (typeof RESPONDENT_REPORT_STATUSES)[number];

/**
 * Origin of a Respondent Report revision (admin re-run). `admin` = an admin triggered the re-run with
 * (possibly overridden) instructions; `ai` is reserved for a future automated re-run source. Mirrors
 * COHORT_REPORT_AUTHORS.
 */
export const RESPONDENT_REPORT_AUTHORS = ['admin', 'ai'] as const;
export type RespondentReportAuthor = (typeof RESPONDENT_REPORT_AUTHORS)[number];

/** Max length of the admin's free-text generation instruction / structure fields (Zod bound). */
export const RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH = 4000;
/** Max length of the admin's short per-re-run note ("why / what changed"), shown in the history (Zod bound). */
export const RESPONDENT_REPORT_RERUN_NOTE_MAX_LENGTH = 500;
/** Max length of the flat background-context blob fed to the report agent (Zod bound). */
export const RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH = 8000;

/* ── Report web-search rounds (report kind `respondent`; reused by `cohort`) ── */

/**
 * When the report web-search rounds run, relative to report generation:
 *   - `before` — gather external context first; it can inform the report prose (see `informNarrative`).
 *   - `after` — research the finished report to enrich / fact-check; findings surface as a section.
 *   - `both` — run a round set before AND after.
 * (Feature-off is `research.enabled === false`, not a timing value.)
 */
export const REPORT_RESEARCH_TIMINGS = ['before', 'after', 'both'] as const;
export type ReportResearchTiming = (typeof REPORT_RESEARCH_TIMINGS)[number];

/**
 * How retrieved findings are presented in the report:
 *   - `table` — a Research / Sources table (title link + snippet).
 *   - `list` — a bulleted list of the same.
 *   - `hidden` — no standalone section (findings may still inform the prose when `informNarrative`).
 */
export const REPORT_RESEARCH_DISPLAYS = ['table', 'list', 'hidden'] as const;
export type ReportResearchDisplay = (typeof REPORT_RESEARCH_DISPLAYS)[number];

/** Max web-search rounds per phase — bounds latency + cost (each round is one LLM turn + one search). */
export const MAX_REPORT_RESEARCH_ROUNDS = 5;
/** Max results requested per search round (also the per-round tool `count` cap). */
export const MAX_REPORT_RESEARCH_RESULTS = 10;
/** Max length of a per-phase research instruction the admin writes for the search agent (Zod bound). */
export const REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH = 4000;

/**
 * The resolved respondent-report config block. `enabled` master-gates the feature for this version;
 * `mode` selects raw / raw+insights / narrative; `rawIncludes` chooses what the raw section shows
 * (ignored by `narrative`, which has no separate raw section); `generation` carries the AI knobs
 * (consulted by both AI modes — `raw_plus_insights` and `narrative`); `delivery` chooses how the
 * respondent receives it (email deferred to v2). Also gated by the platform flag
 * `APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED`.
 */
export type RespondentReportSettings = {
  enabled: boolean;
  mode: RespondentReportMode;
  rawIncludes: {
    /** Include the captured data-slot values (Data Slots feature). */
    dataSlots: boolean;
    /** Include the questions and answers as they were presented to the respondent. */
    questionsAsPresented: boolean;
  };
  generation: {
    /** Narrative style preset shaping how the generated prose reads (density/format). */
    narrativeStyle: RespondentReportNarrativeStyle;
    /** Free-text style/voice instructions for the report agent. */
    instructions: string;
    /** Free-text desired structure/outline for the report. */
    structure: string;
    /** Flat background-context blob (from the admin interview) the agent always sees. */
    backgroundContext: string;
    /** Ground insights in the attributed client's knowledge base when available. */
    useClientKnowledge: boolean;
    /**
     * 0–100 weight balancing how much the report is shaped by the contextual data-slot understanding
     * vs the direct questionnaire answers (questionnaire weight = `100 - dataSlotInfluence`). A soft
     * weighting instruction in the writer prompt; only bites when the version has data slots. See
     * {@link DEFAULT_DATA_SLOT_INFLUENCE}.
     */
    dataSlotInfluence: number;
    /**
     * When true, each answer/data-slot's confidence (0–1) and rationale are surfaced to the report
     * agent, which is instructed to give low-confidence items less weight and disregard the unreliable.
     */
    discountLowConfidence: boolean;
  };
  delivery: {
    /** Show the report on the completion screen. */
    onScreen: boolean;
    /** Offer a downloadable PDF. */
    download: boolean;
  };
  /**
   * Optional web-search rounds that bring live external context into the report. Additionally gated
   * by the platform flag `APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_ENABLED` and by the search backend
   * being configured (Brave key + allowlisted host) — inert and skipped otherwise, never failing a
   * report. Consulted only by the AI modes (`raw_plus_insights`, `narrative`).
   */
  research: {
    /** Master toggle for this version's report web-search rounds. */
    enabled: boolean;
    /** When the rounds run relative to generation. */
    timing: ReportResearchTiming;
    /** Rounds per phase (1..{@link MAX_REPORT_RESEARCH_ROUNDS}); each round can build on the prior. */
    rounds: number;
    /** Results requested per round (1..{@link MAX_REPORT_RESEARCH_RESULTS}). */
    maxResults: number;
    /** Admin prompt for the `before` phase: purpose of the search + what to do with the results. */
    before: { instructions: string };
    /** Admin prompt for the `after` phase: what to enrich / verify in the finished report. */
    after: { instructions: string };
    /** How the cited sources section renders in the report (table / list / hidden). */
    display: ReportResearchDisplay;
    /** Whether `before` findings may inform the grounded report prose (framed as general context). */
    informNarrative: boolean;
    /**
     * Whether the writer may add a synthesized supporting appendix drawn from the findings — only when
     * it genuinely improves the report (per-report agent's choice; may be absent). Independent of
     * `display`/`informNarrative`, and (unlike narrative weaving) may draw on `after` findings too.
     */
    appendix: boolean;
  };
};

/**
 * Feature off, narrative mode, sensible includes/delivery. The feature is off by default (no report
 * unless enabled), but when an admin turns it on the narrative report is the intended default
 * deliverable. `questionsAsPresented` stays `true` — it is the field-level default that raw and
 * raw+insights modes need, and also the fallback `narrowRespondentReportSettings` applies to partial
 * or legacy stored configs. Narrative never appends the Q&A recap regardless, because
 * `resolveReportRawIncludes` suppresses it at read time (see settings.ts); the data-slot appendix is
 * new and defaults off so no existing report regresses into showing it.
 */
export const DEFAULT_RESPONDENT_REPORT_SETTINGS: RespondentReportSettings = {
  enabled: false,
  mode: 'narrative',
  rawIncludes: { dataSlots: false, questionsAsPresented: true },
  generation: {
    narrativeStyle: 'flowing',
    instructions: '',
    structure: '',
    backgroundContext: '',
    useClientKnowledge: false,
    dataSlotInfluence: DEFAULT_DATA_SLOT_INFLUENCE,
    discountLowConfidence: true,
  },
  delivery: { onScreen: true, download: true },
  research: {
    enabled: false,
    timing: 'before',
    rounds: 1,
    maxResults: 5,
    before: { instructions: '' },
    after: { instructions: '' },
    display: 'list',
    informNarrative: true,
    appendix: false,
  },
};

/* ── Report kinds ─────────────────────────────────────────────────────────── */

/**
 * The two questionnaire report kinds, discriminated from day one even though they ship separately.
 * `respondent` = the per-respondent summary delivered after one session (P10, shipped); `cohort` =
 * the cross-respondent analysis/charting/narrative an admin generates over a whole round's
 * submissions (P14). Scope (one session vs many) is the axis where confusion happens, so the words
 * carry it. Namespaces config rows, routes (`…/cohort-report`), and feature flags by kind.
 */
export const REPORT_KINDS = ['respondent', 'cohort'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/* ── Cohort Report (report kind `cohort`) ─────────────────────────────────── */

/** Lifecycle of a generated cohort report (the async generation pipeline). Mirrors respondent report. */
export const COHORT_REPORT_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export type CohortReportStatus = (typeof COHORT_REPORT_STATUSES)[number];

/** Whether a cohort report is a working draft or has been published (download/share). */
export const COHORT_REPORT_PUBLISH_STATUSES = ['draft', 'published'] as const;
export type CohortReportPublishStatus = (typeof COHORT_REPORT_PUBLISH_STATUSES)[number];

/** Origin of a cohort-report revision: full AI generation, manual admin edit, or AI-assisted edit. */
export const COHORT_REPORT_AUTHORS = ['ai', 'admin', 'ai_assist'] as const;
export type CohortReportAuthor = (typeof COHORT_REPORT_AUTHORS)[number];

/** How a deterministic scoring schema was authored: the visual builder, or extracted from a document. */
export const SCORING_SCHEMA_SOURCES = ['manual', 'upload'] as const;
export type ScoringSchemaSource = (typeof SCORING_SCHEMA_SOURCES)[number];

/** How a scale combines its items: sum the (weighted) item values, or average them. */
export const SCORING_METHODS = ['sum', 'mean'] as const;
export type ScoringMethod = (typeof SCORING_METHODS)[number];

/** Whether a scoring item reads a question slot's answer or a data slot's fill. */
export const SCORING_ITEM_SOURCES = ['question', 'dataSlot'] as const;
export type ScoringItemSource = (typeof SCORING_ITEM_SOURCES)[number];

/** Overall report length the narrative agent targets. */
export const COHORT_REPORT_LENGTHS = ['brief', 'standard', 'detailed'] as const;
export type CohortReportLength = (typeof COHORT_REPORT_LENGTHS)[number];

/** How deep the per-finding analysis goes (orthogonal to overall length). */
export const COHORT_REPORT_DETAIL_LEVELS = ['overview', 'standard', 'deep'] as const;
export type CohortReportDetailLevel = (typeof COHORT_REPORT_DETAIL_LEVELS)[number];

/**
 * Report formality. `business` opens with an executive summary and a structured spine; `informal`
 * is looser and more conversational. Drives the narrative agent's outline + voice.
 */
export const COHORT_REPORT_FORMALITIES = ['business', 'informal'] as const;
export type CohortReportFormality = (typeof COHORT_REPORT_FORMALITIES)[number];

/** Max length of the admin's free-text generation instruction / structure-template fields (Zod bound). */
export const COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH = 4000;
/** Max length of the flat background-context blob fed to the cohort-report agents (Zod bound). */
export const COHORT_REPORT_BACKGROUND_MAX_LENGTH = 8000;

/**
 * The resolved cohort-report config block (per version). `enabled` master-gates the feature for this
 * version; `generation` carries the AI knobs both the thematic-analysis and narrative agents consult.
 * `structure` is the admin-authored outline the agent fills (empty = auto-structure). The `use*`
 * toggles decide what context the agents may draw on. Also gated by the platform flag
 * `APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED` and (because cohort reports are round-scoped) by
 * `APP_QUESTIONNAIRES_COHORTS_ENABLED`. Narrowed by `narrowCohortReportSettings`
 * (lib/app/questionnaire/cohort-report/settings.ts).
 */
export type CohortReportSettings = {
  enabled: boolean;
  generation: {
    /** Overall length the agent targets. */
    length: CohortReportLength;
    /** How deep the per-finding analysis goes. */
    detailLevel: CohortReportDetailLevel;
    /** Business (exec summary + structured) vs informal (looser). */
    formality: CohortReportFormality;
    /** Free-text style/voice instructions for the narrative agent. */
    instructions: string;
    /** Free-text desired structure/outline (the report "template"); empty = auto-structure. */
    structure: string;
    /** Flat background-context blob the agents always see. */
    backgroundContext: string;
    /** Ground analysis in the attributed client's knowledge base when available. */
    useClientKnowledge: boolean;
    /** Feed the round's Additional Context ("interviewer briefing") to the agents. */
    useRoundContext: boolean;
    /** Feed the cohort's intro/background to the agents. */
    useCohortContext: boolean;
    /** Include deterministic scoring results (when a scoring schema is configured). */
    scoringEnabled: boolean;
  };
};

/** Feature off, sensible business defaults — no cohort report unless enabled. */
export const DEFAULT_COHORT_REPORT_SETTINGS: CohortReportSettings = {
  enabled: false,
  generation: {
    length: 'standard',
    detailLevel: 'standard',
    formality: 'business',
    instructions: '',
    structure: '',
    backgroundContext: '',
    useClientKnowledge: false,
    useRoundContext: true,
    useCohortContext: true,
    scoringEnabled: false,
  },
};

/** Max length of the respondent-facing intro background blob (Zod bound; cohort override shares it). */
export const INTRO_BACKGROUND_MAX_LENGTH = 8000;
/** Max length of the admin-authored proceed-button label on the intro screen (Zod bound). */
export const INTRO_BUTTON_LABEL_MAX_LENGTH = 60;
/** Max length of the optional intro video link (Zod bound; a YouTube/Vimeo URL is well under this). */
export const INTRO_VIDEO_URL_MAX_LENGTH = 500;

/**
 * Respondent intro / splash screen — an admin opt-in screen shown BEFORE the questionnaire starts.
 * `enabled` master-gates it for this version (off by default, so existing launched versions are
 * unchanged); `background` is the admin-authored markdown "about this questionnaire" section
 * (company, team, purpose, how results are used) — optionally REPLACED per cohort by
 * `AppCohort.introBackground`; `buttonLabel` is the proceed button's text (`''` = a per-mode default).
 * The rest of the splash copy (how it works, what you'll get) is DERIVED from `presentationMode` +
 * `respondentReport` at runtime, never stored. Also gated by the platform flag
 * `APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED`. See `lib/app/questionnaire/intro`.
 */
export type IntroSettings = {
  enabled: boolean;
  background: string;
  buttonLabel: string;
  /** Optional YouTube/Vimeo link; resolved to a safe embed at render (`resolveIntroVideo`). */
  videoUrl: string;
};

/** Intro off, no background, default per-mode button — today's behaviour (straight into the chat). */
export const DEFAULT_INTRO_SETTINGS: IntroSettings = {
  enabled: false,
  background: '',
  buttonLabel: '',
  videoUrl: '',
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
  /**
   * Confirmation floor for opportunistic fills (0–1). An answer below this confidence is
   * "tentative" — it does not count toward completion coverage or satisfy a required question
   * until corroborated above it. Lower = the background form-fill accepts guesses sooner.
   */
  answerConfidenceFloor: number;
  /**
   * Respondent-controlled early finish: when on, the respondent may voluntarily end the session
   * and get their report before the agent's own completion thresholds are met. A deliberate escape
   * hatch — it BYPASSES the required-question gate (unlike the agent's `offer`). Off by default;
   * config-only (no platform flag), like {@link inlineCorrectionEnabled}.
   */
  allowEarlyFinish: boolean;
  /**
   * Minimum weighted coverage (0–1) before the "Finish up" control unlocks. `0` = not a criterion
   * on this axis. Combined with {@link earlyFinishMinQuestions} as OR: crossing EITHER configured
   * bar unlocks. Both `0` ⇒ available from the start (once {@link allowEarlyFinish} is on).
   */
  earlyFinishMinCoverage: number;
  /**
   * Minimum number of answered slots before the "Finish up" control unlocks. `0` = not a criterion.
   * See {@link earlyFinishMinCoverage} for the OR semantics.
   */
  earlyFinishMinQuestions: number;
  costBudgetUsd: number | null;
  maxQuestionsPerSession: number | null;
  voiceEnabled: boolean;
  /**
   * Let respondents attach files (images, documents) to their answers — surfaces a paperclip
   * button in the composer. Off by default; only takes effect when the platform flag
   * `APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED` is on. The respondent surfaces AND the live
   * `/messages` turn gate both honour it, so attachments sent while off are ignored.
   */
  attachmentsEnabled: boolean;
  contradictionMode: ContradictionMode;
  contradictionWindowN: number;
  /** Run contradiction detection every N respondent turns; 1 = every turn. */
  contradictionEveryNTurns: number;
  /** Semantic answer-fit resolver mode — see {@link ANSWER_FIT_MODES}. Default `fallback`. */
  answerFitMode: AnswerFitMode;
  /**
   * Extraction candidate pre-filter — narrow the extractor's candidate set by embedding similarity
   * each turn (one embedding call/turn). Recommended for large (50+ slot / 70+ question) surveys.
   * Default `false`.
   */
  extractionPrefilter: boolean;
  anonymousMode: boolean;
  /**
   * Who may start a session (the access axis — orthogonal to {@link anonymousMode}). See
   * {@link ACCESS_MODES}. Default `invitation_only`. The session-create gates and the public
   * `/q/[versionId]` page dispatch on this.
   */
  accessMode: AccessMode;
  /**
   * Per-version invitee-detail field config (ordered). `email` is always shown + required; the rest
   * are admin-configurable. Drives the Invitations import/verify grid + send validation. See
   * {@link InviteeFieldConfig} / {@link DEFAULT_INVITEE_FIELDS}.
   */
  inviteeFields: InviteeFieldConfig[];
  /**
   * Seriousness / abuse gate: how many non-genuine (preposterous / abusive / off-topic)
   * answers a session tolerates before it is abandoned. `0` = off for this questionnaire.
   * Escalating warnings precede the abandon strike. Only takes effect when the platform
   * flag `APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED` is on.
   */
  abuseThreshold: number;
  /**
   * Data Slots feature: how many times the agent targets one data slot before it records a
   * best-effort PROVISIONAL fill and moves on to a fresh topic — so the respondent always feels
   * forward progress instead of being asked the same thing repeatedly. `2` = ask once, one sharper
   * re-ask, then park. Minimum `1` (ask once, immediately provisional if unanswered).
   */
  maxDataSlotAttempts: number;
  /**
   * Sensitivity awareness / safeguarding: when on, the agent detects a sensitive or contentious
   * disclosure (abuse, distress, safeguarding) each turn, remembers it at session level, and asks
   * every later question more gently. Off by default; only takes effect when the platform flag
   * `APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_ENABLED` is on. See [[feature-flags-are-db-rows]].
   */
  sensitivityAwareness: boolean;
  /**
   * Verbatim support message gently surfaced once when a SERIOUS (high-severity) disclosure is
   * detected and {@link sensitivityAwareness} is on. Authored by the admin so the safeguarding copy
   * is never paraphrased by the LLM. Empty (the default) suppresses the signpost entirely.
   */
  supportMessage: string;
  /** Optional support resource URL appended to {@link supportMessage} when set. */
  supportResourceUrl: string;
  profileFields: ProfileFieldConfig[];
  /**
   * The DEFAULT placement for the {@link profileFields} (F-capture). See {@link CAPTURE_MODES}. Defaults
   * to `form` (a blocking form gate after the intro); `conversational` has the interviewer gather them
   * in-chat instead. Individual fields may override this via {@link ProfileFieldConfig.captureVia} — a
   * mix of `form` and `conversational` fields is a hybrid questionnaire. Ignored when `anonymousMode`.
   */
  captureMode: CaptureMode;
  answerSlotPanelScope: AnswerSlotPanelScope;
  /**
   * How the respondent completes the session: `chat`, raw `form`, or `both`
   * (toggle between them). See {@link PRESENTATION_MODES}.
   */
  presentationMode: PresentationMode;
  /**
   * Inline answer correction (Variant B): when on, the respondent can "fix" an answer the latest
   * turn captured through a small inline editor — beneath the most-recent turn in the chat and on
   * the answer-panel row — instead of sending a fresh chat turn. Corrections route through the
   * form-edit path (`PUT …/answers`), so they bypass the turn pipeline and never trigger a
   * same-slot contradiction re-check. Off by default; respondent-facing UX with no platform flag.
   */
  inlineCorrectionEnabled: boolean;
  /**
   * Session resume: let a respondent return to an in-progress session instead of always starting
   * fresh. Governs the whole capability — the no-login surface remembering its session on the device
   * (localStorage) + the "Continue where you left off / Start new" chooser + the cross-device
   * resume-by-ref endpoint. On by default; respondent-facing UX, no platform flag.
   * Off ⇒ today's behaviour (anonymous returns mint a fresh session; by-ref resume 404s).
   */
  sessionResumeEnabled: boolean;
  /**
   * Live "watch it think" reasoning trace (demo feature): show the agent's per-turn reasoning —
   * answers captured (with provenance + confidence), contradictions spotted, why the next question
   * was chosen — as a live feed beside the chat. On by default; only takes effect when the platform
   * flag `APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED` is on. See `lib/app/questionnaire/reasoning`.
   */
  reasoningStreamEnabled: boolean;
  /** Where the reasoning trace renders ({@link REASONING_PLACEMENTS}); default `overlay`. */
  reasoningStreamPlacement: ReasoningPlacement;
  /**
   * "Animated" placement only: how long (ms) the newest turn's reasoning summary stays open before
   * it tucks away — the base dwell for a trace of **up to two** steps. Larger traces get
   * {@link reasoningStreamPerItemMs} added per step beyond two, so a longer summary stays up long
   * enough to read. Also gates the reply (the next question waits for the close). Default 2000.
   */
  reasoningStreamDwellMs: number;
  /**
   * "Animated" placement only: extra dwell (ms) added per reasoning step **beyond the second**, so
   * the open duration scales with how much there is to read. Default 750. Total dwell =
   * `reasoningStreamDwellMs + max(0, steps - 2) * reasoningStreamPerItemMs`.
   */
  reasoningStreamPerItemMs: number;
  /**
   * Persist each turn's reasoning trace on the turn record so it replays on resume / scroll-back
   * (and is available to admin later). `false` = live-only (resumed turns show no trace).
   */
  reasoningStreamPersist: boolean;
  /**
   * Preview Turn Inspector (admin-only): when on, an admin previewing as a respondent can open a
   * per-turn console showing the sequence of agent calls, their raw prompts/responses, the model
   * used, latency, and estimated cost. Off by default. Server-gated to preview sessions
   * (`AppQuestionnaireSession.isPreview`), so it is never surfaced to a real respondent. See
   * `lib/app/questionnaire/inspector`.
   */
  previewInspectorEnabled: boolean;
  /**
   * Interviewer tone & persona — how the conversational interviewer responds to answers. See
   * {@link ToneSettings}. Off by default per dimension; only takes effect when the platform flag
   * `APP_QUESTIONNAIRES_TONE_ENABLED` is on. Threaded to the phraser via `buildToneInstructions`.
   */
  tone: ToneSettings;
  /**
   * Selectable interviewer persona library — the menu of named voices a respondent may choose from.
   * See {@link PersonaOption}. Fixed: the read path always fills this with the built-in library
   * ({@link narrowPersonas}); the legacy `personas` column is ignored. Only surfaced when the platform
   * flag `APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED` and `personaSelection.enabled` are both on.
   */
  personas: PersonaOption[];
  /**
   * Built-in persona mode + which persona is pinned + whether respondents may switch. The either/or
   * partner of {@link tone} above (`enabled` picks which one governs). See {@link PersonaSelectionSettings}.
   */
  personaSelection: PersonaSelectionSettings;
  /** Interviewer questioning approach (off ⇒ default prompts). See {@link InterviewerStrategySettings}. */
  interviewerStrategy: InterviewerStrategySettings;
  /**
   * Respondent Report — the per-respondent report delivered after completion. See
   * {@link RespondentReportSettings}. Off by default; only takes effect when the platform flag
   * `APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED` is on.
   */
  respondentReport: RespondentReportSettings;
  /**
   * Cohort Report — the cross-respondent analysis/charting/narrative generated over a round's
   * submissions. See {@link CohortReportSettings}. Off by default; only takes effect when the
   * platform flags `APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED` + `APP_QUESTIONNAIRES_COHORTS_ENABLED`
   * are on.
   */
  cohortReport: CohortReportSettings;
  /**
   * Respondent intro / splash screen shown before the questionnaire starts. See
   * {@link IntroSettings}. Off by default; only takes effect when the platform flag
   * `APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED` is on.
   */
  intro: IntroSettings;
};

/**
 * The `AppQuestionnaireSessionEvent.reason` written when the seriousness/abuse gate abandons
 * a session (status → `abandoned`). A single constant so the route that writes it, the analytics
 * reader that filters on it, and the tests all derive from one source.
 */
export const ABUSE_ABANDON_REASON = 'abuse_threshold_exceeded';

/**
 * Severity of a sensitive/contentious disclosure the extractor flags (sensitivity awareness).
 * Ordered low → high; `high` = a serious disclosure (abuse, self-harm, threats, safeguarding)
 * that triggers the support signpost. The single source of truth for the extractor schema enum,
 * the session-carried running-max level, and the pure escalation logic.
 */
export const SENSITIVITY_SEVERITIES = ['low', 'medium', 'high'] as const;
export type SensitivitySeverity = (typeof SENSITIVITY_SEVERITIES)[number];

/** The `AppQuestionnaireSessionEvent.eventType` written when a sensitive disclosure is flagged. */
export const SENSITIVITY_FLAGGED_EVENT = 'sensitivity_flagged';

/**
 * The resolved config for a version that has never been saved — mirrors the
 * schema column defaults. The read path returns this when no row exists (lazy
 * materialization), so the UI always renders a complete config and the launch
 * gate's "config saved" check is the only thing that distinguishes a deliberate
 * default-config from an untouched one.
 */
export const DEFAULT_QUESTIONNAIRE_CONFIG: QuestionnaireConfigShape = {
  selectionStrategy: 'adaptive',
  minQuestionsAnswered: 0,
  coverageThreshold: 1,
  answerConfidenceFloor: 0.5,
  allowEarlyFinish: false,
  earlyFinishMinCoverage: 1,
  earlyFinishMinQuestions: 0,
  costBudgetUsd: null,
  maxQuestionsPerSession: null,
  voiceEnabled: false,
  attachmentsEnabled: false,
  contradictionMode: 'off',
  contradictionWindowN: 0,
  contradictionEveryNTurns: 1,
  answerFitMode: 'fallback',
  extractionPrefilter: false,
  anonymousMode: false,
  accessMode: 'invitation_only',
  inviteeFields: DEFAULT_INVITEE_FIELDS,
  abuseThreshold: 4,
  maxDataSlotAttempts: 2,
  sensitivityAwareness: false,
  supportMessage: '',
  supportResourceUrl: '',
  profileFields: [],
  captureMode: 'form',
  answerSlotPanelScope: 'full_progress',
  presentationMode: 'both',
  inlineCorrectionEnabled: false,
  sessionResumeEnabled: true,
  reasoningStreamEnabled: true,
  reasoningStreamPlacement: 'overlay',
  reasoningStreamDwellMs: 2000,
  reasoningStreamPerItemMs: 750,
  reasoningStreamPersist: true,
  // Admin-only debugging surface — off by default; an operator turns it on per version.
  previewInspectorEnabled: false,
  tone: DEFAULT_TONE_SETTINGS,
  // Fixed library: the read-path narrower always returns BUILT_IN_PERSONAS regardless of this value.
  personas: [],
  personaSelection: DEFAULT_PERSONA_SELECTION,
  interviewerStrategy: DEFAULT_INTERVIEWER_STRATEGY,
  respondentReport: DEFAULT_RESPONDENT_REPORT_SETTINGS,
  cohortReport: DEFAULT_COHORT_REPORT_SETTINGS,
  intro: DEFAULT_INTRO_SETTINGS,
};
