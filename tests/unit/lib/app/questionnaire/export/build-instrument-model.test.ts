/**
 * build-instrument-model — unit tests for the blank-instrument export model.
 *
 * Pins: section/question numbering, total counts, option rendering (choice labels, likert per-point
 * labels), the one-line constraint summary (likert range, numeric bounds, boolean labels), and that
 * config-less types carry no options.
 *
 * @see lib/app/questionnaire/export/build-instrument-model.ts
 */

import { describe, it, expect } from 'vitest';

import { buildInstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type {
  VersionGraphView,
  QuestionSlotView,
  SectionView,
} from '@/lib/app/questionnaire/views';

function question(
  partial: Partial<QuestionSlotView> & Pick<QuestionSlotView, 'key' | 'type'>
): QuestionSlotView {
  return {
    id: partial.key,
    ordinal: 0,
    prompt: `Prompt ${partial.key}`,
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
  configOver: Partial<VersionGraphView['config']> = {}
): VersionGraphView {
  return {
    id: 'v1',
    questionnaireId: 'q1',
    versionNumber: 3,
    status: 'draft',
    goal: 'A goal',
    audience: { description: 'Everyone' },
    goalProvenance: null,
    audienceProvenance: null,
    tags: [],
    sections,
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true, ...configOver },
  };
}

/** One section holding the given questions — the shape most fidelity cases need. */
function oneSection(questions: QuestionSlotView[]): SectionView {
  return { id: 's1', ordinal: 0, title: 'S', description: null, questions };
}

describe('buildInstrumentModel', () => {
  it('numbers sections + questions and totals counts', () => {
    const graph = graphOf([
      {
        id: 's1',
        ordinal: 0,
        title: 'One',
        description: null,
        questions: [
          question({ key: 'a', type: 'free_text' }),
          question({ key: 'b', type: 'free_text' }),
        ],
      },
      {
        id: 's2',
        ordinal: 1,
        title: 'Two',
        description: 'desc',
        questions: [question({ key: 'c', type: 'free_text' })],
      },
    ]);

    const model = buildInstrumentModel('My Form', graph, '2026-06-28');
    expect(model.title).toBe('My Form');
    expect(model.versionNumber).toBe(3);
    expect(model.audienceSummary).toBe('Everyone');
    expect(model.sectionCount).toBe(2);
    expect(model.questionCount).toBe(3);
    expect(model.sections[0].number).toBe(1);
    expect(model.sections[0].questions[0].number).toBe('1.1');
    expect(model.sections[0].questions[1].number).toBe('1.2');
    expect(model.sections[1].questions[0].number).toBe('2.1');
  });

  it('renders choice options (with allowOther)', () => {
    const graph = graphOf([
      {
        id: 's1',
        ordinal: 0,
        title: 'S',
        description: null,
        questions: [
          question({
            key: 'colour',
            type: 'single_choice',
            typeConfig: {
              choices: [
                { value: 'r', label: 'Red' },
                { value: 'b', label: 'Blue' },
              ],
              allowOther: true,
            },
          }),
        ],
      },
    ]);
    const q = buildInstrumentModel('T', graph, 'now').sections[0].questions[0];
    expect(q.options).toEqual(['Red', 'Blue', 'Other (please specify)']);
    expect(q.constraint).toBeNull();
  });

  it('renders likert per-point options and a range constraint', () => {
    const graph = graphOf([
      {
        id: 's1',
        ordinal: 0,
        title: 'S',
        description: null,
        questions: [
          question({
            key: 'agree',
            type: 'likert',
            typeConfig: {
              min: 1,
              max: 3,
              labels: ['Disagree', 'Neutral', 'Agree'],
              minLabel: 'Disagree',
              maxLabel: 'Agree',
            },
          }),
        ],
      },
    ]);
    const q = buildInstrumentModel('T', graph, 'now').sections[0].questions[0];
    expect(q.options).toEqual(['1 — Disagree', '2 — Neutral', '3 — Agree']);
    expect(q.constraint).toBe('Scale 1 (Disagree) to 3 (Agree)');
  });

  it('summarises numeric bounds and boolean labels', () => {
    const graph = graphOf([
      {
        id: 's1',
        ordinal: 0,
        title: 'S',
        description: null,
        questions: [
          question({
            key: 'age',
            type: 'numeric',
            typeConfig: { min: 0, max: 120, unit: 'years' },
          }),
          question({
            key: 'ok',
            type: 'boolean',
            typeConfig: { trueLabel: 'Agree', falseLabel: 'Decline' },
          }),
        ],
      },
    ]);
    const [numeric, bool] = buildInstrumentModel('T', graph, 'now').sections[0].questions;
    expect(numeric.constraint).toBe('Numeric (min 0, max 120, unit years)');
    expect(numeric.options).toEqual([]);
    expect(bool.constraint).toBe('Agree / Decline');
  });

  it('leaves config-less types without options or constraint', () => {
    const graph = graphOf([
      {
        id: 's1',
        ordinal: 0,
        title: 'S',
        description: null,
        questions: [question({ key: 'note', type: 'free_text' })],
      },
    ]);
    const q = buildInstrumentModel('T', graph, 'now').sections[0].questions[0];
    expect(q.options).toEqual([]);
    expect(q.constraint).toBeNull();
    expect(q.typeLabel).toBe('Free text');
  });
});

/**
 * Question fidelity on the blank instrument.
 *
 * The dial changes what the document *describes*: at `must_ask` a question is an instrument whose
 * wording and options are put as written; at `free` it may never be asked aloud at all. A reader
 * given only the prompt cannot tell those apart, which is why the level belongs in the export
 * beside the type and the required flag.
 */
describe('buildInstrumentModel — question fidelity', () => {
  const questions = [
    question({ key: 'q1', type: 'likert', fidelity: 1 }),
    question({ key: 'q2', type: 'free_text', fidelity: 0 }),
    question({ key: 'q3', type: 'free_text', fidelity: 0.5 }),
  ];

  it('reports null for every question when the version-level gate is off', () => {
    // The gate is off by default, so this is the overwhelming majority of questionnaires. With it
    // off every question resolves to `balanced` regardless of its stored value, and a uniform
    // column would be noise on every export that never opted in.
    const graph = graphOf([oneSection(questions)]);
    const out = buildInstrumentModel('T', graph, 'now').sections[0].questions;
    expect(out.map((q) => q.fidelity)).toEqual([null, null, null]);
  });

  it('resolves each stop when the gate is on', () => {
    const graph = graphOf([oneSection(questions)], {
      questionFidelity: { enabled: true, defaultFidelity: 0.5 },
    });
    const out = buildInstrumentModel('T', graph, 'now').sections[0].questions;
    expect(out.map((q) => q.fidelity)).toEqual(['must_ask', 'free', 'balanced']);
  });

  it('does not read the stored column directly', () => {
    // The anti-pattern `question-fidelity.md` names: a value an admin pre-set on the Structure
    // editor before switching the feature on must read as absent, not as in force.
    const graph = graphOf([oneSection([question({ key: 'q1', type: 'likert', fidelity: 1 })])]);
    expect(buildInstrumentModel('T', graph, 'now').sections[0].questions[0].fidelity).toBeNull();
  });
});
