/**
 * Questionnaire settings registry — one descriptor per {@link QuestionnaireConfigShape} field,
 * declaring how that setting is PRESENTED to a human (group heading, label, formatted value) and
 * whether it belongs in the standard, share-facing summary or the technical/tuning tier.
 *
 * Why this exists: the Questionnaire Pack's "Experience setup" table used to be a hand-written array
 * of ten rows. Every config field added since simply never appeared in the pack — a silent omission
 * with nothing to catch it (10 of 49 settings were covered by the time it was noticed). The registry
 * makes that structurally impossible: {@link SETTING_DESCRIPTORS} is declared
 * `satisfies Record<keyof QuestionnaireConfigShape, SettingDescriptor>`, so **adding a config field
 * is a compile error until it is classified here**. New settings are included by default; leaving
 * one out of the shared artifact is now a deliberate `tier: 'technical'` a reviewer can see.
 *
 * Same pattern, same reasoning as the platform's agent field registry
 * (`lib/orchestration/agents/agent-field-registry.ts`, `.context/orchestration/agent-fields.md`),
 * which exists because hand-maintained parallel field lists had already shipped real silent bugs.
 *
 * Two tiers, because the pack is the branded EXTERNAL artifact:
 *   - `standard`  — what the respondent experience IS. Always rendered.
 *   - `technical` — numeric tuning, prompt blobs, cost/abuse thresholds, admin-only debugging.
 *     Rendered only when the admin ticks "Technical & tuning settings" in the export dialog, so a
 *     client-facing PDF doesn't open with a cost budget and a confidence floor.
 *
 * A descriptor emits **0..n rows**, so a nested block (`respondentReport`, `tone`, `intro`, …)
 * expands into as many rows as it has meaningful settings, and a setting that is inert given the
 * rest of the config (milestone thresholds while banners are off) emits none.
 *
 * Pure: no Prisma / Next / DOM / clock.
 */

import {
  ACCESS_MODE_LABELS,
  INTERVIEWER_APPROACH_LABELS,
  INVITEE_FIELD_LABELS,
  TONE_DIMENSION_KEYS,
  toDisplayLevel,
  type AnswerFitMode,
  type AnswerSlotPanelScope,
  type CaptureMode,
  type CohortReportDetailLevel,
  type CohortReportFormality,
  type CohortReportLength,
  type ContradictionMode,
  type PersonaSwitcher,
  type PresentationMode,
  type QuestionnaireConfigShape,
  type ReasoningPlacement,
  type ReportResearchDisplay,
  type ReportResearchTiming,
  type RespondentReportMode,
  type RespondentReportNarrativeStyle,
  type SelectionStrategy,
  type ToneDimensionKey,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

/* ── Tiers & groups ───────────────────────────────────────────────────────── */

/** Whether a row belongs in the share-facing summary or behind the technical opt-in. */
export type SettingTier = 'standard' | 'technical';

/**
 * The group headings rendered, in this order. Every descriptor names one; a group with no visible
 * rows for a given config is skipped by the serialisers rather than rendered empty.
 */
export const SETTING_GROUPS = [
  'Access & participation',
  'Respondent experience',
  'Interviewer',
  'Questioning & completion',
  'Definitions',
  'Reports',
  'Safeguarding',
  'Operations',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** One presented setting row. `tier` overrides the descriptor's default for this row only. */
export interface SettingRow {
  label: string;
  value: string;
  tier?: SettingTier;
}

/** How one config field is presented. `rows` may return `[]` when the setting is inert. */
export interface SettingDescriptor {
  group: SettingGroup;
  /** Default tier for every row this descriptor emits; a row may override it. */
  tier: SettingTier;
  rows: (config: ConfigView) => SettingRow[];
}

/** One row of the rendered settings summary — a group heading plus the label/value pair. */
export interface PackSetupItem {
  group: SettingGroup;
  label: string;
  value: string;
}

/* ── Value formatting ─────────────────────────────────────────────────────── */

const onOff = (value: boolean): string => (value ? 'Enabled' : 'Disabled');
const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');
const setOrNot = (value: string): string => (value.trim() ? 'Set' : 'Not set');
/** A stored 0–1 fraction as a rounded percentage (the config editor's own presentation). */
const asPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const millis = (value: number): string => `${value} ms`;

/** Collapse whitespace and clip admin free text — a pack row is a table cell, not a document. */
function clip(text: string, max = 160): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Join the labels of whichever flags are on; `emptyLabel` when none are. */
function listOf(entries: [boolean, string][], emptyLabel: string): string {
  const on = entries.filter(([enabled]) => enabled).map(([, label]) => label);
  return on.length ? on.join(', ') : emptyLabel;
}

/* ── Enum label maps (exhaustive by construction) ─────────────────────────── */

const SELECTION_STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  sequential: 'Sequential',
  random: 'Random',
  weighted: 'Weighted',
  adaptive: 'Adaptive (the agent chooses)',
};

export const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  chat: 'Chat',
  form: 'Form',
  both: 'Both (respondent can toggle)',
};

