/**
 * build-pack-model — unit tests for the Questionnaire Pack export model.
 *
 * Pins: each `PackInclude` flag nulling out its own section (and no others), data-slot
 * `questionKeys` resolving to `{ key, prompt }` pairs against the graph (falling back to the bare
 * key when a question was deleted), the curated experience-setup summary reading friendly labels
 * off the config, that meta/section/question fields are exactly what `buildInstrumentModel` would
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
import type {
  VersionGraphView,
  SectionView,
  QuestionSlotView,
  EvaluationRunDetail,
} from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import type { GlossaryAppendixView } from '@/lib/app/questionnaire/glossary/types';

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
        questionType: 'free_text',
        removed: false,
      },
      severity: 'major',
      proposedChange: 'Split into two questions',
      rationale: 'This question asks two things at once',
      sourceQuote: 'both engaged and satisfied',
      status: 'pending',
      proposedEdit: null,
      editedOverride: null,
      decidedByUserId: null,
      decidedAt: null,
      appliedAt: null,
      appliedToVersionId: null,
      stale: false,
      applicable: 'manual',
    },
    {
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
      evaluations: false,
    };
    const model = buildPackModel(
      'T',
      graphOf(SECTIONS),
      DATA_SLOTS,
      GLOSSARY,
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
      { ...DEFAULT_PACK_INCLUDE, definitions: false },
      'now'
    );
    expect(model.glossary).toBeNull();
  });

  describe('experience-setup summary', () => {
    it('reads friendly labels for access mode and on/off flags', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS, {
          accessMode: 'public',
          voiceEnabled: true,
          attachmentsEnabled: false,
        }),
        [],
        null,
        null,
        DEFAULT_PACK_INCLUDE,
        'now'
      );
      const byLabel = new Map(model.setup?.map((item) => [item.label, item.value]));
      expect(byLabel.get('Access')).toBe('Public link');
      expect(byLabel.get('Voice input')).toBe('Enabled');
      expect(byLabel.get('File attachments')).toBe('Disabled');
    });

    it('does not leak internal tuning fields (e.g. answerConfidenceFloor) into the summary', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        null,
        DEFAULT_PACK_INCLUDE,
        'now'
      );
      const labels = model.setup?.map((item) => item.label) ?? [];
      expect(labels.join(' ')).not.toMatch(/confidence|budget|coverage/i);
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
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations).toEqual({
        hasRun: false,
        runAt: null,
        totalFindings: 0,
        dimensions: [],
      });
    });

    it('carries all seven dimensions, in EVALUATION_DIMENSIONS order, even ones the run never mentions', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.dimensions.map((d) => d.dimension)).toEqual([
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
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const byDimension = new Map(model.evaluations?.dimensions.map((d) => [d.dimension, d]));
      expect(byDimension.get('clarity')).toMatchObject({
        label: 'Clarity Judge',
        score: 0.4,
        diagnostic: null,
      });
      expect(byDimension.get('coverage')).toMatchObject({ score: null, diagnostic: 'judge_error' });
      // `duplicates` has a finding but no dimensionSummary entry in the fixture — still n/a, not 0.
      expect(byDimension.get('duplicates')).toMatchObject({ score: null, diagnostic: null });
    });

    it('groups findings under their own dimension, resolving targetLabel from target.label and falling back to targetKey', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const byDimension = new Map(model.evaluations?.dimensions.map((d) => [d.dimension, d]));
      expect(byDimension.get('clarity')?.findings).toEqual([
        {
          severity: 'major',
          status: 'pending',
          targetLabel: 'Prompt for q1',
          proposedChange: 'Split into two questions',
          rationale: 'This question asks two things at once',
          sourceQuote: 'both engaged and satisfied',
        },
      ]);
      // f2's `target` is null (an unresolved key) — targetLabel falls back to the raw targetKey.
      expect(byDimension.get('duplicates')?.findings).toEqual([
        {
          severity: 'minor',
          status: 'declined',
          targetLabel: 'deleted-question',
          proposedChange: 'Merge with q1',
          rationale: 'Covers the same ground',
          sourceQuote: null,
        },
      ]);
      expect(byDimension.get('ordering')?.findings).toEqual([]);
    });

    it('includes pending findings — the appendix is a record of the panel, not a curated review outcome', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        EVALUATION_RUN,
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      const statuses = model.evaluations?.dimensions.flatMap((d) =>
        d.findings.map((f) => f.status)
      );
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
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.hasRun).toBe(true);
      expect(model.evaluations?.runAt).toBe('2026-08-10T00:00:05.000Z');
      expect(model.evaluations?.totalFindings).toBe(2);
    });

    it('falls back runAt to startedAt when the run has no completedAt', () => {
      const model = buildPackModel(
        'T',
        graphOf(SECTIONS),
        [],
        null,
        { ...EVALUATION_RUN, completedAt: null },
        { ...DEFAULT_PACK_INCLUDE, evaluations: true },
        'now'
      );
      expect(model.evaluations?.runAt).toBe('2026-08-10T00:00:00.000Z');
    });
  });
});
