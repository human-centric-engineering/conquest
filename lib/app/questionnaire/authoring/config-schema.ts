/**
 * Request-body schema for the version configuration endpoint (F3.1).
 *
 * `PATCH …/versions/:vid/config` accepts a partial config — every field is
 * optional so the editor can save one section without resending the rest; an
 * omitted key leaves the stored (or default) value unchanged, and at least one key
 * must be present. Enums derive from the `const` tuples in `../types.ts` (single
 * source of truth). Cross-field rules are enforced with `superRefine`, the same
 * discipline as `type-config-schema.ts`:
 *   - contradiction mode/N: `contradictionWindowN` must be > 0 when the mode is
 *     not `off`, and is forced to `0` when it is `off`.
 *   - profile fields: `key`s unique within the array; `select` requires a
 *     non-empty distinct `options` list, every other type forbids `options`.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import {
  ACCESS_MODES,
  ANSWER_FIT_MODES,
  ANSWER_SLOT_PANEL_SCOPES,
  COHORT_REPORT_BACKGROUND_MAX_LENGTH,
  COHORT_REPORT_DETAIL_LEVELS,
  COHORT_REPORT_FORMALITIES,
  COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  COHORT_REPORT_LENGTHS,
  CONTRADICTION_MODES,
  INTERVIEWER_APPROACHES,
  INTRO_BACKGROUND_MAX_LENGTH,
  INTRO_BUTTON_LABEL_MAX_LENGTH,
  INTRO_VIDEO_URL_MAX_LENGTH,
  INVITEE_FIELD_KEYS,
  PRESENTATION_MODES,
  PROFILE_FIELD_TYPES,
  REASONING_PLACEMENTS,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_MODES,
  SELECTION_STRATEGIES,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  TONE_PERSONA_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';
import { resolveIntroVideo } from '@/lib/app/questionnaire/intro/video';

/** One invitee-field visibility entry (email's forced shown+required is applied server-side). */
const inviteeFieldConfigSchema = z.object({
  key: z.enum(INVITEE_FIELD_KEYS),
  shown: z.boolean(),
  required: z.boolean(),
});

/** A profile-field key: lowercase slug so it's a stable, URL/JSON-safe handle. */
const profileFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9_]+$/, 'Key must be lowercase letters, numbers, or underscores');

/**
 * One session-start profile field. `options` is validated against `type` here so
 * a `select` always carries choices and a non-`select` never does.
 */
export const profileFieldSchema = z
  .object({
    key: profileFieldKeySchema,
    label: z.string().trim().min(1).max(200),
    type: z.enum(PROFILE_FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select') {
      const options = field.options ?? [];
      if (options.length < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'A select field needs at least one option',
          path: ['options'],
        });
      }
      if (new Set(options).size !== options.length) {
        ctx.addIssue({ code: 'custom', message: 'Options must be unique', path: ['options'] });
      }
    } else if (field.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only select fields may declare options',
        path: ['options'],
      });
    }
  });

/** One tone dimension: an enable toggle + a bounded 1–5 slider level. */
const toneDimensionSchema = z.object({
  enabled: z.boolean(),
  level: z.number().int().min(TONE_LEVEL_MIN).max(TONE_LEVEL_MAX),
});

/** The free-text persona overlay (toggle + bounded text). */
const tonePersonaSchema = z.object({
  enabled: z.boolean(),
  text: z.string().trim().max(TONE_PERSONA_MAX_LENGTH),
});

/**
 * Interviewer tone & persona (F-tone) — the full {@link ToneSettings} block. Sent whole (not
 * partial) by the editor; every dimension + persona present so a save can clear a toggle. Keys
 * mirror `TONE_DIMENSION_KEYS` + `persona`; `strict()` rejects unknown keys.
 */
/**
 * Interviewer strategy (questioning approach). Sent whole by the editor; `strict()` rejects unknown
 * keys. `approach` is one of {@link INTERVIEWER_APPROACHES}; the tactics are plain booleans.
 */
const interviewerStrategySchema = z
  .object({
    enabled: z.boolean(),
    approach: z.enum(INTERVIEWER_APPROACHES),
    probeDepth: z.boolean(),
    reflect: z.boolean(),
    batchRelated: z.boolean(),
  })
  .strict();

const toneSettingsSchema = z
  .object({
    empathy: toneDimensionSchema,
    mirroring: toneDimensionSchema,
    formality: toneDimensionSchema,
    mimicry: toneDimensionSchema,
    verbosity: toneDimensionSchema,
    warmth: toneDimensionSchema,
    curiosity: toneDimensionSchema,
    readingComplexity: toneDimensionSchema,
    humour: toneDimensionSchema,
    persona: tonePersonaSchema,
  })
  .strict();