const CONTRADICTION_MODE_LABELS: Record<ContradictionMode, string> = {
  off: 'Off',
  flag: 'Flag contradictions',
  probe: 'Follow up in conversation',
};

const ANSWER_FIT_MODE_LABELS: Record<AnswerFitMode, string> = {
  off: 'Off',
  fallback: 'When the primary extractor misses',
  always: 'Always',
};

const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  form: 'A form before the questionnaire',
  conversational: 'The conversation itself',
};

const ANSWER_SLOT_PANEL_SCOPE_LABELS: Record<AnswerSlotPanelScope, string> = {
  full_progress: 'Full progress',
  answered_only: 'Answered questions only',
  hidden: 'Hidden',
};

const REASONING_PLACEMENT_LABELS: Record<ReasoningPlacement, string> = {
  overlay: 'Overlay',
  inline: 'Inline, beside the chat',
};

const PERSONA_SWITCHER_LABELS: Record<PersonaSwitcher, string> = {
  page: 'A choice screen before the chat',
  indicator: 'An in-chat interviewer chip',
  both: 'A choice screen and an in-chat chip',
};

const TONE_DIMENSION_LABELS: Record<ToneDimensionKey, string> = {
  empathy: 'Empathy',
  mirroring: 'Mirroring',
  formality: 'Formality',
  mimicry: 'Mimicry',
  verbosity: 'Verbosity',
  warmth: 'Warmth',
  curiosity: 'Curiosity',
  readingComplexity: 'Reading complexity',
  humour: 'Humour',
};

const RESPONDENT_REPORT_MODE_LABELS: Record<RespondentReportMode, string> = {
  raw: 'Answers only',
  raw_plus_insights: 'Answers plus AI insights',
  narrative: 'Woven narrative',
};

const NARRATIVE_STYLE_LABELS: Record<RespondentReportNarrativeStyle, string> = {
  flowing: 'Flowing prose',
  concise: 'Concise',
  structured: 'Structured and scannable',
};

const RESEARCH_TIMING_LABELS: Record<ReportResearchTiming, string> = {
  before: 'Before writing the report',
  after: 'After writing the report',
  both: 'Before and after writing the report',
};

const RESEARCH_DISPLAY_LABELS: Record<ReportResearchDisplay, string> = {
  table: 'A sources table',
  list: 'A sources list',
  hidden: 'Not shown (may still inform the prose)',
};

const COHORT_LENGTH_LABELS: Record<CohortReportLength, string> = {
  brief: 'Brief',
  standard: 'Standard',
  detailed: 'Detailed',
};

const COHORT_DETAIL_LABELS: Record<CohortReportDetailLevel, string> = {
  overview: 'Overview',
  standard: 'Standard',
  deep: 'Deep',
};

const COHORT_FORMALITY_LABELS: Record<CohortReportFormality, string> = {
  business: 'Business',
  informal: 'Informal',
};

/* ── Descriptors ──────────────────────────────────────────────────────────── */

/**
 * Every config field, declared once. `satisfies Record<keyof QuestionnaireConfigShape, …>` is what
 * makes a new setting a COMPILE ERROR until it is classified — do not weaken it to a plain
 * `Record<string, …>`. Declared in reading order (grouped), not config-shape order; the compiler
 * guarantees completeness either way.
 */
