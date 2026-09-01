/**
 * build-pack-model — unit tests for the Questionnaire Pack export model.
 *
 * Pins: each `PackInclude` flag nulling out its own section (and no others), data-slot
 * `questionKeys` resolving to `{ key, prompt }` pairs against the graph (falling back to the bare
 * key when a question was deleted), the experience-setup summary deriving from the settings
 * registry (grouped rows, the technical tier behind `setupTechnical`, nested blocks expanding, inert
 * settings skipped), that meta/section/question fields are exactly what `buildInstrumentModel` would
 * produce (reused, not re-derived), and the evaluations appendix — all seven dimensions present in
 * `EVALUATION_DIMENSIONS` order, findings grouped per dimension with `pending` ones included, and
 * the `hasRun: false` shape when no run was passed in.
 *
 * @see lib/app/questionnaire/export/build-pack-model.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildPackModel,
  DEFAULT_PACK_INCLUDE,
  type PackInclude,
} from '@/lib/app/questionnaire/export/build-pack-model';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { SETTING_GROUPS } from '@/lib/app/questionnaire/settings-registry';
import type {
  VersionGraphView,
  SectionView,
  QuestionSlotView,
  EvaluationRunDetail,
  ScopeEvaluationRunDetail,
  PolicyEvaluationRunDetail,
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
    versionNumber: 4,
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

const SECTIONS: SectionView[] = [
  {
    id: 's1',
    ordinal: 0,
    title: 'Background',
    description: null,
    questions: [
      question({ key: 'q1', type: 'free_text' }),
      question({ key: 'q2', type: 'free_text' }),
    ],
  },
];

const DATA_SLOTS: DataSlotView[] = [
  {
    id: 'ds1',
    key: 'engagement',
    name: 'Engagement',
    description: 'How engaged the respondent feels',
    theme: 'Culture',
    ordinal: 0,
    weight: 1,
    questionKeys: ['q1', 'q2', 'deleted-question'],
  },
];

const GLOSSARY: GlossaryAppendixView = {
  heading: 'Definitions',
  entries: [{ term: 'Engagement', definitions: ['How committed a respondent feels'] }],
};

const EVALUATION_RUN: EvaluationRunDetail = {
  sectionTitles: [],
  id: 'run1',
  versionId: 'v1',
  questionnaireId: 'q1',
  status: 'partial',
  dimensionsRequested: 7,
  dimensionsRun: 6,
  dimensionsFailed: 1,
  totalFindings: 2,
  dimensionSummary: [
    { dimension: 'clarity', score: 0.4, findingCount: 1, diagnostic: null },
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
        questionType: 'free_text',
        routingReach: null,
        topicLabel: null,
        removed: false,
      },
      severity: 'major',
      proposedChange: 'Split into two questions',
      rationale: 'This question asks two things at once',
      sourceQuote: 'both engaged and satisfied',
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
    {
      destination: null,
      id: 'f2',
      dimension: 'duplicates',
      ordinal: 0,
      targetKey: 'deleted-question',
      target: null,
      severity: 'minor',
      proposedChange: 'Merge with q1',
      rationale: 'Covers the same ground',
      sourceQuote: null,
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
    // A SECOND judge on q1. The whole point of the by-target shape is that this does not
    // reprint the question — q1 appears once, with two verdicts under it.
    {
      destination: null,
      id: 'f3',
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
        questionType: 'free_text',
        routingReach: null,
        topicLabel: null,
        removed: false,
      },
      severity: 'minor',
      proposedChange: 'Drop the jargon for a non-technical audience',
      rationale: 'The stated audience would not know the term',
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
  ],
};

const SCOPE_TOPICS: Topic[] = [
  {
    id: 'top-opening',
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
    id: 'top-conditional',
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
    id: 'top-check',
    key: 'compliance-check',
    label: 'Compliance blind-spot check',
    description: null,
    phase: 'conditional',
    criteria: 'Sampled when nothing else pointed at compliance.',
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
      id: 'rule-include',
      dataSlotKey: 'engagement',
      operator: 'gt',
      value: '50',
      action: 'include',
      topicKey: 'talent',
      ordinal: 0,
    },
    {
      id: 'rule-exclude',
      dataSlotKey: 'engagement',
      operator: 'not_exists',
      value: null,
      action: 'exclude',
      topicKey: 'compliance-check',
      ordinal: 1,
    },
    {
      id: 'rule-orphan',
      dataSlotKey: 'deleted-slot',
      operator: 'exists',
      value: null,
      action: 'include',
      topicKey: 'deleted-topic',
      ordinal: 2,
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
  totalFindings: 2,
  dimensionSummary: [
    { dimension: 'criteria_quality', score: 0.7, findingCount: 1, diagnostic: null },
    { dimension: 'budget_realism', score: null, findingCount: 0, diagnostic: 'judge_error' },
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
    // A second, prose-only finding on the same target — exercises `judgeCount`/grouping and the
    // `proposedEditSummary: null` branch for a finding with no structured op.
    {
      id: 'sf2',
      dimension: 'criteria_quality',
      ordinal: 1,
      targetKey: 'topic:talent',
      target: { kind: 'topic', key: 'talent', label: 'Talent & culture', removed: false },
      severity: 'minor',
      proposedChange: 'Consider splitting this into two narrower topics',
      rationale: 'It currently covers both hiring and retention concerns',
      sourceQuote: null,
      status: 'declined',
      proposedEdit: null,
      editedOverride: null,
      decidedByUserId: 'admin-1',
      decidedAt: '2026-08-10T00:01:00.000Z',
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'manual',
    },
  ],
};

describe('buildPackModel', () => {
  it('includes every default-on section, but not evaluations, by default', () => {
    const model = buildPackModel(
      'Pulse Survey',
      graphOf(SECTIONS),
      DATA_SLOTS,
      GLOSSARY,
      EVALUATION_RUN,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      '2026-08-10T00:00:00.000Z'
    );

    expect(model.title).toBe('Pulse Survey');
    expect(model.versionNumber).toBe(4);
    expect(model.meta).not.toBeNull();
    expect(model.sections).not.toBeNull();
    expect(model.dataSlots).not.toBeNull();
    expect(model.glossary).toBe(GLOSSARY);
    expect(model.setup).not.toBeNull();
    // evaluations defaults off even when a run is available — the caller must opt in.
    expect(model.evaluations).toBeNull();
  });

  it('nulls out only the excluded sections', () => {
    const include: PackInclude = {
      meta: false,
      questions: true,
      dataSlots: false,
      definitions: true,
      setup: false,
      setupTechnical: false,
      evaluations: false,
      conditionalTopics: false,
      interviewerPolicy: false,
    };
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      GLOSSARY,
      null,
      null,
      null,
      include,
      'now'
    );

    expect(model.meta).toBeNull();
    expect(model.dataSlots).toBeNull();
    expect(model.setup).toBeNull();
    expect(model.sections).not.toBeNull();
    expect(model.glossary).toBe(GLOSSARY);
  });

  it('carries sectionCount/questionCount regardless of the questions include flag', () => {
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      null,
      null,
      null,
      null,
      { ...DEFAULT_PACK_INCLUDE, questions: false },
      'now'
    );
    expect(model.sections).toBeNull();
    expect(model.sectionCount).toBe(1);
    expect(model.questionCount).toBe(2);
  });

  it('resolves data-slot questionKeys to prompts, falling back to the bare key when unresolved', () => {
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      null,
      null,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      'now'
    );
    const slot = model.dataSlots?.[0];
    expect(slot?.questions).toEqual([
      { key: 'q1', prompt: 'Prompt for q1' },
      { key: 'q2', prompt: 'Prompt for q2' },
      { key: 'deleted-question', prompt: 'deleted-question' },
    ]);
  });

  it('passes through data slot key/name/description/theme/weight unchanged', () => {
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      null,
      null,
      null,
      null,
      DEFAULT_PACK_INCLUDE,
      'now'
    );
    const slot = model.dataSlots?.[0];
    expect(slot).toMatchObject({
      key: 'engagement',
      name: 'Engagement',
      description: 'How engaged the respondent feels',
      theme: 'Culture',
      weight: 1,
    });
  });

  it('nulls glossary when definitions is excluded, even if a glossary appendix was passed', () => {
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      GLOSSARY,
      null,
      null,
      null,
      { ...DEFAULT_PACK_INCLUDE, definitions: false },
      'now'
    );
    expect(model.glossary).toBeNull();
  });

  describe('experience-setup summary', () => {
    /** Build a model and index its setup rows by label. */
    function setupOf(
      configOverrides: Partial<typeof DEFAULT_QUESTIONNAIRE_CONFIG> = {},
      include: PackInclude = DEFAULT_PACK_INCLUDE
    ) {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS, configOverrides),
        [],
        null,
        null,
        null,
        null,
        include,
        'now'
      );
      const rows = model.setup ?? [];
      return { rows, byLabel: new Map(rows.map((item) => [item.label, item.value])) };
    }

    it('reads friendly labels for access mode and on/off flags', () => {
      const { byLabel } = setupOf({
        accessMode: 'public',
        voiceEnabled: true,
        attachmentsEnabled: false,
      });
      expect(byLabel.get('Access')).toBe('Public link');
      expect(byLabel.get('Voice input')).toBe('Enabled');
      expect(byLabel.get('File attachments')).toBe('Disabled');
    });

    it('derives from the registry, so settings added after the original ten are present', () => {
      // The three that shipped with the progress/milestone work — the drift that motivated the
      // registry. They must be in the pack without anyone editing a curated list.
      const { byLabel } = setupOf({
        showProgressPercentText: false,
        milestoneBannerEnabled: true,
        milestoneBannerThresholds: [30, 60],
      });
      expect(byLabel.get('Progress percentage shown')).toBe('No');
      expect(byLabel.get('Completeness milestone banners')).toBe('Enabled');
      expect(byLabel.get('Milestone thresholds')).toBe('30%, 60%');
    });

    it('stamps every row with a group, and emits groups in SETTING_GROUPS order', () => {
      const { rows } = setupOf();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(SETTING_GROUPS).toContain(row.group);

      // Each group appears as one contiguous run, ordered by SETTING_GROUPS.
      const order = rows.map((row) => SETTING_GROUPS.indexOf(row.group));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('omits the technical tier by default and includes it on opt-in', () => {
      const standard = setupOf();
      expect(standard.byLabel.has('Cost budget per session')).toBe(false);
      expect(standard.byLabel.has('Answer confirmation floor')).toBe(false);
      // The long-standing guarantee: no tuning vocabulary in a client-facing pack.
      expect(standard.rows.map((r) => r.label).join(' ')).not.toMatch(
        /confidence|budget|coverage/i
      );

      const technical = setupOf({}, { ...DEFAULT_PACK_INCLUDE, setupTechnical: true });
      expect(technical.byLabel.get('Cost budget per session')).toBe('No limit');
      expect(technical.byLabel.get('Answer confirmation floor')).toBe('50%');
      expect(technical.rows.length).toBeGreaterThan(standard.rows.length);
      // Opting in ADDS rows; it never changes or drops a standard one.
      for (const [label, value] of standard.byLabel) {
        expect(technical.byLabel.get(label)).toBe(value);
      }
    });

    it('expands a nested settings block into one row per meaningful setting', () => {
      const off = setupOf();
      expect(off.byLabel.get('Respondent report')).toBe('Disabled');
      // Disabled ⇒ the block contributes its master toggle and nothing else.
      expect(off.byLabel.has('Report style')).toBe(false);

      const on = setupOf({
        respondentReport: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
          enabled: true,
          mode: 'narrative',
        },
      });
      expect(on.byLabel.get('Respondent report')).toBe('Enabled');
      expect(on.byLabel.get('Report style')).toBe('Woven narrative');
      expect(on.byLabel.get('Narrative style')).toBe('Flowing prose');
      expect(on.byLabel.get('Report delivery')).toBe('On the completion screen, PDF download');
      // `narrative` has no separate raw section to describe.
      expect(on.byLabel.has('Report shows')).toBe(false);
    });

    it('skips settings made inert by the rest of the config', () => {
      // Milestone thresholds say nothing while the banners are off.
      expect(setupOf({ milestoneBannerEnabled: false }).byLabel.has('Milestone thresholds')).toBe(
        false
      );
      // A built-in persona replaces the version tone, so listing custom dials would misdescribe it.
      const withPersona = setupOf({
        personaSelection: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection,
          enabled: true,
        },
      });
      expect(withPersona.byLabel.has('Interviewer tone')).toBe(false);
      // Nobody is invited on a public-only link.
      expect(setupOf({ accessMode: 'public' }).byLabel.has('Invitee details collected')).toBe(
        false
      );
    });
  });

  describe('evaluations appendix', () => {
    it('is null when excluded, even if a run was passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: false },
        'now'
      );
      expect(model.evaluations).toBeNull();
    });

    it('reports hasRun: false with no dimensions when included but no run was passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations).toEqual({
        hasRun: false,
        runAt: null,
        totalFindings: 0,
        scores: [],
        targets: [],
      });
    });

    it('carries all seven judge scores, in EVALUATION_DIMENSIONS order, even ones the run never mentions', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.scores.map((d) => d.dimension)).toEqual([
        'clarity',
        'coverage',
        'duplicates',
        'type_fit',
        'ordering',
        'audience_match',
        'goal_match',
      ]);
    });

    it('reads score/diagnostic from the run dimensionSummary, and n/a-scoring for a dimension absent from it', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const byDimension = new Map(model.evaluations?.scores.map((d) => [d.dimension, d]));
      expect(byDimension.get('clarity')).toMatchObject({
        label: 'Clarity Judge',
        score: 0.4,
        diagnostic: null,
        findingCount: 1,
      });
      expect(byDimension.get('coverage')).toMatchObject({ score: null, diagnostic: 'judge_error' });
      // `duplicates` has a finding but no dimensionSummary entry in the fixture — still n/a, not 0.
      expect(byDimension.get('duplicates')).toMatchObject({ score: null, diagnostic: null });
    });

    it('carries no findings on the scoreboard — they belong to the target they are about', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      // A score line is a tally, not a place findings are printed a second time.
      for (const score of model.evaluations?.scores ?? []) {
        expect(score).not.toHaveProperty('findings');
      }
    });

    it('names a contested question ONCE, with every judge that flagged it beneath it', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      // Two judges flagged q1 (clarity + audience_match). Grouped by judge that printed the
      // question twice; grouped by target it is one entry carrying both verdicts.
      const q1 = model.evaluations?.targets.filter((t) => t.key === 'q1') ?? [];
      expect(q1).toHaveLength(1);
      expect(q1[0]).toMatchObject({
        label: 'Prompt for q1',
        context: 'Q1 · Background',
        questionType: 'free_text',
        counts: { major: 1, minor: 1, info: 0, total: 2 },
      });
      expect(q1[0].judges.map((j) => j.dimension)).toEqual(['clarity', 'audience_match']);
      expect(q1[0].judges.map((j) => j.label)).toEqual(['Clarity Judge', 'Audience-Match Judge']);
      expect(q1[0].judgeCount).toBe(2);
    });

    it('counts distinct judges, not findings, when one judge raises two points', () => {
      // `judges` is one entry per finding — render them all — but the serialisers print
      // "N judge(s)" from it, and one judge raising two points is one perspective. Counting
      // findings there overstates the consensus the admin is being asked to act on.
      const twice = {
        ...EVALUATION_RUN,
        findings: [
          ...EVALUATION_RUN.findings,
          {
            ...EVALUATION_RUN.findings[0],
            id: 'f4',
            ordinal: 1,
            proposedChange: 'Also drop the leading clause',
            rationale: 'A second, separate clarity point about the same question',
          },
        ],
      };

      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        twice,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );

      const q1 = model.evaluations?.targets.find((t) => t.key === 'q1');
      expect(q1?.judges).toHaveLength(3);
      expect(q1?.judgeCount).toBe(2);
    });

    it('carries each judge view whole — suggestion, rationale, quote, severity and review status', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const q1 = model.evaluations?.targets.find((t) => t.key === 'q1');
      expect(q1?.judges[0]).toEqual({
        dimension: 'clarity',
        label: 'Clarity Judge',
        severity: 'major',
        status: 'pending',
        proposedChange: 'Split into two questions',
        rationale: 'This question asks two things at once',
        sourceQuote: 'both engaged and satisfied',
      });
    });

    it('falls back to the raw targetKey when the target could not be resolved', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      // f2 addresses a question that no longer resolves — it still gets its own group rather
      // than being dropped, labelled with the key so the reader can see what was meant.
      const orphan = model.evaluations?.targets.find((t) => t.key === 'deleted-question');
      expect(orphan).toMatchObject({ label: 'deleted-question', questionType: null });
      expect(orphan?.judges.map((j) => j.dimension)).toEqual(['duplicates']);
    });

    it('attaches the reconciled alternatives to the question they are about', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const q1 = model.evaluations?.targets.find((t) => t.key === 'q1');
      expect(q1?.alternatives).toHaveLength(1);
      expect(q1?.alternatives[0].prompt).toBe('How would you describe your role?');
      // Dimension keys are resolved to judge labels: a pack is read by people who never learn
      // the enum, and "clarity" alone does not say who is satisfied by this wording.
      expect(q1?.alternatives[0].addresses).toEqual(['Clarity Judge', 'Audience-Match Judge']);
      expect(q1?.unresolvedBy).toEqual(['Type-Fit Judge']);
    });

    it('leaves a target with no reconciliation carrying no alternatives', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      // The orphan target was flagged by one judge, so nothing was reconciled for it — it shows
      // that judge's own suggestion, exactly as before this step existed.
      const orphan = model.evaluations?.targets.find((t) => t.key === 'deleted-question');
      expect(orphan?.alternatives).toEqual([]);
      expect(orphan?.unresolvedBy).toEqual([]);
    });

    it('carries no alternatives at all for a run that predates reconciliation', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        { ...EVALUATION_RUN, reconciled: [] },
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.targets.every((t) => t.alternatives.length === 0)).toBe(true);
    });

    it('includes pending findings — the appendix is a record of the panel, not a curated review outcome', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const statuses = model.evaluations?.targets.flatMap((t) => t.judges.map((j) => j.status));
      expect(statuses).toContain('pending');
      expect(statuses).toContain('declined');
    });

    it('reports hasRun: true, runAt from completedAt, and totalFindings from the run', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.hasRun).toBe(true);
      expect(model.evaluations?.runAt).toBe('2026-08-10T00:00:05.000Z');
      // Read straight off the run row, not recounted from `findings` — the pack reports what
      // the run recorded.
      expect(model.evaluations?.totalFindings).toBe(2);
    });

    it('falls back runAt to startedAt when the run has no completedAt', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        { ...EVALUATION_RUN, completedAt: null },
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.runAt).toBe('2026-08-10T00:00:00.000Z');
    });
  });

  describe('conditional topics appendix', () => {
    it('is null when excluded, even if topics/settings were passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: false },
        'now'
      );
      expect(model.conditionalTopics).toBeNull();
    });

    it('is null when included but no source was passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        null,
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics).toBeNull();
    });

    it('carries enabled/maxConditionalTopics/includeCheckTopic/sessionBudgetSeconds straight off the settings', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics).toMatchObject({
        enabled: true,
        maxConditionalTopics: 3,
        includeCheckTopic: true,
        sessionBudgetSeconds: 600,
      });
    });

    it('reports enabled: false when the version never turned it on, without dropping the topic lists', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        {
          topics: SCOPE_TOPICS,
          settings: { ...SCOPE_SETTINGS, enabled: false },
          scopeEvaluationRun: null,
        },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.enabled).toBe(false);
      expect(model.conditionalTopics?.alwaysAsked).toHaveLength(1);
      expect(model.conditionalTopics?.conditional).toHaveLength(2);
    });

    it('splits topics into always-asked (opening/core/closing) vs conditional, in authored order', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.alwaysAsked.map((t) => t.key)).toEqual(['background']);
      expect(model.conditionalTopics?.conditional.map((t) => t.key)).toEqual([
        'talent',
        'compliance-check',
      ]);
    });

    it('carries criteria only for conditional topics, never for an always-asked one', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.alwaysAsked[0].criteria).toBeNull();
      expect(model.conditionalTopics?.conditional[0].criteria).toBe(
        'The respondent mentions hiring difficulty or turnover.'
      );
    });

    it('flags sampledOnly for a light-depth topic and not for a full-depth one', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      const talent = model.conditionalTopics?.conditional.find((t) => t.key === 'talent');
      const check = model.conditionalTopics?.conditional.find((t) => t.key === 'compliance-check');
      expect(talent?.sampledOnly).toBe(false);
      expect(check?.sampledOnly).toBe(true);
    });

    it('renders a hard rule with an operand as a plain sentence naming the topic and data-slot labels', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        DATA_SLOTS,
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.rules[0].sentence).toBe(
        'Always include "Talent & culture" when "Engagement" is greater than "50".'
      );
    });

    it('renders a valueless (not_exists) rule without a trailing operand', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        DATA_SLOTS,
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.rules[1].sentence).toBe(
        'Never include "Compliance blind-spot check" when "Engagement" was never answered.'
      );
    });

    it('falls back to the raw key when a rule points at a topic or data slot that no longer resolves', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        DATA_SLOTS,
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.rules[2].sentence).toBe(
        'Always include "deleted-topic" when "deleted-slot" has any answer.'
      );
    });

    it('produces empty topic/rule lists, not a crash, for a version with no topics or rules at all', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: [], settings: { ...SCOPE_SETTINGS, rules: [] }, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics).toMatchObject({
        alwaysAsked: [],
        conditional: [],
        rules: [],
      });
    });
  });

  describe('scope evaluation appendix (nested under conditional topics)', () => {
    it('reports hasRun: false with no scores/targets when included but no run was passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        { topics: SCOPE_TOPICS, settings: SCOPE_SETTINGS, scopeEvaluationRun: null },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.evaluation).toEqual({
        hasRun: false,
        runAt: null,
        totalFindings: 0,
        scores: [],
        targets: [],
      });
    });

    it('is absent (conditionalTopics itself is null) when the section is excluded, even with a run passed in', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        {
          topics: SCOPE_TOPICS,
          settings: SCOPE_SETTINGS,
          scopeEvaluationRun: SCOPE_EVALUATION_RUN,
        },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: false },
        'now'
      );
      expect(model.conditionalTopics).toBeNull();
    });

    it('carries all four judge scores, in SCOPE_EVALUATION_DIMENSIONS order, even ones the run never mentions', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        {
          topics: SCOPE_TOPICS,
          settings: SCOPE_SETTINGS,
          scopeEvaluationRun: SCOPE_EVALUATION_RUN,
        },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      expect(model.conditionalTopics?.evaluation.scores.map((d) => d.dimension)).toEqual([
        'criteria_quality',
        'rule_integrity',
        'budget_realism',
        'coverage_and_burden',
      ]);
      const byDimension = new Map(
        model.conditionalTopics?.evaluation.scores.map((d) => [d.dimension, d])
      );
      expect(byDimension.get('criteria_quality')).toMatchObject({
        label: 'Criteria-Quality Judge',
        score: 0.7,
        diagnostic: null,
        findingCount: 2,
      });
      expect(byDimension.get('budget_realism')).toMatchObject({
        score: null,
        diagnostic: 'judge_error',
      });
      // `rule_integrity` has no dimensionSummary entry in the fixture — n/a, not 0.
      expect(byDimension.get('rule_integrity')).toMatchObject({ score: null, diagnostic: null });
    });

    it('names a flagged topic ONCE, with both findings beneath it — one carrying a plain-English proposed edit', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        {
          topics: SCOPE_TOPICS,
          settings: SCOPE_SETTINGS,
          scopeEvaluationRun: SCOPE_EVALUATION_RUN,
        },
        null,
        { ...DEFAULT_PACK_INCLUDE, conditionalTopics: true },
        'now'
      );
      const targets = model.conditionalTopics?.evaluation.targets ?? [];
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        key: 'talent',
        kind: 'topic',
        label: 'Talent & culture',
        removed: false,
        counts: { major: 1, minor: 1, info: 0, total: 2 },
      });
      expect(targets[0].judges.map((j) => j.status)).toEqual(['pending', 'declined']);
      expect(targets[0].judges[0].proposedEditSummary).toBe('Rewrite the topic’s criteria');
      expect(targets[0].judges[1].proposedEditSummary).toBeNull();
    });
  });
});