/**
 * Respondent Report (report kind `respondent`) — the full {@link RespondentReportSettings} block.
 * Sent whole (not partial) by the editor; every sub-object present so a save can clear a toggle.
 * `strict()` at every level rejects unknown keys. Gated additionally by the platform flag
 * `APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED`.
 */
const respondentReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(RESPONDENT_REPORT_MODES),
    rawIncludes: z
      .object({
        dataSlots: z.boolean(),
        questionsAsPresented: z.boolean(),
      })
      .strict(),
    generation: z
      .object({
        instructions: z.string().trim().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        structure: z.string().trim().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        backgroundContext: z.string().trim().max(RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH),
        useClientKnowledge: z.boolean(),
      })
      .strict(),
    delivery: z
      .object({
        onScreen: z.boolean(),
        download: z.boolean(),
      })
      .strict(),
  })
  .strict();

/**
 * Cohort Report (report kind `cohort`) — the full {@link CohortReportSettings} block. Sent whole
 * (not partial) by the editor; every sub-object present so a save can clear a toggle. `strict()` at
 * every level rejects unknown keys. Gated additionally by the platform flags
 * `APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED` + `APP_QUESTIONNAIRES_COHORTS_ENABLED`.
 */
const cohortReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    generation: z
      .object({
        length: z.enum(COHORT_REPORT_LENGTHS),
        detailLevel: z.enum(COHORT_REPORT_DETAIL_LEVELS),
        formality: z.enum(COHORT_REPORT_FORMALITIES),
        instructions: z.string().trim().max(COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        structure: z.string().trim().max(COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        backgroundContext: z.string().trim().max(COHORT_REPORT_BACKGROUND_MAX_LENGTH),
        useClientKnowledge: z.boolean(),
        useRoundContext: z.boolean(),
        useCohortContext: z.boolean(),
        scoringEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();

/**
 * Respondent intro / splash screen — the full {@link IntroSettings} block. Sent whole (not partial)
 * by the editor; every key present so a save can clear the toggle. `strict()` rejects unknown keys.
 * Gated additionally by the platform flag `APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED`.
 */
const introSettingsSchema = z
  .object({
    enabled: z.boolean(),
    background: z.string().trim().max(INTRO_BACKGROUND_MAX_LENGTH),
    buttonLabel: z.string().trim().max(INTRO_BUTTON_LABEL_MAX_LENGTH),
    // Optional YouTube/Vimeo link; the recognised-host check is in updateConfigSchema's superRefine.
    videoUrl: z.string().trim().max(INTRO_VIDEO_URL_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * PATCH a version's configuration. All fields optional (partial save); at least
 * one required. Numbers are bounded to sane authoring ranges; nullable budget/cap
 * fields use `null` to mean "no cap" (an omitted key leaves the stored value).
 */
export const updateConfigSchema = z
  .object({
    selectionStrategy: z.enum(SELECTION_STRATEGIES).optional(),
    minQuestionsAnswered: z.number().int().nonnegative().optional(),
    coverageThreshold: z.number().min(0).max(1).optional(),
    answerConfidenceFloor: z.number().min(0).max(1).optional(),
    // Respondent-controlled early finish (escape hatch — bypasses the required gate). The two
    // minimums are OR'd; 0 = not a criterion on that axis. Config-only, no platform flag.
    allowEarlyFinish: z.boolean().optional(),
    earlyFinishMinCoverage: z.number().min(0).max(1).optional(),
    earlyFinishMinQuestions: z.number().int().nonnegative().optional(),
    costBudgetUsd: z.number().positive().nullable().optional(),
    maxQuestionsPerSession: z.number().int().positive().nullable().optional(),
    voiceEnabled: z.boolean().optional(),
    // Respondent file attachments (paperclip in the composer). Gated additionally by the platform
    // attachment-input flag; off by default.
    attachmentsEnabled: z.boolean().optional(),
    contradictionMode: z.enum(CONTRADICTION_MODES).optional(),
    answerFitMode: z.enum(ANSWER_FIT_MODES).optional(),
    // Extraction candidate pre-filter: narrow the combined extractor's candidate set by embedding
    // similarity to the respondent's message each turn (spends one embedding call per turn).
    // Recommended for large (50+ slot / 70+ question) surveys; off by default.
    extractionPrefilter: z.boolean().optional(),
    contradictionWindowN: z.number().int().nonnegative().optional(),
    contradictionEveryNTurns: z.number().int().min(1).optional(),
    anonymousMode: z.boolean().optional(),
    // Access mode: who may start a session (orthogonal to anonymousMode). See ACCESS_MODES.
    accessMode: z.enum(ACCESS_MODES).optional(),
    // Admin-configurable invitee detail fields (email forced shown+required server-side).
    inviteeFields: z.array(inviteeFieldConfigSchema).optional(),
    // Seriousness / abuse gate: non-genuine answers tolerated before the session is abandoned.
    // 0 = off; capped to keep the escalation meaningful.
    abuseThreshold: z.number().int().min(0).max(50).optional(),
    // Data Slots feature: re-ask attempts before a slot is parked with a provisional fill.
    // Min 1 (ask once, immediately provisional if unanswered); capped to keep momentum.
    maxDataSlotAttempts: z.number().int().min(1).max(10).optional(),
    // Sensitivity awareness / safeguarding: detect + remember a sensitive disclosure and soften
    // later phrasing. `supportMessage` (with optional `supportResourceUrl`) is the verbatim copy
    // signposted once on a serious disclosure; empty message = no signpost.
    sensitivityAwareness: z.boolean().optional(),
    supportMessage: z.string().trim().max(500).optional(),
    supportResourceUrl: z.string().trim().max(500).optional(),
    profileFields: z.array(profileFieldSchema).optional(),
    answerSlotPanelScope: z.enum(ANSWER_SLOT_PANEL_SCOPES).optional(),
    // How the respondent completes the session: chat (conversation), form (raw sectioned
    // form), or both (toggle between them). Defaults to chat for existing versions.
    presentationMode: z.enum(PRESENTATION_MODES).optional(),
    // Inline answer correction (Variant B): let respondents fix a just-captured answer inline
    // (in the chat + on the answer panel) instead of sending a fresh turn. On by default;
    // respondent-facing UX, no platform flag.
    inlineCorrectionEnabled: z.boolean().optional(),
    // Live "watch it think" reasoning trace (demo feature). Gated additionally by the platform
    // flag APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED. placement = overlay | inline.
    reasoningStreamEnabled: z.boolean().optional(),
    reasoningStreamPlacement: z.enum(REASONING_PLACEMENTS).optional(),
    // "Animated" placement timing: base dwell (ms) the summary stays open for up to two steps, plus
    // extra dwell (ms) per step beyond two. Bounded to keep the demo snappy and the wait sane.
    reasoningStreamDwellMs: z.number().int().min(0).max(10000).optional(),
    reasoningStreamPerItemMs: z.number().int().min(0).max(5000).optional(),
    reasoningStreamPersist: z.boolean().optional(),
    // Preview Turn Inspector (admin-only). When on, an admin previewing as a respondent can open
    // a per-turn console of the agent calls, raw prompts/responses, model, latency, and cost. Only
    // ever surfaced in a preview session (server-enforced); never reaches a real respondent.
    previewInspectorEnabled: z.boolean().optional(),
    // Interviewer tone & persona (F-tone). Sent whole when present; gated additionally by the
    // platform flag APP_QUESTIONNAIRES_TONE_ENABLED.
    tone: toneSettingsSchema.optional(),
    interviewerStrategy: interviewerStrategySchema.optional(),
    // Respondent Report. Sent whole when present; gated additionally by the platform flag
    // APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED.
    respondentReport: respondentReportSettingsSchema.optional(),
    // Cohort Report. Sent whole when present; gated additionally by the platform flags
    // APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED + APP_QUESTIONNAIRES_COHORTS_ENABLED.
    cohortReport: cohortReportSettingsSchema.optional(),
    // Respondent intro / splash screen. Sent whole when present; gated additionally by the platform
    // flag APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED.
    intro: introSettingsSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  })
  .superRefine((cfg, ctx) => {
    // Contradiction mode/N coherence — only checkable when the mode is present in
    // this partial (an omitted mode leaves the stored value, validated on its own save).
    if (cfg.contradictionMode !== undefined) {
      if (cfg.contradictionMode === 'off') {
        if (cfg.contradictionWindowN !== undefined && cfg.contradictionWindowN !== 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'Window N must be 0 when contradiction detection is off',
            path: ['contradictionWindowN'],
          });
        }
      } else if (cfg.contradictionWindowN === undefined || cfg.contradictionWindowN < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Window N must be at least 1 when contradiction detection is on',
          path: ['contradictionWindowN'],
        });
      }
    }

    // A support resource URL, when provided non-empty, must be a valid URL (empty = no link).
    if (cfg.supportResourceUrl !== undefined && cfg.supportResourceUrl.length > 0) {
      if (!URL.canParse(cfg.supportResourceUrl)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Support resource URL must be a valid URL',
          path: ['supportResourceUrl'],
        });
      }
    }

    // An intro video link, when provided non-empty, must resolve to a recognised YouTube/Vimeo
    // embed (empty = no video). Rejecting here keeps every stored value a value the splash can embed.
    if (cfg.intro?.videoUrl) {
      if (!resolveIntroVideo(cfg.intro.videoUrl)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter a valid YouTube or Vimeo video link',
          path: ['intro', 'videoUrl'],
        });
      }
    }

    // Profile-field keys unique across the list.
    if (cfg.profileFields) {
      const keys = cfg.profileFields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Profile field keys must be unique',
          path: ['profileFields'],
        });
      }
    }
  });

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
