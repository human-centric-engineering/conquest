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
  CAPTURE_MODES,
  COHORT_REPORT_BACKGROUND_MAX_LENGTH,
  COHORT_REPORT_DETAIL_LEVELS,
  COHORT_REPORT_FORMALITIES,
  COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  COHORT_REPORT_LENGTHS,
  CONTRADICTION_MODES,
  FUNNEL_PACES,
  HOUSE_RULE_KINDS,
  type HouseRuleKind,
  HOUSE_RULE_TEXT_MAX,
  HOUSE_RULE_TRIGGER_MAX,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_OPENING_MODES,
  INTRO_BACKGROUND_MAX_LENGTH,
  INTRO_BUTTON_LABEL_MAX_LENGTH,
  INTRO_VIDEO_URL_MAX_LENGTH,
  INVITEE_FIELD_KEYS,
  MAX_HOUSE_RULES,
  MAX_MILESTONE_THRESHOLDS,
  MAX_OPENING_EXAMPLES,
  OPENING_EXAMPLE_MAX,
  PERSONA_KEY_MAX_LENGTH,
  PERSONA_SWITCHERS,
  PRESENTATION_MODES,
  RESPONDENT_CHROMES,
  RESPONDENT_LAYOUTS,
  MAX_REPORT_RESEARCH_RESULTS,
  MAX_REPORT_RESEARCH_ROUNDS,
  PROFILE_FIELD_TYPES,
  PROFILE_FIELD_VALIDATION_MODES,
  REASONING_PLACEMENTS,
  REPORT_RESEARCH_DISPLAYS,
  REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
  REPORT_RESEARCH_TIMINGS,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_MODES,
  RESPONDENT_REPORT_NARRATIVE_STYLES,
  SELECTION_STRATEGIES,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  TONE_PERSONA_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';
import { resolveIntroVideo } from '@/lib/app/questionnaire/intro/video';
import { BUILT_IN_PERSONA_KEYS } from '@/lib/app/questionnaire/persona/presets';

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
    // How the value is validated. Optional-with-default so legacy stored fields (written before this
    // key existed) parse cleanly and resolve to format-only `deterministic` behaviour.
    validation: z.enum(PROFILE_FIELD_VALIDATION_MODES).optional().default('deterministic'),
    // Where this field is collected, overriding the version-wide `captureMode`. Optional with NO
    // default (unlike `validation`): an absent value means "inherit the default", which is what a
    // mixed set of per-field overrides expresses as a hybrid questionnaire. Legacy fields simply omit
    // it and inherit, so no migration is needed.
    captureVia: z.enum(CAPTURE_MODES).optional(),
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
 *
 * `pace`, `openingMode` and `openingExamples` carry `.default()` rather than being required — a
 * settings export or questionnaire definition written before those fields existed would otherwise
 * fail to import against a `strict()` block, and the defaults reproduce the pre-feature behaviour
 * exactly. Required-ness buys nothing here: the editor always sends all three.
 */
const interviewerStrategySchema = z
  .object({
    enabled: z.boolean(),
    approach: z.enum(INTERVIEWER_APPROACHES),
    pace: z.enum(FUNNEL_PACES).default('balanced'),
    openingMode: z.enum(INTERVIEWER_OPENING_MODES).default('auto'),
    openingExamples: z
      .array(z.string().trim().max(OPENING_EXAMPLE_MAX))
      .max(MAX_OPENING_EXAMPLES)
      .default([]),
    probeDepth: z.boolean(),
    reflect: z.boolean(),
    batchRelated: z.boolean(),
  })
  .strict();

/**
 * Interviewer house rules — the client-specific behaviour policy. Sent whole by the editor;
 * `strict()` rejects unknown keys.
 *
 * The per-rule `superRefine` enforces the one invariant the shape alone cannot: `trigger` belongs to
 * `if_asked` and to nothing else. Required there because a reactive rule with nothing to react to can
 * never fire; forbidden elsewhere because a kind changed in the editor must not leave an orphaned
 * trigger behind in stored JSON (the read-path narrower drops such strays, and the two must agree).
 */
/**
 * `trigger` belongs to `if_asked` and to nothing else — an `if_asked` rule without one has no way to
 * fire, and a trigger on any other kind renders as a dangling clause.
 *
 * Extracted as a standalone refinement because two schemas need it and only one of them has an `id`:
 * the config PATCH validates whole stored rules, while the policy judge panel (F18.8) proposes rule
 * *bodies* whose id is either preserved from the live rule or minted server-side. Sharing the
 * function rather than the schema is what keeps one definition of the invariant — and this is the
 * invariant a judge gets wrong most often.
 */
export function refineHouseRuleTrigger(
  rule: { kind: HouseRuleKind; trigger?: string },
  ctx: z.RefinementCtx
): void {
  if (rule.kind === 'if_asked') {
    if (!rule.trigger) {
      ctx.addIssue({
        code: 'custom',
        message: 'An "if asked" rule needs to say what the respondent asks about',
        path: ['trigger'],
      });
    }
    return;
  }
  if (rule.trigger !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only an "if asked" rule can have a trigger',
      path: ['trigger'],
    });
  }
}