/**
 * The interviewer-policy appendix (F18.8).
 *
 * Its own top-level include flag rather than a nest under `setup` — that section is a flat list
 * across ~15 groups and defaults ON, so nesting a judge's verdict there would attach a judgement to
 * twelve things it never read AND ship unreviewed AI critique into every default download.
 */
/**
 * A completed policy-evaluation run (F18.8) — two findings on ONE house rule, so the grouping is
 * exercised rather than assumed, and one dimension that failed rather than scored.
 */
const POLICY_EVALUATION_RUN: PolicyEvaluationRunDetail = {
  id: 'policy-run1',
  versionId: 'v1',
  questionnaireId: 'q1',
  status: 'partial',
  dimensionsRequested: 4,
  dimensionsRun: 3,
  dimensionsFailed: 1,
  totalFindings: 2,
  // Deliberately NOT one row per dimension: `cross_layer_conflict` is absent, which is how a run
  // that never reached a judge looks, and the pack must still print a row for it.
  dimensionSummary: [
    { dimension: 'rule_coherence', score: 0.7, findingCount: 2, diagnostic: null },
    { dimension: 'arc_fit', score: null, findingCount: 0, diagnostic: 'judge_error' },
    { dimension: 'fidelity_calibration', score: 0.9, findingCount: 0, diagnostic: null },
  ],
  triggeredByUserId: 'admin-1',
  error: null,
  startedAt: '2026-08-11T00:00:00.000Z',
  completedAt: '2026-08-11T00:00:05.000Z',
  createdAt: '2026-08-11T00:00:00.000Z',
  findings: [
    {
      id: 'pf1',
      dimension: 'rule_coherence',
      ordinal: 0,
      targetKey: 'house_rule:r1',
      target: { kind: 'house_rule', key: 'r1', label: 'Never use humour.', removed: false },
      severity: 'major',
      proposedChange: 'Narrow this rule so it does not contradict the always rule',
      rationale: 'As written it forbids the warmth the tone settings ask for',
      sourceQuote: null,
      status: 'pending',
      proposedEdit: {
        op: 'edit_house_rule',
        kind: 'never',
        text: 'Avoid jokes about the company.',
      },
      editedOverride: null,
      decidedByUserId: null,
      decidedAt: null,
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'apply',
    },
    // A second, prose-only finding on the SAME rule — pins the grouping and the
    // `proposedEditSummary: null` branch for a finding carrying no structured op.
    {
      id: 'pf2',
      dimension: 'rule_coherence',
      ordinal: 1,
      targetKey: 'house_rule:r1',
      target: { kind: 'house_rule', key: 'r1', label: 'Never use humour.', removed: false },
      severity: 'minor',
      proposedChange: 'Consider whether this rule is needed at all',
      rationale: 'The tone settings already cover register',
      sourceQuote: null,
      status: 'declined',
      proposedEdit: null,
      editedOverride: null,
      decidedByUserId: 'admin-1',
      decidedAt: '2026-08-11T00:01:00.000Z',
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'manual',
    },
  ],
};

