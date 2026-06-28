/**
 * Opportunistic down-propagation — seeding a data slot's mapped questions from a confident fill.
 *
 * Anti-green-bar: drives the actual target-selection rules (confidence floor, already-answered
 * exclusion, type routing free-text vs choice/likert, numeric/date skipped) and asserts the built
 * free-text intents + the typed-confidence cap carry the right values, not just that arrays are
 * non-empty.
 *
 * @see lib/app/questionnaire/capabilities/opportunistic-fill.ts
 */

import { describe, it, expect } from 'vitest';

import {
  selectOpportunisticTargets,
  buildFreeTextOpportunisticIntents,
  capOpportunisticConfidence,
  selectRefreshTargets,
  buildRefreshIntents,
  OPPORTUNISTIC_CONFIDENCE_CAP,
  ANSWER_CONFIRM_FLOOR,
} from '@/lib/app/questionnaire/capabilities/opportunistic-fill';
import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  DataSlotFillIntent,
  ExtractionAnsweredView,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

const slot = (key: string, type: ExtractionSlotView['type']): ExtractionSlotView => ({
  key,
  type,
  typeConfig: null,
  prompt: `prompt for ${key}`,
  required: false,
});

const fill = (dataSlotKey: string, over: Partial<DataSlotFillIntent> = {}): DataSlotFillIntent => ({
  dataSlotKey,
  value: 'tools are inadequate',
  paraphrase: 'The respondent reports their tools are inadequate.',
  confidence: 0.85,
  provenance: 'inferred',
  ...over,
});

const dataSlot = (key: string, mappedQuestionKeys: string[]): DataSlotCandidateView => ({
  key,
  name: key,
  description: '',
  theme: '',
  mappedQuestionKeys,
});

describe('selectOpportunisticTargets', () => {
  it('routes free-text targets to freeText and choice/likert to typed', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('enablement')],
      dataSlotCandidates: [dataSlot('enablement', ['talent_3', 'talent_comments_2'])],
      candidateSlots: [slot('talent_3', 'likert'), slot('talent_comments_2', 'free_text')],
      answeredKeys: new Set(),
    });

    expect(targets.freeText.map((t) => t.slot.key)).toEqual(['talent_comments_2']);
    expect(targets.typed.map((s) => s.key)).toEqual(['talent_3']);
  });

  it('skips a fill below the confidence floor', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.4 })],
      dataSlotCandidates: [dataSlot('enablement', ['talent_comments_2'])],
      candidateSlots: [slot('talent_comments_2', 'free_text')],
      answeredKeys: new Set(),
    });
    expect(targets.freeText).toHaveLength(0);
    expect(targets.typed).toHaveLength(0);
  });

  it('never targets a question already answered (this turn or prior)', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('enablement')],
      dataSlotCandidates: [dataSlot('enablement', ['talent_3', 'talent_comments_2'])],
      candidateSlots: [slot('talent_3', 'likert'), slot('talent_comments_2', 'free_text')],
      answeredKeys: new Set(['talent_3']), // already answered → excluded
    });
    expect(targets.typed).toHaveLength(0);
    expect(targets.freeText.map((t) => t.slot.key)).toEqual(['talent_comments_2']);
  });

  it('skips a mapped key that is not an unanswered candidate slot', () => {
    // talent_3 maps but is absent from candidateSlots (already answered → not in the unanswered set).
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('enablement')],
      dataSlotCandidates: [dataSlot('enablement', ['talent_3'])],
      candidateSlots: [],
      answeredKeys: new Set(),
    });
    expect(targets.freeText).toHaveLength(0);
    expect(targets.typed).toHaveLength(0);
  });

  it('leaves numeric/boolean/date out of scope', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('m')],
      dataSlotCandidates: [dataSlot('m', ['n', 'b', 'd'])],
      candidateSlots: [slot('n', 'numeric'), slot('b', 'boolean'), slot('d', 'date')],
      answeredKeys: new Set(),
    });
    expect(targets.freeText).toHaveLength(0);
    expect(targets.typed).toHaveLength(0);
  });

  it('dedupes a question mapped by two confident fills', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('a'), fill('b')],
      dataSlotCandidates: [dataSlot('a', ['shared']), dataSlot('b', ['shared'])],
      candidateSlots: [slot('shared', 'single_choice')],
      answeredKeys: new Set(),
    });
    expect(targets.typed.map((s) => s.key)).toEqual(['shared']);
  });
});