/** The authored fields of a house rule, without the id — what a proposer supplies. */
export const houseRuleBodySchema = z
  .object({
    kind: z.enum(HOUSE_RULE_KINDS),
    text: z.string().trim().min(1).max(HOUSE_RULE_TEXT_MAX),
    trigger: z.string().trim().max(HOUSE_RULE_TRIGGER_MAX).optional(),
  })
  .strict()
  .superRefine(refineHouseRuleTrigger);

const houseRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: z.enum(HOUSE_RULE_KINDS),
    enabled: z.boolean(),
    text: z.string().trim().min(1).max(HOUSE_RULE_TEXT_MAX),
    trigger: z.string().trim().max(HOUSE_RULE_TRIGGER_MAX).optional(),
  })
  .strict()
  .superRefine(refineHouseRuleTrigger);

/**
 * The question-fidelity gate. `.strict()` like its neighbours so a typo'd key is a 400 rather than a
 * silently-ignored setting. `defaultFidelity` is bounded, not enumerated — `clampQuestionFidelity`
 * snaps it onto the five-stop grid on read, so a value from an older client still saves.
 */
const questionFidelitySchema = z
  .object({
    enabled: z.boolean(),
    defaultFidelity: z.number().min(0).max(1),
  })
  .strict();

const houseRulesSchema = z
  .object({
    enabled: z.boolean(),
    rules: z.array(houseRuleSchema).max(MAX_HOUSE_RULES),
  })
  .strict()
  .superRefine((settings, ctx) => {
    // Ids key the editor list and anchor the authoring lints — duplicates would collapse rules onto
    // one another in the UI and make a warning point at the wrong rule.
    const seen = new Set<string>();
    settings.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Rule ids must be unique',
          path: ['rules', index, 'id'],
        });
      }
      seen.add(rule.id);
    });
  });

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
 * Built-in persona mode (F-persona) — the either/or partner of the custom `tone` block. `enabled`
 * on ⇒ a built-in library persona governs the interviewer; `defaultPersonaKey` pins which one
 * (validated against the built-in keys in the refinement below); `allowRespondentSwitch` opts into
 * letting respondents change it via `switcher` and **defaults to `false`** when omitted (so a
 * hand-authored or older import file without it still parses — matching the read-path narrower). The
 * library itself is fixed ({@link BUILT_IN_PERSONAS}) — not per-version config — so no custom personas
 * are accepted here.
 */
const personaSelectionSchema = z
  .object({
    enabled: z.boolean(),
    defaultPersonaKey: z.string().trim().min(1).max(PERSONA_KEY_MAX_LENGTH),
    allowRespondentSwitch: z.boolean().default(false),
    switcher: z.enum(PERSONA_SWITCHERS),
  })
  .strict();

