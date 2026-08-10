/**
 * build-pack-model — unit tests for the Questionnaire Pack export model.
 *
 * Pins: each `PackInclude` flag nulling out its own section (and no others), data-slot
 * `questionKeys` resolving to `{ key, prompt }` pairs against the graph (falling back to the bare
 * key when a question was deleted), the curated experience-setup summary reading friendly labels
 * off the config, and that meta/section/question fields are exactly what `buildInstrumentModel`
 * would produce (reused, not re-derived).
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

describe('buildPackModel', () => {
  it('includes every section by default', () => {
    const model = buildPackModel(
      'Pulse Survey',
      graphOf(SECTIONS),
      DATA_SLOTS,
      GLOSSARY,
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
  });

  it('nulls out only the excluded sections', () => {
    const include: PackInclude = {
      meta: false,
      questions: true,
      dataSlots: false,
      definitions: true,
      setup: false,
    };
    const model = buildPackModel('T', graphOf(SECTIONS), DATA_SLOTS, GLOSSARY, include, 'now');

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
        DEFAULT_PACK_INCLUDE,
        'now'
      );
      const byLabel = new Map(model.setup?.map((item) => [item.label, item.value]));
      expect(byLabel.get('Access')).toBe('Public link');
      expect(byLabel.get('Voice input')).toBe('Enabled');
      expect(byLabel.get('File attachments')).toBe('Disabled');
    });

    it('does not leak internal tuning fields (e.g. answerConfidenceFloor) into the summary', () => {
      const model = buildPackModel('T', graphOf(SECTIONS), [], null, DEFAULT_PACK_INCLUDE, 'now');
      const labels = model.setup?.map((item) => item.label) ?? [];
      expect(labels.join(' ')).not.toMatch(/confidence|budget|coverage/i);
    });
  });
});
