/**
 * Unit: Questionnaire Pack PDF render helper (P16 Questionnaire Pack export).
 *
 * A real end-to-end render — {@link PackPdfDocument} through `@react-pdf/renderer`'s
 * `renderToBuffer` — asserting a genuine PDF comes out (the `%PDF` magic header, non-empty body).
 * Exercises the model's seven optional sections (meta / setup / data slots / glossary / questions /
 * evaluations / conditional topics) in both their present and `null`/empty states, plus the per-question
 * option/constraint/guidance branches, so the document never throws on any shape `buildPackModel`
 * can produce.
 *
 * These are structural (no-throw / valid-PDF) checks by design, matching the sibling session-PDF
 * render test — see `render-session-pdf.test.tsx` for the rationale (react-pdf emits a binary
 * buffer; content-level behaviour belongs at the pure `buildPackModel` layer).
 *
 * @see app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf.tsx
 * @see components/app/questionnaire/export/pack-pdf-document.tsx
 */

import { describe, it, expect } from 'vitest';

import { renderPackPdf } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf';
import {
  buildPackModel,
  DEFAULT_PACK_INCLUDE,
  type PackInclude,
} from '@/lib/app/questionnaire/export/build-pack-model';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type {
  VersionGraphView,
  SectionView,
  QuestionSlotView,
  EvaluationRunDetail,
  ScopeEvaluationRunDetail,
} from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import type { GlossaryAppendixView } from '@/lib/app/questionnaire/glossary/types';
import type { ConditionalTopicsSettings, Topic } from '@/lib/app/questionnaire/scope/types';

function question(
  partial: Partial<QuestionSlotView> & Pick<QuestionSlotView, 'key' | 'type'>
): QuestionSlotView {
  return {
    id: partial.key,
    ordinal: 0,
    prompt: `Prompt for ${partial.key}`,
    guidelines: null,
    rationale: null,
    typeConfig: null,
    required: false,
    weight: 0.5,
    fidelity: 0.5,
    extractionConfidence: null,
    tags: [],
    ...partial,
  };
}

function graphOf(
  sections: SectionView[],
  configOverrides: Partial<typeof DEFAULT_QUESTIONNAIRE_CONFIG> = {}
): VersionGraphView {
  return {
    id: 'v1',
    questionnaireId: 'q1',
    versionNumber: 2,
    status: 'draft',
    goal: 'Understand engagement',
    audience: { description: 'Employees' },
    goalProvenance: null,
    audienceProvenance: null,
    tags: [],
    sections,
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...configOverrides, saved: true },
  };
}

const DATA_SLOTS: DataSlotView[] = [
  {
    id: 'ds1',
    key: 'engagement',
    name: 'Engagement',
    description: 'How engaged the respondent feels',
    theme: 'Culture',
    ordinal: 0,
    weight: 1,
    questionKeys: ['q1'],
  },
];

const GLOSSARY: GlossaryAppendixView = {
  heading: 'Definitions',
  entries: [
    { term: 'Engagement', definitions: ['How committed a respondent feels'] },
    { term: 'NPS', definitions: ['Net Promoter Score', 'A loyalty metric'] },
  ],
};

const SCOPE_TOPICS: Topic[] = [
  {
    id: 'top1',
    key: 'background',
    label: 'Background',
    description: 'The opening questions.',
    phase: 'opening',
    criteria: null,
    depth: 'full',
    members: { dataSlotKeys: ['engagement'], questionKeys: ['q1'] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
  },
  {
    id: 'top2',
    key: 'talent',
    label: 'Talent & culture',
    description: 'Hiring, retention, and team dynamics.',
    phase: 'conditional',
    criteria: 'The respondent mentions hiring difficulty or turnover.',
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: ['q1'] },
    ordinal: 1,
    source: 'analyst',
    trigger: null,
  },
  {
    id: 'top3',
    key: 'compliance-check',
    label: 'Compliance blind-spot check',
    description: null,
    phase: 'conditional',
    criteria: 'Sampled lightly when not otherwise selected.',
    depth: 'light',
    members: { dataSlotKeys: ['engagement'], questionKeys: [] },
    ordinal: 2,
    source: 'manual',
    trigger: null,
  },
];

const SCOPE_SETTINGS: ConditionalTopicsSettings = {
  enabled: true,
  maxConditionalTopics: 3,
  includeCheckTopic: true,
  checkTopicPreference: [],
  minConfidence: 0.6,
  fallbackTopicKeys: [],
  announce: true,
  allowRespondentAmendment: true,
  plannerInstructions: '',
  sessionBudgetSeconds: 600,
  secondsPerQuestionType: {},
  secondsPerDataSlot: 40,
  limitOpeningProbes: false,
  maxOpeningProbes: 1,
  rules: [
    {
      id: 'rule1',
      dataSlotKey: 'engagement',
      operator: 'gt',
      value: '50',
      action: 'include',
      topicKey: 'talent',
      ordinal: 0,
    },
    {
      id: 'rule2',
      dataSlotKey: 'engagement',
      operator: 'not_exists',
      value: null,
      action: 'exclude',
      topicKey: 'compliance-check',
      ordinal: 1,
    },
  ],
};