/**
 * Respondent Report (report kind `respondent`) — the full {@link RespondentReportSettings} block.
 * Sent whole (not partial) by the editor; every sub-object present so a save can clear a toggle.
 * `strict()` at every level rejects unknown keys.
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
        narrativeStyle: z.enum(RESPONDENT_REPORT_NARRATIVE_STYLES),
        instructions: z.string().trim().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        structure: z.string().trim().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
        backgroundContext: z.string().trim().max(RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH),
        useClientKnowledge: z.boolean(),
        // Optional for backward-compat: this schema is reused by definition-import, and a
        // `respondentReport` block exported before these knobs shipped has a `generation` object
        // without them. The read path (`narrowRespondentReportSettings`) defaults both; the editor
        // always sends the whole block, so this only widens what import/PATCH will accept.
        dataSlotInfluence: z.number().int().min(0).max(100).optional(),
        discountLowConfidence: z.boolean().optional(),
        // C9 — open-vs-close reconciliation. Optional for the same backward-compat reason as the
        // two knobs above; the refs are question/data-slot keys, so they are bounded like keys.
        reconciliation: z
          .object({
            enabled: z.boolean(),
            statedGoalRefs: z.array(z.string().trim().min(1).max(120)).max(20),
            askedForRefs: z.array(z.string().trim().min(1).max(120)).max(20),
          })
          .strict()
          .optional(),
      })
      .strict(),
    delivery: z
      .object({
        onScreen: z.boolean(),
        download: z.boolean(),
        // Optional for backward-compat, for the same reason as the `generation` knobs above:
        // definition-import replays `respondentReport` blocks exported before this shipped, whose
        // `delivery` object has no `explainMethod`. The read path
        // (`narrowRespondentReportSettings`) defaults it to false; the editor always sends the whole
        // block, so this only widens what import/PATCH will accept.
        explainMethod: z.boolean().optional(),
      })
      .strict(),
    research: z
      .object({
        enabled: z.boolean(),
        timing: z.enum(REPORT_RESEARCH_TIMINGS),
        rounds: z.number().int().min(1).max(MAX_REPORT_RESEARCH_ROUNDS),
        maxResults: z.number().int().min(1).max(MAX_REPORT_RESEARCH_RESULTS),
        before: z
          .object({
            instructions: z.string().trim().max(REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH),
          })
          .strict(),
        after: z
          .object({
            instructions: z.string().trim().max(REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH),
          })
          .strict(),
        display: z.enum(REPORT_RESEARCH_DISPLAYS),
        informNarrative: z.boolean(),
        appendix: z.boolean(),
      })
      .strict()
      // Optional for backward-compat: definition-import reuses this schema, and a questionnaire
      // exported after respondent-reports shipped but before web search has a full `respondentReport`
      // block with no `research`. The read path (`narrowRespondentReportSettings`) defaults it; the
      // editor always sends the whole block, so this only widens what import/PATCH will accept.
      .optional(),
  })
  .strict();

/**
 * Cohort Report (report kind `cohort`) — the full {@link CohortReportSettings} block. Sent whole
 * (not partial) by the editor; every sub-object present so a save can clear a toggle. `strict()` at
 * every level rejects unknown keys.
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
    // minimums are OR'd; 0 = not a criterion on that axis. Config-only.
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

    // Definitions / glossary (P16): how the version's curated terms are put to work.
    glossaryPromptInjection: z.boolean().optional(),
    glossaryRespondentHints: z.boolean().optional(),
    glossaryReportAppendix: z.boolean().optional(),
    profileFields: z.array(profileFieldSchema).optional(),
    // How the profile fields are collected: `form` (a blocking form gate after the intro) or
    // `conversational` (the interviewer gathers them in-chat). Defaults to `form`.
    captureMode: z.enum(CAPTURE_MODES).optional(),
    answerSlotPanelScope: z.enum(ANSWER_SLOT_PANEL_SCOPES).optional(),
    // How the respondent completes the session: chat (conversation), form (raw sectioned
    // form), or both (toggle between them). Defaults to chat for existing versions.
    presentationMode: z.enum(PRESENTATION_MODES).optional(),
    // How the respondent surface is ARRANGED (F-layouts) — orthogonal to presentationMode.
    // Defaults to classic, which is what every questionnaire has always looked like.
    respondentLayout: z.enum(RESPONDENT_LAYOUTS).optional(),
    respondentChrome: z.enum(RESPONDENT_CHROMES).optional(),
    // Inline answer correction (Variant B): let respondents fix a just-captured answer inline
    // (in the chat + on the answer panel) instead of sending a fresh turn. On by default.
    inlineCorrectionEnabled: z.boolean().optional(),
    // Session resume: remember an in-progress session on the device + the Continue/Start-new chooser
    // + the cross-device resume-by-ref endpoint. On by default.
    sessionResumeEnabled: z.boolean().optional(),
    // The "N% completed" text beside the session progress bar (the bar itself always renders).
    showProgressPercentText: z.boolean().optional(),
    // Completeness milestone banners: an inline "you're N% through" chat notice on crossing a
    // configured threshold. Thresholds are percent-complete, 1-99, admin add/remove (bounded so
    // the chat doesn't fill up with banners); uniqueness checked in the superRefine below.
    milestoneBannerEnabled: z.boolean().optional(),
    milestoneBannerThresholds: z
      .array(z.number().int().min(1).max(99))
      .max(MAX_MILESTONE_THRESHOLDS)
      .optional(),
    // Live "watch it think" reasoning trace (demo feature). placement = overlay | inline.
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
    // Interviewer tone & persona (F-tone). Sent whole when present.
    tone: toneSettingsSchema.optional(),
    // Respondent persona-selection toggle + default key (F-persona). The persona library is fixed
    // (BUILT_IN_PERSONAS) and never sent by the editor; only the on/off toggle and the default key
    // are stored.
    personaSelection: personaSelectionSchema.optional(),
    interviewerStrategy: interviewerStrategySchema.optional(),
    // Interviewer house rules (always / never / if-asked). Sent whole when present.
    houseRules: houseRulesSchema.optional(),
    questionFidelity: questionFidelitySchema.optional(),
    // Respondent Report. Sent whole when present.
    respondentReport: respondentReportSettingsSchema.optional(),
    // Cohort Report. Sent whole when present.
    cohortReport: cohortReportSettingsSchema.optional(),
    // Respondent intro / splash screen. Sent whole when present.
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

    // Milestone thresholds unique across the list — a duplicate would just fire twice for no
    // reason (the ledger dedupes by value, but a duplicate in config is always a mistake).
    if (cfg.milestoneBannerThresholds) {
      const values = cfg.milestoneBannerThresholds;
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Milestone thresholds must be unique',
          path: ['milestoneBannerThresholds'],
        });
      }
    }

    // The default persona must be one of the fixed built-in personas.
    if (cfg.personaSelection !== undefined) {
      if (!BUILT_IN_PERSONA_KEYS.includes(cfg.personaSelection.defaultPersonaKey)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Default persona must be one of the built-in personas',
          path: ['personaSelection', 'defaultPersonaKey'],
        });
      }
    }
  });

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
