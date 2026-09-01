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
  type PackEvaluations,
  type PackEvaluationTarget,
  type PackInclude,
  type PackInterviewerPolicy,
  type PackModel,
  type PackPolicyEvaluation,
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
  sectionTitles: [],
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
      destination: null,
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
        routingReach: null,
        topicLabel: null,
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
      destination: null,
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
        routingReach: null,
        topicLabel: null,
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
      evaluationVerdicts: true,
      evaluationJudgeDetail: true,
      evaluationRewordings: true,
      evaluationEvidence: true,
      conditionalTopics: false,
      conditionalTopicsMembers: true,
      conditionalTopicsEvaluation: true,
      conditionalTopicsTechnical: true,
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

  it('actually puts the interviewer section in the PDF when it is included', async () => {
    // Not a smoke test. The PDF serialiser carried NO interviewer section at all while the model
    // built one and the other two serialisers rendered it, so an admin who ticked the box got it in
    // Markdown and CSV and silence in the format the pack is mostly downloaded as. A
    // "starts with %PDF" assertion passed throughout.
    //
    // Byte length is the assertion available here (react-pdf hands back a buffer, not a tree), and
    // it is enough: the same model with the section excluded must produce a smaller document. A
    // section that renders nothing produces two identical sizes, which is exactly the bug.
    const modelWith = (interviewerPolicy: boolean) =>
      buildPackModel(
        'Interviewer Pack',
        graphOf([]),
        [],
        null,
        null,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, interviewerPolicy },
        '2026-08-10T00:00:00.000Z'
      );

    const withSection = modelWith(true);
    const withoutSection = modelWith(false);

    expect(withSection.interviewerPolicy).not.toBeNull();
    expect(withoutSection.interviewerPolicy).toBeNull();

    const [included, excluded] = await Promise.all([
      renderPackPdf(withSection),
      renderPackPdf(withoutSection),
    ]);

    expect(startsWithPdfMagic(included)).toBe(true);
    expect(included.byteLength).toBeGreaterThan(excluded.byteLength);
  }, 30000);

  it('renders the "no routing review yet" state when conditionalTopics is included but no run exists', async () => {
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

/* -------------------------------------------------------------------------- */
/* Populated appendices                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The tests above all reach the document through `buildPackModel`, which means every optional
 * branch inside a populated appendix — a house rule with a trigger, an arc band, a judge with a
 * structured edit, a verdict with dissent — renders only if a graph config happens to produce one.
 * In practice none did: the interviewer and evaluation blocks rendered empty in every case, so the
 * "does it throw" guarantee covered the headings and almost nothing under them.
 *
 * These build the {@link PackModel} directly, the way the Markdown and CSV suites do, so each
 * branch is exercised deliberately. Still structural assertions (react-pdf returns a binary
 * buffer); content-level behaviour is asserted at the `buildPackModel` and serialiser layers.
 */
describe('renderPackPdf — populated appendices', () => {
  /** A model with everything null but the sections under test. */
  function packModel(over: Partial<PackModel>): PackModel {
    return {
      title: 'Populated Pack',
      versionNumber: 1,
      generatedAt: '2026-08-10T00:00:00.000Z',
      include: DEFAULT_PACK_INCLUDE,
      meta: null,
      sections: null,
      sectionCount: 0,
      questionCount: 0,
      dataSlots: null,
      glossary: null,
      setup: null,
      evaluations: null,
      conditionalTopics: null,
      interviewerPolicy: null,
      ...over,
    };
  }

  const POLICY_EVALUATION: PackPolicyEvaluation = {
    hasRun: true,
    runAt: '2026-08-11T00:00:00.000Z',
    totalFindings: 2,
    scores: [
      {
        dimension: 'rule_coherence',
        label: 'Rule-Coherence Judge',
        score: 0.82,
        diagnostic: null,
        findingCount: 1,
      },
      // A judge that failed, so the "unavailable: <diagnostic>" branch renders too.
      {
        dimension: 'arc_fit',
        label: 'Arc-Fit Judge',
        score: null,
        diagnostic: 'provider timed out',
        findingCount: 0,
      },
    ],
    targets: [
      {
        key: 'rule-1',
        kind: 'house_rule',
        label: 'Never use humour.',
        removed: false,
        counts: { major: 1, minor: 0, info: 0, total: 1 },
        judges: [
          {
            dimension: 'rule_coherence',
            label: 'Rule-Coherence Judge',
            severity: 'major',
            status: 'pending',
            proposedChange: 'Narrow this rule.',
            rationale: 'It contradicts the always-rule above it.',
            sourceQuote: null,
            proposedEditSummary: 'Set the rule text to "Avoid jokes about the company."',
          },
        ],
      },
      {
        // A subject the author has since deleted — the "no longer part of the interviewer setup"
        // branch, and a judge with no structured edit beside it.
        key: 'rule-2',
        kind: 'house_rule',
        label: 'A rule that no longer exists',
        removed: true,
        counts: { major: 0, minor: 1, info: 0, total: 1 },
        judges: [
          {
            dimension: 'arc_fit',
            label: 'Arc-Fit Judge',
            severity: 'minor',
            status: 'declined',
            proposedChange: 'Drop it.',
            rationale: 'Already gone.',
            sourceQuote: null,
            proposedEditSummary: null,
          },
        ],
      },
    ],
  };

  function policy(over: Partial<PackInterviewerPolicy> = {}): PackInterviewerPolicy {
    return {
      conversational: true,
      houseRulesEnabled: true,
      houseRules: [
        { kind: 'Never', text: 'Never use humour.', trigger: null },
        // The if-asked branch, which is the only one that renders a trigger line.
        { kind: 'If asked', text: 'Say who reads the answers.', trigger: 'privacy' },
      ],
      approachLabel: 'Funnel',
      paceLabel: 'Brisk',
      openingSource: 'Guided by the examples you wrote',
      tacticLabels: ['Probes shallow answers', 'Reflects answers back'],
      arcBands: [{ label: 'Opening third', detail: 'Broad, one follow-up per answer.' }],
      fidelityEnabled: true,
      fidelityDistribution: [
        { level: 'must_ask', label: 'Word for word', count: 2 },
        // A zero-count level, which the renderer filters out rather than printing as "0".
        { level: 'creative', label: 'Fill creatively', count: 0 },
      ],
      mustAskQuestions: [{ key: 'q1', prompt: 'Do you consent to this interview being recorded?' }],
      evaluation: POLICY_EVALUATION,
      ...over,
    };
  }

  it('renders a fully populated interviewer section', async () => {
    const pdf = await renderPackPdf(packModel({ interviewerPolicy: policy() }));
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the form-only interviewer state, where none of the settings apply', async () => {
    // `conversational: false` short-circuits every settings block but still renders the review.
    const pdf = await renderPackPdf(
      packModel({ interviewerPolicy: policy({ conversational: false }) })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the interviewer section with nothing in force and nothing reviewed', async () => {
    // The other side of every branch above: no house rules, no arc, fidelity off, no run.
    const pdf = await renderPackPdf(
      packModel({
        interviewerPolicy: policy({
          houseRulesEnabled: false,
          houseRules: [],
          paceLabel: null,
          tacticLabels: [],
          arcBands: [],
          fidelityEnabled: false,
          fidelityDistribution: [],
          mustAskQuestions: [],
          evaluation: { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] },
        }),
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a reviewed interviewer setup that raised no findings', async () => {
    const pdf = await renderPackPdf(
      packModel({
        interviewerPolicy: policy({
          evaluation: { ...POLICY_EVALUATION, totalFindings: 0, targets: [] },
        }),
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a topic that carries a document trigger and its member questions', async () => {
    // Both are new to the topic block and neither is reachable from a graph fixture: a trigger is
    // authored by the Routing Analyst, and membership only renders behind its own sub-option.
    const pdf = await renderPackPdf(
      packModel({
        include: {
          ...DEFAULT_PACK_INCLUDE,
          conditionalTopics: true,
          conditionalTopicsMembers: true,
        },
        conditionalTopics: {
          enabled: true,
          alwaysAsked: [],
          conditional: [
            {
              key: 'safeguarding',
              label: 'Safeguarding',
              description: null,
              alwaysAsked: false,
              criteria: 'The opening suggests vulnerability.',
              sampledOnly: true,
              questions: [{ key: 'q9', prompt: 'Is there anything you would like us to know?' }],
              trigger: {
                condition: 'The applicant discloses that they are fleeing abuse',
                cues: ['abuse', 'fleeing'],
              },
            },
          ],
          rules: [
            { sentence: 'Always include "Safeguarding" when "housing status" is "at risk".' },
          ],
          settings: [{ label: 'Interview length', value: '10m' }],
          evaluation: { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] },
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  /* -- The evaluation appendix's own branches -------------------------------- */

  const CONTESTED_TARGET: PackEvaluationTarget = {
    key: 'q1',
    context: 'Q1 · Onboarding',
    label: 'How satisfied are you with our onboarding?',
    questionType: 'single_choice',
    routingReach: 'Asked when it fits',
    topicLabel: 'Onboarding experience',
    verdict: {
      contested: true,
      blocks: [
        {
          heading: 'A reword',
          backing: '2 of 3 judges',
          judges: 'Clarity, Audience-Match',
          holdsWording: true,
          suggestions: ['Reword to avoid the leading adjective.'],
        },
        {
          heading: 'A deletion',
          backing: '1 of 3 judges',
          judges: 'Duplicates',
          holdsWording: false,
          suggestions: ['Remove it, Q2 already covers this ground.'],
        },
      ],
    },
    gap: false,
    removed: false,
    counts: { major: 1, minor: 2, info: 0, total: 3 },
    judgeCount: 3,
    alternatives: [
      {
        prompt: 'How did you find your first two weeks?',
        addresses: ['Clarity Judge'],
        note: 'Names the period concretely.',
      },
    ],
    unresolvedBy: ['Duplicates Judge'],
    judges: [
      {
        dimension: 'clarity',
        label: 'Clarity Judge',
        severity: 'minor',
        status: 'pending',
        proposedChange: 'Reword to avoid the leading adjective.',
        rationale: '"Satisfied" presupposes a positive frame.',
        sourceQuote: 'How satisfied are you',
        proposedEditSummary: "Replaces this question's wording with the suggested version.",
        destination: null,
        applyInstruction: 'Keep it under fifteen words.',
      },
      {
        // A drafted question: the only judge line that carries a destination sentence.
        dimension: 'coverage',
        label: 'Coverage Judge',
        severity: 'info',
        status: 'accepted',
        proposedChange: 'Add a question on manager support.',
        rationale: 'The goal names it and nothing asks about it.',
        sourceQuote: null,
        proposedEditSummary: 'Adds this as a new Free text question at the end of "Wrap-up".',
        destination: 'No section was suggested, so it would go at the end of "Wrap-up".',
        applyInstruction: null,
      },
    ],
  };

  function evaluations(targets: PackEvaluationTarget[]): PackEvaluations {
    return {
      hasRun: true,
      runAt: '2026-08-30T09:12:44.118Z',
      totalFindings: 3,
      scores: [
        {
          dimension: 'clarity',
          label: 'Clarity Judge',
          score: 0.62,
          diagnostic: null,
          findingCount: 1,
        },
      ],
      targets,
    };
  }

  it('renders a contested target with its verdict, wordings and every judge', async () => {
    const pdf = await renderPackPdf(
      packModel({
        include: {
          ...DEFAULT_PACK_INCLUDE,
          evaluations: true,
          evaluationJudgeDetail: true,
          evaluationEvidence: true,
        },
        evaluations: evaluations([CONTESTED_TARGET]),
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the same target with the verdict off, so the wordings stand alone', async () => {
    // The fallback path: no verdict block to host them, so they render after the judges instead.
    const pdf = await renderPackPdf(
      packModel({
        include: { ...DEFAULT_PACK_INCLUDE, evaluations: true, evaluationVerdicts: false },
        evaluations: evaluations([CONTESTED_TARGET]),
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a bare target — no context, no type, no routing, nothing reconciled', async () => {
    // Every optional field on the other side of its branch, plus `removed`, which is the only
    // thing that makes the "no longer in the questionnaire" note render.
    const pdf = await renderPackPdf(
      packModel({
        include: { ...DEFAULT_PACK_INCLUDE, evaluations: true, evaluationJudgeDetail: true },
        evaluations: evaluations([
          {
            ...CONTESTED_TARGET,
            context: null,
            questionType: null,
            routingReach: null,
            topicLabel: null,
            verdict: null,
            removed: true,
            counts: { major: 0, minor: 1, info: 0, total: 1 },
            judgeCount: 1,
            alternatives: [],
            unresolvedBy: [],
            judges: [
              {
                ...CONTESTED_TARGET.judges[0],
                sourceQuote: null,
                proposedEditSummary: null,
                destination: null,
                applyInstruction: null,
              },
            ],
          },
        ]),
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);
});