/** The PDF magic header: every PDF byte stream starts with "%PDF". */
function startsWithPdfMagic(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

const EVALUATION_RUN: EvaluationRunDetail = {
  id: 'run1',
  versionId: 'v1',
  questionnaireId: 'q1',
  status: 'completed',
  dimensionsRequested: 7,
  dimensionsRun: 7,
  dimensionsFailed: 0,
  totalFindings: 1,
  dimensionSummary: [
    { dimension: 'clarity', score: 0.6, findingCount: 1, diagnostic: null },
    { dimension: 'coverage', score: null, findingCount: 0, diagnostic: 'judge_error' },
  ],
  triggeredByUserId: 'admin-1',
  error: null,
  startedAt: '2026-08-10T00:00:00.000Z',
  completedAt: '2026-08-10T00:00:05.000Z',
  createdAt: '2026-08-10T00:00:00.000Z',
  reconciled: [
    {
      targetKey: 'q1',
      alternatives: [
        {
          prompt: 'How would you describe your role?',
          addresses: ['clarity', 'audience_match'],
          note: 'One ask, plain language.',
        },
        {
          prompt: 'What is your role, in your own words?',
          addresses: ['clarity'],
          note: 'Shorter, loses the seniority nuance.',
        },
      ],
      unresolved: ['type_fit'],
    },
  ],
  findings: [
    {
      id: 'f1',
      dimension: 'clarity',
      ordinal: 0,
      targetKey: 'q1',
      target: {
        kind: 'question',
        key: 'q1',
        label: 'Prompt for q1',
        sectionTitle: 'Background',
        position: 1,
        sectionPosition: 1,
        questionType: 'single_choice',
        removed: false,
      },
      severity: 'major',
      proposedChange: 'Split into two questions',
      rationale: 'This question asks two things at once',
      sourceQuote: null,
      status: 'pending',
      proposedEdit: null,
      editedOverride: null,
      applyInstruction: null,
      decidedByUserId: null,
      decidedAt: null,
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'manual',
    },
    // A second judge on the SAME question, so the render exercises the by-target block that
    // stacks several verdicts under one printed prompt — the shape the pack now emits.
    {
      id: 'f2',
      dimension: 'audience_match',
      ordinal: 0,
      targetKey: 'q1',
      target: {
        kind: 'question',
        key: 'q1',
        label: 'Prompt for q1',
        sectionTitle: 'Background',
        position: 1,
        sectionPosition: 1,
        questionType: 'single_choice',
        removed: false,
      },
      severity: 'minor',
      proposedChange: 'Drop the jargon for a non-technical audience',
      rationale: 'The stated audience would not know the term',
      sourceQuote: 'engagement quotient',
      status: 'declined',
      proposedEdit: null,
      editedOverride: null,
      applyInstruction: null,
      decidedByUserId: 'admin-1',
      decidedAt: '2026-08-10T00:01:00.000Z',
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'manual',
    },
  ],
};

const SCOPE_EVALUATION_RUN: ScopeEvaluationRunDetail = {
  id: 'scope-run1',
  versionId: 'v1',
  questionnaireId: 'q1',
  status: 'partial',
  dimensionsRequested: 4,
  dimensionsRun: 3,
  dimensionsFailed: 1,
  totalFindings: 1,
  dimensionSummary: [
    { dimension: 'criteria_quality', score: 0.7, findingCount: 1, diagnostic: null },
    { dimension: 'rule_integrity', score: 1, findingCount: 0, diagnostic: null },
    { dimension: 'budget_realism', score: null, findingCount: 0, diagnostic: 'judge_error' },
    { dimension: 'coverage_and_burden', score: 0.9, findingCount: 0, diagnostic: null },
  ],
  triggeredByUserId: 'admin-1',
  error: null,
  startedAt: '2026-08-10T00:00:00.000Z',
  completedAt: '2026-08-10T00:00:05.000Z',
  createdAt: '2026-08-10T00:00:00.000Z',
  findings: [
    {
      id: 'sf1',
      dimension: 'criteria_quality',
      ordinal: 0,
      targetKey: 'topic:talent',
      target: { kind: 'topic', key: 'talent', label: 'Talent & culture', removed: false },
      severity: 'major',
      proposedChange: 'Make the criteria more specific and observable',
      rationale: 'The current wording is too broad to reliably trigger this topic',
      sourceQuote: null,
      status: 'pending',
      proposedEdit: {
        op: 'edit_topic_criteria',
        criteria: 'The respondent names a specific hiring or attrition problem.',
      },
      editedOverride: null,
      decidedByUserId: null,
      decidedAt: null,
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'apply',
    },
  ],
};

describe('renderPackPdf', () => {
  it('renders a full pack (every section included) without throwing', async () => {
    const sections: SectionView[] = [
      {
        id: 's1',
        ordinal: 0,
        title: 'Background',
        description: 'A little about you',
        questions: [
          question({
            key: 'q1',
            type: 'single_choice',
            required: true,
            guidelines: 'Pick the closest match.',
            typeConfig: { choices: [{ label: 'Yes' }, { value: 'no' }], allowOther: true },
          }),
          question({ key: 'q2', type: 'numeric', typeConfig: { min: 0, max: 10, unit: 'points' } }),
        ],
      },
    ];
    const model = buildPackModel(
      'Pulse Survey',
      graphOf(sections),
      DATA_SLOTS,
      GLOSSARY,
      EVALUATION_RUN,
      { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: SCOPE_EVALUATION_RUN },
      null,
      { ...DEFAULT_PACK_INCLUDE, evaluations: true, conditionalTopics: true },
      '2026-08-10T00:00:00.000Z'
    );

    const pdf = await renderPackPdf(model);
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders with every optional section excluded (meta/setup/dataSlots/glossary/questions/evaluations all null)', async () => {
    const include: PackInclude = {
      meta: false,
      questions: false,
      dataSlots: false,
      definitions: false,
      setup: false,
      setupTechnical: false,
      evaluations: false,
      conditionalTopics: false,
      interviewerPolicy: false,
    };
    const model = buildPackModel(
      'Bare Pack',
      graphOf([]),
      DATA_SLOTS,
      GLOSSARY,
      null,
      null,
      null,
      include,
      '2026-08-10T00:00:00.000Z'
    );

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the empty-state lines for zero data slots and zero sections', async () => {
    const model = buildPackModel(
      'Empty Pack',
      graphOf([]),
      [],
      GLOSSARY,
      null,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.dataSlots).toEqual([]);
    expect(model.sections).toEqual([]);

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a section with a description-less, question-less section (falls back to "(no questions)")', async () => {
    const sections: SectionView[] = [
      { id: 's1', ordinal: 0, title: 'Untitled section', description: null, questions: [] },
    ];
    const model = buildPackModel(
      'Sparse Pack',
      graphOf(sections),
      DATA_SLOTS,
      null,
      null,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.glossary).toBeNull();

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a question with no constraint, options, or guidance (free_text)', async () => {
    const sections: SectionView[] = [
      {
        id: 's1',
        ordinal: 0,
        title: 'Open feedback',
        description: null,
        questions: [question({ key: 'q1', type: 'free_text' })],
      },
    ];
    const model = buildPackModel(
      'Minimal Question Pack',
      graphOf(sections),
      [],
      null,
      null,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      '2026-08-10T00:00:00.000Z'
    );

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the "no evaluation run yet" state when evaluations is included but no run exists', async () => {
    const model = buildPackModel(
      'Unevaluated Pack',
      graphOf([]),
      [],
      null,
      null,
      null,
      null,
      { ...DEFAULT_PACK_INCLUDE, evaluations: true },
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.evaluations).toEqual({
      hasRun: false,
      runAt: null,
      totalFindings: 0,
      scores: [],
      targets: [],
    });

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders "not enabled" for Conditional topics when the version never turned it on', async () => {
    const model = buildPackModel(
      'Unrouted Pack',
      graphOf([]),
      [],
      null,
      null,
      {
        topics: [],
        settings: { ...SCOPE_SETTINGS, enabled: false, rules: [] },
        scopeEvaluationRun: null,
      },
      null,
      { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.conditionalTopics?.enabled).toBe(false);

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the "none defined" state for Conditional topics with no topics or rules', async () => {
    const model = buildPackModel(
      'Enabled But Empty Pack',
      graphOf([]),
      [],
      null,
      null,
      { topics: [], settings: { ...SCOPE_SETTINGS, rules: [] }, scopeEvaluationRun: null },
      null,
      { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.conditionalTopics).toMatchObject({
      enabled: true,
      alwaysAsked: [],
      conditional: [],
      rules: [],
    });

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the "no scope evaluation run yet" state when conditionalTopics is included but no run exists', async () => {
    const model = buildPackModel(
      'Unscored Pack',
      graphOf([]),
      [],
      null,
      null,
      { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
      null,
      { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.conditionalTopics?.evaluation).toEqual({
      hasRun: false,
      runAt: null,
      totalFindings: 0,
      scores: [],
      targets: [],
    });

    const pdf = await renderPackPdf(model);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);
});
