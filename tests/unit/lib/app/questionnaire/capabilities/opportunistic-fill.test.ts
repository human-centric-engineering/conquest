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
  OPPORTUNISTIC_CONFIDENCE_CAP,
} from '@/lib/app/questionnaire/capabilities/opportunistic-fill';
import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  DataSlotFillIntent,
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