export const SETTING_DESCRIPTORS = {
  /* ── Access & participation ── */

  accessMode: {
    group: 'Access & participation',
    tier: 'standard',
    rows: (c) => [{ label: 'Access', value: ACCESS_MODE_LABELS[c.accessMode] }],
  },
  anonymousMode: {
    group: 'Access & participation',
    tier: 'standard',
    rows: (c) => [{ label: 'Anonymous respondents', value: yesNo(c.anonymousMode) }],
  },
  inviteeFields: {
    group: 'Access & participation',
    tier: 'standard',
    rows: (c) => {
      // Inert on a purely public link — nobody is invited, so no invitee details are collected.
      if (c.accessMode === 'public') return [];
      return [
        {
          label: 'Invitee details collected',
          value: listOf(
            c.inviteeFields.map((field) => [
              field.shown,
              `${INVITEE_FIELD_LABELS[field.key]}${field.required ? ' (required)' : ''}`,
            ]),
            'None'
          ),
        },
      ];
    },
  },
  profileFields: {
    group: 'Access & participation',
    tier: 'standard',
    rows: (c) => {
      // Profile capture is ignored entirely under anonymous mode (see the config-shape docs).
      if (c.anonymousMode) return [];
      return [
        {
          label: 'Respondent details collected',
          value: listOf(
            c.profileFields.map((field) => [
              true,
              `${field.label}${field.required ? ' (required)' : ''}`,
            ]),
            'None'
          ),
        },
      ];
    },
  },
  captureMode: {
    group: 'Access & participation',
    tier: 'standard',
    rows: (c) =>
      c.anonymousMode || c.profileFields.length === 0
        ? []
        : [
            {
              label: 'Respondent details collected via',
              value: CAPTURE_MODE_LABELS[c.captureMode],
            },
          ],
  },

  /* ── Respondent experience ── */

  presentationMode: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Presentation', value: PRESENTATION_MODE_LABELS[c.presentationMode] }],
  },
  intro: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => {
      const rows: SettingRow[] = [{ label: 'Intro screen', value: onOff(c.intro.enabled) }];
      if (!c.intro.enabled) return rows;
      rows.push({ label: 'Intro background', value: setOrNot(c.intro.background) });
      rows.push({ label: 'Intro video', value: c.intro.videoUrl.trim() ? 'Linked' : 'None' });
      rows.push({
        label: 'Intro button label',
        value: c.intro.buttonLabel.trim() || 'Default for the presentation mode',
      });
      return rows;
    },
  },
  voiceEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Voice input', value: onOff(c.voiceEnabled) }],
  },
  attachmentsEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'File attachments', value: onOff(c.attachmentsEnabled) }],
  },
  inlineCorrectionEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Inline answer correction', value: onOff(c.inlineCorrectionEnabled) }],
  },
  answerSlotPanelScope: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [
      { label: 'Answer panel', value: ANSWER_SLOT_PANEL_SCOPE_LABELS[c.answerSlotPanelScope] },
    ],
  },
  sessionResumeEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Session resume', value: onOff(c.sessionResumeEnabled) }],
  },
  showProgressPercentText: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Progress percentage shown', value: yesNo(c.showProgressPercentText) }],
  },
  milestoneBannerEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [
      { label: 'Completeness milestone banners', value: onOff(c.milestoneBannerEnabled) },
    ],
  },
  milestoneBannerThresholds: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) =>
      c.milestoneBannerEnabled && c.milestoneBannerThresholds.length > 0
        ? [
            {
              label: 'Milestone thresholds',
              value: c.milestoneBannerThresholds.map((t) => `${t}%`).join(', '),
            },
          ]
        : [],
  },
  reasoningStreamEnabled: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) => [{ label: 'Live reasoning trace', value: onOff(c.reasoningStreamEnabled) }],
  },
  reasoningStreamPlacement: {
    group: 'Respondent experience',
    tier: 'standard',
    rows: (c) =>
      c.reasoningStreamEnabled
        ? [
            {
              label: 'Reasoning trace placement',
              value: REASONING_PLACEMENT_LABELS[c.reasoningStreamPlacement],
            },
          ]
        : [],
  },
  reasoningStreamDwellMs: {
    group: 'Respondent experience',
    tier: 'technical',
    rows: (c) =>
      c.reasoningStreamEnabled
        ? [{ label: 'Reasoning trace dwell', value: millis(c.reasoningStreamDwellMs) }]
        : [],
  },
  reasoningStreamPerItemMs: {
    group: 'Respondent experience',
    tier: 'technical',
    rows: (c) =>
      c.reasoningStreamEnabled
        ? [
            {
              label: 'Reasoning trace dwell per extra step',
              value: millis(c.reasoningStreamPerItemMs),
            },
          ]
        : [],
  },
  reasoningStreamPersist: {
    group: 'Respondent experience',
    tier: 'technical',
    rows: (c) =>
      c.reasoningStreamEnabled
        ? [
            {
              label: 'Reasoning trace saved with each turn',
              value: yesNo(c.reasoningStreamPersist),
            },
          ]
        : [],
  },

  /* ── Interviewer ── */

  personaSelection: {
    group: 'Interviewer',
    tier: 'standard',
    rows: (c) => {
      // Either/or against the version's custom `tone` — `enabled` picks which one governs.
      if (!c.personaSelection.enabled) {
        return [{ label: 'Interviewer voice', value: 'Custom tone for this questionnaire' }];
      }
      const pinned = c.personas.find((p) => p.key === c.personaSelection.defaultPersonaKey);
      const rows: SettingRow[] = [
        {
          label: 'Interviewer voice',
          value: pinned?.label ?? c.personaSelection.defaultPersonaKey,
        },
        {
          label: 'Respondents may switch interviewer',
          value: yesNo(c.personaSelection.allowRespondentSwitch),
        },
      ];
      if (c.personaSelection.allowRespondentSwitch) {
        rows.push({
          label: 'Interviewer switching via',
          value: PERSONA_SWITCHER_LABELS[c.personaSelection.switcher],
        });
      }
      return rows;
    },
  },
  personas: {
    group: 'Interviewer',
    tier: 'technical',
    rows: (c) =>
      c.personaSelection.enabled && c.personas.length > 0
        ? [{ label: 'Persona library', value: `${c.personas.length} interviewer voices` }]
        : [],
  },
  tone: {
    group: 'Interviewer',
    tier: 'standard',
    rows: (c) => {
      // A built-in persona REPLACES the version's tone, so listing custom dials would misdescribe
      // the live interviewer.
      if (c.personaSelection.enabled) return [];
      const dials = TONE_DIMENSION_KEYS.filter((key) => c.tone[key].enabled).map((key) => {
        const level = toDisplayLevel(c.tone[key].level);
        return `${TONE_DIMENSION_LABELS[key]} ${level > 0 ? '+' : ''}${level}`;
      });
      const rows: SettingRow[] = [
        { label: 'Interviewer tone', value: dials.length ? dials.join(', ') : 'Default' },
      ];
      if (c.tone.persona.enabled && c.tone.persona.text.trim()) {
        rows.push({ label: 'Interviewer persona', value: clip(c.tone.persona.text) });
      }
      return rows;
    },
  },
  interviewerStrategy: {
    group: 'Interviewer',
    tier: 'standard',
    rows: (c) => {
      if (!c.interviewerStrategy.enabled) {
        return [{ label: 'Questioning approach', value: 'Default' }];
      }
      return [
        {
          label: 'Questioning approach',
          value: INTERVIEWER_APPROACH_LABELS[c.interviewerStrategy.approach],
        },
        {
          label: 'Questioning tactics',
          value: listOf(
            [
              [c.interviewerStrategy.probeDepth, 'Probe shallow answers'],
              [c.interviewerStrategy.reflect, 'Reflect answers back'],
              [c.interviewerStrategy.batchRelated, 'Invite related gaps together'],
            ],
            'None'
          ),
        },
      ];
    },
  },

  /* ── Questioning & completion ── */

  selectionStrategy: {
    group: 'Questioning & completion',
    tier: 'standard',
    rows: (c) => [
      { label: 'Question selection', value: SELECTION_STRATEGY_LABELS[c.selectionStrategy] },
    ],
  },
  adaptiveScope: {
    group: 'Questioning & completion',
    tier: 'standard',
    rows: (c) => {
      // Off is the default and the pre-P17 behaviour: every topic runs, so the only honest row is
      // the switch itself. The rest of the block only describes an interview that is actually
      // being narrowed.
      if (!c.adaptiveScope.enabled) {
        return [{ label: 'Adaptive scope', value: 'Disabled' }];
      }
      return [
        { label: 'Adaptive scope', value: 'Enabled' },
        {
          label: 'Conditional topics per interview',
          value: `Up to ${c.adaptiveScope.maxConditionalTopics}`,
        },
        {
          label: 'Unraised-area check topic',
          value: yesNo(c.adaptiveScope.includeCheckTopic),
        },
        { label: 'Chosen topics announced', value: yesNo(c.adaptiveScope.announce) },
        {
          label: 'Respondent can request a topic',
          value: yesNo(c.adaptiveScope.allowRespondentAmendment),
        },
        {
          label: 'Scope rules',
          value: c.adaptiveScope.rules.length
            ? `${c.adaptiveScope.rules.length} rule${c.adaptiveScope.rules.length === 1 ? '' : 's'}`
            : 'None',
        },
        {
          label: 'Planner confidence floor',
          tier: 'technical',
          value: asPercent(c.adaptiveScope.minConfidence),
        },
        {
          label: 'Planner instructions',
          tier: 'technical',
          value: setOrNot(c.adaptiveScope.plannerInstructions),
        },
      ];
    },
  },
  maxQuestionsPerSession: {
    group: 'Questioning & completion',
    tier: 'standard',
    rows: (c) => [
      {
        label: 'Maximum questions per session',
        value: c.maxQuestionsPerSession === null ? 'No limit' : String(c.maxQuestionsPerSession),
      },
    ],
  },
  allowEarlyFinish: {
    group: 'Questioning & completion',
    tier: 'standard',
    rows: (c) => [
      { label: 'Respondent early finish', value: c.allowEarlyFinish ? 'Allowed' : 'Not allowed' },
    ],
  },
  contradictionMode: {
    group: 'Questioning & completion',
    tier: 'standard',
    rows: (c) => [
      { label: 'Contradiction checking', value: CONTRADICTION_MODE_LABELS[c.contradictionMode] },
    ],
  },
  minQuestionsAnswered: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [{ label: 'Minimum questions answered', value: String(c.minQuestionsAnswered) }],
  },
  coverageThreshold: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [{ label: 'Completion coverage target', value: asPercent(c.coverageThreshold) }],
  },
  earlyFinishMinCoverage: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) =>
      c.allowEarlyFinish
        ? [
            {
              label: 'Early finish unlocks at coverage',
              value:
                c.earlyFinishMinCoverage === 0
                  ? 'Not a criterion'
                  : asPercent(c.earlyFinishMinCoverage),
            },
          ]
        : [],
  },
  earlyFinishMinQuestions: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) =>
      c.allowEarlyFinish
        ? [
            {
              label: 'Early finish unlocks at questions answered',
              value:
                c.earlyFinishMinQuestions === 0
                  ? 'Not a criterion'
                  : String(c.earlyFinishMinQuestions),
            },
          ]
        : [],
  },
  answerConfidenceFloor: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [
      { label: 'Answer confirmation floor', value: asPercent(c.answerConfidenceFloor) },
    ],
  },
  answerFitMode: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [
      { label: 'Semantic answer matching', value: ANSWER_FIT_MODE_LABELS[c.answerFitMode] },
    ],
  },
  extractionPrefilter: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [
      { label: 'Extraction candidate pre-filter', value: onOff(c.extractionPrefilter) },
    ],
  },
  maxDataSlotAttempts: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) => [{ label: 'Attempts per data slot', value: String(c.maxDataSlotAttempts) }],
  },
  contradictionWindowN: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) =>
      c.contradictionMode === 'off'
        ? []
        : [{ label: 'Contradiction comparison window', value: String(c.contradictionWindowN) }],
  },
  contradictionEveryNTurns: {
    group: 'Questioning & completion',
    tier: 'technical',
    rows: (c) =>
      c.contradictionMode === 'off'
        ? []
        : [
            {
              label: 'Contradiction check frequency',
              value:
                c.contradictionEveryNTurns === 1
                  ? 'Every turn'
                  : `Every ${c.contradictionEveryNTurns} turns`,
            },
          ],
  },

  /* ── Definitions ── */

  glossaryRespondentHints: {
    group: 'Definitions',
    tier: 'standard',
    rows: (c) => [
      { label: 'Definitions shown to respondents', value: yesNo(c.glossaryRespondentHints) },
    ],
  },
  glossaryPromptInjection: {
    group: 'Definitions',
    tier: 'standard',
    rows: (c) => [
      { label: 'Definitions used by the agent', value: yesNo(c.glossaryPromptInjection) },
    ],
  },
  glossaryReportAppendix: {
    group: 'Definitions',
    tier: 'standard',
    rows: (c) => [
      { label: 'Definitions appended to reports', value: yesNo(c.glossaryReportAppendix) },
    ],
  },

  /* ── Reports ── */

  respondentReport: {
    group: 'Reports',
    tier: 'standard',
    rows: (c) => {
      const r = c.respondentReport;
      const rows: SettingRow[] = [{ label: 'Respondent report', value: onOff(r.enabled) }];
      if (!r.enabled) return rows;

      rows.push({ label: 'Report style', value: RESPONDENT_REPORT_MODE_LABELS[r.mode] });
      // `narrative` weaves the answers into the prose — there is no separate raw section to describe.
      if (r.mode !== 'narrative') {
        rows.push({
          label: 'Report shows',
          value: listOf(
            [
              [r.rawIncludes.dataSlots, 'Captured data-slot values'],
              [r.rawIncludes.questionsAsPresented, 'Questions and answers as presented'],
            ],
            'Nothing'
          ),
        });
      }
      if (r.mode !== 'raw') {
        rows.push({
          label: 'Narrative style',
          value: NARRATIVE_STYLE_LABELS[r.generation.narrativeStyle],
        });
        rows.push({
          label: 'Report grounded in client knowledge',
          value: yesNo(r.generation.useClientKnowledge),
        });
        rows.push({
          label: 'Report instructions',
          value: setOrNot(r.generation.instructions),
          tier: 'technical',
        });
        rows.push({
          label: 'Report structure',
          value: setOrNot(r.generation.structure),
          tier: 'technical',
        });
        rows.push({
          label: 'Report background context',
          value: setOrNot(r.generation.backgroundContext),
          tier: 'technical',
        });
        rows.push({
          label: 'Data-slot influence on the report',
          value: `${r.generation.dataSlotInfluence}%`,
          tier: 'technical',
        });
        rows.push({
          label: 'Low-confidence answers discounted',
          value: yesNo(r.generation.discountLowConfidence),
          tier: 'technical',
        });
      }
      rows.push({
        label: 'Report delivery',
        value: listOf(
          [
            [r.delivery.onScreen, 'On the completion screen'],
            [r.delivery.download, 'PDF download'],
          ],
          'Not delivered to the respondent'
        ),
      });
      rows.push({
        label: '"How this report was created" panel',
        value: yesNo(r.delivery.explainMethod),
      });

      // Web-search rounds are consulted only by the AI modes.
      if (r.mode !== 'raw') {
        rows.push({ label: 'Report web research', value: onOff(r.research.enabled) });
        if (r.research.enabled) {
          rows.push({
            label: 'Research timing',
            value: RESEARCH_TIMING_LABELS[r.research.timing],
          });
          rows.push({ label: 'Research rounds per phase', value: String(r.research.rounds) });
          rows.push({
            label: 'Sources shown as',
            value: RESEARCH_DISPLAY_LABELS[r.research.display],
          });
          rows.push({
            label: 'Research results per round',
            value: String(r.research.maxResults),
            tier: 'technical',
          });
          rows.push({
            label: 'Research may inform the prose',
            value: yesNo(r.research.informNarrative),
            tier: 'technical',
          });
          rows.push({
            label: 'Research appendix allowed',
            value: yesNo(r.research.appendix),
            tier: 'technical',
          });
          rows.push({
            label: 'Research instructions (before)',
            value: setOrNot(r.research.before.instructions),
            tier: 'technical',
          });
          rows.push({
            label: 'Research instructions (after)',
            value: setOrNot(r.research.after.instructions),
            tier: 'technical',
          });
        }
      }
      return rows;
    },
  },
  cohortReport: {
    group: 'Reports',
    tier: 'standard',
    rows: (c) => {
      const g = c.cohortReport.generation;
      const rows: SettingRow[] = [{ label: 'Cohort report', value: onOff(c.cohortReport.enabled) }];
      if (!c.cohortReport.enabled) return rows;

      rows.push({ label: 'Cohort report length', value: COHORT_LENGTH_LABELS[g.length] });
      rows.push({ label: 'Cohort analysis depth', value: COHORT_DETAIL_LABELS[g.detailLevel] });
      rows.push({ label: 'Cohort report register', value: COHORT_FORMALITY_LABELS[g.formality] });
      rows.push({ label: 'Deterministic scoring included', value: yesNo(g.scoringEnabled) });
      rows.push({
        label: 'Cohort report grounded in client knowledge',
        value: yesNo(g.useClientKnowledge),
      });
      rows.push({
        label: 'Cohort report instructions',
        value: setOrNot(g.instructions),
        tier: 'technical',
      });
      rows.push({
        label: 'Cohort report structure',
        value: setOrNot(g.structure),
        tier: 'technical',
      });
      rows.push({
        label: 'Cohort report background context',
        value: setOrNot(g.backgroundContext),
        tier: 'technical',
      });
      rows.push({
        label: 'Round context fed to the agents',
        value: yesNo(g.useRoundContext),
        tier: 'technical',
      });
      rows.push({
        label: 'Cohort context fed to the agents',
        value: yesNo(g.useCohortContext),
        tier: 'technical',
      });
      return rows;
    },
  },

  /* ── Safeguarding ── */

  sensitivityAwareness: {
    group: 'Safeguarding',
    tier: 'standard',
    rows: (c) => [{ label: 'Sensitivity awareness', value: onOff(c.sensitivityAwareness) }],
  },
  supportMessage: {
    group: 'Safeguarding',
    tier: 'standard',
    rows: (c) =>
      c.sensitivityAwareness && c.supportMessage.trim()
        ? [{ label: 'Support message', value: clip(c.supportMessage) }]
        : [],
  },
  supportResourceUrl: {
    group: 'Safeguarding',
    tier: 'standard',
    rows: (c) =>
      c.sensitivityAwareness && c.supportResourceUrl.trim()
        ? [{ label: 'Support resource', value: c.supportResourceUrl.trim() }]
        : [],
  },
  abuseThreshold: {
    group: 'Safeguarding',
    tier: 'technical',
    rows: (c) => [
      {
        label: 'Non-genuine answer tolerance',
        value: c.abuseThreshold === 0 ? 'Off' : `${c.abuseThreshold} strikes`,
      },
    ],
  },

  /* ── Operations ── */

  costBudgetUsd: {
    group: 'Operations',
    tier: 'technical',
    rows: (c) => [
      {
        label: 'Cost budget per session',
        value: c.costBudgetUsd === null ? 'No limit' : `$${c.costBudgetUsd.toFixed(2)}`,
      },
    ],
  },
  previewInspectorEnabled: {
    group: 'Operations',
    tier: 'technical',
    rows: (c) => [
      { label: 'Preview turn inspector (admin only)', value: onOff(c.previewInspectorEnabled) },
    ],
  },
} satisfies Record<keyof QuestionnaireConfigShape, SettingDescriptor>;

/** Every registered config key, in declaration (reading) order. */
export const SETTING_KEYS = Object.keys(SETTING_DESCRIPTORS) as (keyof QuestionnaireConfigShape)[];

/**
 * Render a version's config as presentation-ready rows, grouped by {@link SETTING_GROUPS} order and,
 * within a group, in registry declaration order.
 *
 * `includeTechnical` adds the tuning/prompt/cost tier — the export dialog's opt-in. Everything else
 * is always present, which is the whole point of the registry: a setting added tomorrow shows up
 * here without anyone remembering to add it.
 */
export function buildSettingRows(config: ConfigView, includeTechnical: boolean): PackSetupItem[] {
  const items: PackSetupItem[] = [];
  for (const group of SETTING_GROUPS) {
    for (const key of SETTING_KEYS) {
      const descriptor: SettingDescriptor = SETTING_DESCRIPTORS[key];
      if (descriptor.group !== group) continue;
      for (const row of descriptor.rows(config)) {
        if ((row.tier ?? descriptor.tier) === 'technical' && !includeTechnical) continue;
        items.push({ group, label: row.label, value: row.value });
      }
    }
  }
  return items;
}