describe('buildFreeTextOpportunisticIntents', () => {
  it('seeds from the paraphrase at the capped confidence, provenance inferred', () => {
    const intents = buildFreeTextOpportunisticIntents([
      { slot: slot('talent_comments_2', 'free_text'), fill: fill('enablement') },
    ]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      slotKey: 'talent_comments_2',
      value: 'The respondent reports their tools are inadequate.',
      paraphrase: 'The respondent reports their tools are inadequate.',
      confidence: OPPORTUNISTIC_CONFIDENCE_CAP,
      provenance: 'inferred',
      isActiveQuestion: false,
    });
  });

  it('falls back to a formatted value when the fill has no paraphrase', () => {
    const intents = buildFreeTextOpportunisticIntents([
      { slot: slot('q', 'free_text'), fill: fill('d', { paraphrase: '', value: 'plain words' }) },
    ]);
    expect(intents[0].value).toBe('plain words');
  });

  it('skips a target whose fill yields no usable text', () => {
    const intents = buildFreeTextOpportunisticIntents([
      { slot: slot('q', 'free_text'), fill: fill('d', { paraphrase: '   ', value: null }) },
    ]);
    expect(intents).toHaveLength(0);
  });
});

describe('capOpportunisticConfidence', () => {
  it('caps a confident fit intent down to the Tentative ceiling and marks it inferred', () => {
    const fit: AnswerSlotIntent[] = [
      {
        slotKey: 'talent_3',
        questionType: 'likert',
        value: 2,
        confidence: 0.9, // resolver was confident about the option fit
        provenance: 'direct',
        rationale: 'maps to low support',
        isActiveQuestion: false,
      },
    ];
    const capped = capOpportunisticConfidence(fit);
    expect(capped[0].confidence).toBe(OPPORTUNISTIC_CONFIDENCE_CAP);
    expect(capped[0].provenance).toBe('inferred');
    expect(capped[0].value).toBe(2); // value preserved
  });

  it('leaves an already-low confidence untouched (min, not overwrite)', () => {
    const capped = capOpportunisticConfidence([
      {
        slotKey: 'q',
        questionType: 'likert',
        value: 1,
        confidence: 0.3,
        provenance: 'inferred',
        rationale: '',
        isActiveQuestion: false,
      },
    ]);
    expect(capped[0].confidence).toBe(0.3);
  });
});

const answered = (over: Partial<ExtractionAnsweredView>): ExtractionAnsweredView => ({
  slotKey: 'talent_3',
  confidence: 0.45,
  value: 2,
  provenance: 'inferred',
  questionType: 'likert',
  ...over,
});

describe('selectRefreshTargets', () => {
  it('strengthens a tentative inferred answer when its parent fill rose this turn', () => {
    // prior fill confidence 0.45 (current) → new fill 0.62: corroborated, so refresh talent_3.
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.62 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.45 },
        },
      ],
      answered: [answered({ confidence: 0.45 })],
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ slotKey: 'talent_3', value: 2, confidence: 0.62 });
  });

  it('does NOT refresh when the fill did not strengthen vs its prior confidence', () => {
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.45 })], // same as prior → no corroboration
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.45 },
        },
      ],
      answered: [answered({ confidence: 0.45 })],
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(0);
  });

  it('leaves an already-confirmed answer (>= floor) untouched', () => {
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.9 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.6 },
        },
      ],
      answered: [answered({ confidence: 0.8 })], // already above the confirm floor
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(0);
  });

  it('never refreshes a respondent/refined answer (provenance not inferred)', () => {
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.7 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.4 },
        },
      ],
      answered: [answered({ confidence: 0.4, provenance: 'direct' })],
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(0);
  });

  it('skips a question already handled this turn', () => {
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.7 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.4 },
        },
      ],
      answered: [answered({ confidence: 0.4 })],
      handledKeys: new Set(['talent_3']),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(0);
  });
});

describe('buildRefreshIntents', () => {
  it('re-emits the same value at the strengthened confidence, provenance inferred', () => {
    const intents = buildRefreshIntents([
      { slotKey: 'talent_3', value: 2, questionType: 'likert', confidence: 0.62 },
    ]);
    expect(intents[0]).toMatchObject({
      slotKey: 'talent_3',
      value: 2,
      confidence: 0.62,
      provenance: 'inferred',
      isActiveQuestion: false,
    });
  });
});