describe('interviewer policy appendix', () => {
  const call = (
    include: Partial<typeof DEFAULT_PACK_INCLUDE>,
    configOverrides: Partial<typeof DEFAULT_QUESTIONNAIRE_CONFIG> = {},
    policyRun: PolicyEvaluationRunDetail | null = null,
    sections: SectionView[] = SECTIONS
  ) =>
    buildPackModel(
      'T',
      graphOf(sections, configOverrides),
      [],
      null,
      null,
      null,
      policyRun,
      { ...DEFAULT_PACK_INCLUDE, ...include },
      'now'
    );

  it('is null when excluded, and excluded is the default', () => {
    expect(DEFAULT_PACK_INCLUDE.interviewerPolicy).toBe(false);
    expect(call({}).interviewerPolicy).toBeNull();
  });

  it('renders the arc bands from the runtime’s own pace profile', () => {
    // The FunnelArcExplainer trick applied to the pack: a hard-coded band table that drifted would
    // be worse than none, because a reader has no reason to doubt it.
    const model = call(
      { interviewerPolicy: true },
      {
        interviewerStrategy: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
          enabled: true,
          approach: 'funnel',
          pace: 'brisk',
        },
      }
    );
    const bands = model.interviewerPolicy?.arcBands ?? [];
    expect(bands).toHaveLength(3);
    // `brisk` is openingWindow 1, openBelow 0.25, targetedAbove 0.55.
    expect(bands[0].detail).toContain('first 1 question');
    expect(bands[2].detail).toContain('55%');
  });

  it('renders no arc bands when no funnel is running', () => {
    const model = call(
      { interviewerPolicy: true },
      {
        interviewerStrategy: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
          enabled: true,
          approach: 'targeted',
        },
      }
    );
    expect(model.interviewerPolicy?.arcBands).toEqual([]);
    // And no pace is named, since the runtime does not read one here.
    expect(model.interviewerPolicy?.paceLabel).toBeNull();
  });

  it('prints only the rules actually in force — a parked rule is a draft', () => {
    const model = call(
      { interviewerPolicy: true },
      {
        houseRules: {
          enabled: true,
          rules: [
            { id: 'r1', kind: 'never', enabled: true, text: 'Never use humour.' },
            { id: 'r2', kind: 'always', enabled: false, text: 'A parked draft.' },
          ],
        },
      }
    );
    const rules = model.interviewerPolicy?.houseRules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].text).toBe('Never use humour.');
  });

  it('says a form-only questionnaire has no interviewer at all', () => {
    const model = call({ interviewerPolicy: true }, { presentationMode: 'form' });
    expect(model.interviewerPolicy?.conversational).toBe(false);
  });

  it('reports no fidelity distribution while the gate is off', () => {
    // With the gate off every question resolves to Balanced, so a distribution would describe a
    // dial that is not in force.
    const model = call({ interviewerPolicy: true });
    expect(model.interviewerPolicy?.fidelityEnabled).toBe(false);
    expect(model.interviewerPolicy?.fidelityDistribution).toEqual([]);
    expect(model.interviewerPolicy?.mustAskQuestions).toEqual([]);
  });

  it('states that the panel has not run rather than omitting the section', () => {
    const model = call({ interviewerPolicy: true });
    expect(model.interviewerPolicy?.evaluation).toMatchObject({
      hasRun: false,
      totalFindings: 0,
      scores: [],
      targets: [],
    });
  });

  it('names the tactics that are on, and only those', () => {
    const model = call(
      { interviewerPolicy: true },
      {
        interviewerStrategy: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
          enabled: true,
          probeDepth: true,
          reflect: false,
          batchRelated: true,
        },
      }
    );
    // A tactic that is off is absent, not present-and-false — the pack is prose, and "Reflects
    // answers back: no" would read as a promise the interviewer never made.
    expect(model.interviewerPolicy?.tacticLabels).toEqual([
      'Probes shallow answers',
      'Invites related gaps together',
    ]);
  });

  it('counts every question by level and lists the word-for-word ones once the gate is on', () => {
    const model = call(
      { interviewerPolicy: true },
      {
        questionFidelity: { ...DEFAULT_QUESTIONNAIRE_CONFIG.questionFidelity, enabled: true },
      },
      null,
      [
        {
          id: 's1',
          ordinal: 0,
          title: 'Background',
          description: null,
          questions: [
            question({ key: 'q1', type: 'free_text', fidelity: 1, prompt: 'Ask this verbatim' }),
            question({ key: 'q2', type: 'free_text', fidelity: 1, prompt: 'And this one' }),
            question({ key: 'q3', type: 'free_text', fidelity: 0.5 }),
          ],
        },
      ]
    );
    const policy = model.interviewerPolicy;
    expect(policy?.fidelityEnabled).toBe(true);
    // Every level appears, including the ones nobody used — the renderers decide what to hide,
    // the model states the whole distribution.
    const counts = Object.fromEntries(
      (policy?.fidelityDistribution ?? []).map((d) => [d.level, d.count])
    );
    expect(counts).toMatchObject({ must_ask: 2, balanced: 1, free: 0, loose: 0, close: 0 });
    expect(policy?.mustAskQuestions).toEqual([
      { key: 'q1', prompt: 'Ask this verbatim' },
      { key: 'q2', prompt: 'And this one' },
    ]);
  });

  it('scores every dimension of a completed run, including the ones that did not report', () => {
    const model = call({ interviewerPolicy: true }, {}, POLICY_EVALUATION_RUN);
    const ev = model.interviewerPolicy?.evaluation;
    expect(ev?.hasRun).toBe(true);
    // `completedAt` wins over `startedAt` — the reader wants when the verdict landed.
    expect(ev?.runAt).toBe('2026-08-11T00:00:05.000Z');
    expect(ev?.totalFindings).toBe(2);
    // One row per dimension in POLICY_EVALUATION_DIMENSIONS order, not one row per dimension that
    // happened to answer: a judge that failed is a fact about the run, not an absence.
    expect(ev?.scores.map((s) => s.dimension)).toEqual([
      'rule_coherence',
      'arc_fit',
      'fidelity_calibration',
      'cross_layer_conflict',
    ]);
    expect(ev?.scores[0]).toMatchObject({
      label: 'Rule-Coherence Judge',
      score: 0.7,
      diagnostic: null,
      findingCount: 2,
    });
    expect(ev?.scores[1]).toMatchObject({
      score: null,
      diagnostic: 'judge_error',
      findingCount: 0,
    });
    // A dimension with no summary row at all still gets a score row, scored null.
    expect(ev?.scores[3]).toMatchObject({ score: null, diagnostic: null, findingCount: 0 });
  });

  it('groups findings by subject and renders the structured edit in plain English', () => {
    const model = call({ interviewerPolicy: true }, {}, POLICY_EVALUATION_RUN);
    const targets = model.interviewerPolicy?.evaluation.targets ?? [];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'r1',
      kind: 'house_rule',
      removed: false,
      counts: { major: 1, minor: 1, info: 0, total: 2 },
    });
    expect(targets[0].judges.map((j) => j.status)).toEqual(['pending', 'declined']);
    // The first carries a structured op and gets a sentence; the second is prose-only and must
    // stay null rather than inventing one.
    expect(targets[0].judges[0].proposedEditSummary).not.toBeNull();
    expect(targets[0].judges[1].proposedEditSummary).toBeNull();
  });

  it('prefers the reviewer’s edited override to the judge’s original proposal', () => {
    // The admin console lets a reviewer rewrite a proposed edit before applying it. The pack must
    // describe what would actually happen, which is the override — two ops whose sentences differ,
    // so the assertion cannot pass on the wrong one.
    const overridden: PolicyEvaluationRunDetail = {
      ...POLICY_EVALUATION_RUN,
      findings: [
        {
          ...POLICY_EVALUATION_RUN.findings[0],
          proposedEdit: { op: 'set_house_rule_enabled', enabled: true },
          editedOverride: { op: 'set_house_rule_enabled', enabled: false },
        },
      ],
    };
    const model = call({ interviewerPolicy: true }, {}, overridden);
    const summary =
      model.interviewerPolicy?.evaluation.targets[0]?.judges[0]?.proposedEditSummary ?? '';
    expect(summary).toBe('Switch this rule off');
  });
});
