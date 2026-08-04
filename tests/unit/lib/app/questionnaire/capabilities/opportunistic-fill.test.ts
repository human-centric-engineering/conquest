/**
 * Opportunistic down-propagation — answering a data slot's mapped questions from a confident fill.
 *
 * Anti-green-bar: drives the actual target-selection rules (confidence floor, already-answered
 * exclusion, type routing free-text vs choice/likert, numeric/date skipped) and asserts the built
 * intents + both confidence ceilings carry the right values, not just that arrays are non-empty.
 *
 * The `JP29` guards get their own coverage: `dedupeIdenticalFreeText` (one paraphrase must never
 * land under three questions again, whatever the resolver returns) and `soleMappedFreeTextTargets`
 * (the failure fallback seeds only where duplication is impossible).
 *
 * @see lib/app/questionnaire/capabilities/opportunistic-fill.ts
 */

import { describe, it, expect } from 'vitest';

import {
  selectOpportunisticTargets,
  freeTextFitCandidates,
  soleMappedFreeTextTargets,
  buildFreeTextOpportunisticIntents,
  capOpportunisticConfidence,
  dedupeIdenticalFreeText,
  selectRefreshTargets,
  buildRefreshIntents,
  OPPORTUNISTIC_CONFIDENCE_CAP,
  OPPORTUNISTIC_TYPED_CONFIDENCE_CAP,
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

  it('dedupes free_text targets across fills — first contributing fill wins the paraphrase', () => {
    // Two confident fills both map to the same free_text question. The seenFreeText guard
    // means only the first fill is recorded; the second is discarded.
    const targets = selectOpportunisticTargets({
      dataSlotFills: [
        fill('a', { paraphrase: 'First fill paraphrase.' }),
        fill('b', { paraphrase: 'Second fill paraphrase.' }),
      ],
      dataSlotCandidates: [dataSlot('a', ['comments']), dataSlot('b', ['comments'])],
      candidateSlots: [slot('comments', 'free_text')],
      answeredKeys: new Set(),
    });
    expect(targets.freeText).toHaveLength(1);
    expect(targets.freeText[0].slot.key).toBe('comments');
    // The first fill's paraphrase wins — the second is dropped.
    expect(targets.freeText[0].fill.paraphrase).toBe('First fill paraphrase.');
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

  it('formats a boolean fallback value as Yes/No', () => {
    const yes = buildFreeTextOpportunisticIntents([
      { slot: slot('q', 'free_text'), fill: fill('d', { paraphrase: '', value: true }) },
    ]);
    const no = buildFreeTextOpportunisticIntents([
      { slot: slot('q', 'free_text'), fill: fill('d', { paraphrase: '', value: false }) },
    ]);
    expect(yes[0].value).toBe('Yes');
    expect(no[0].value).toBe('No');
  });

  it('formats an array fallback value as a comma-joined list (dropping empties)', () => {
    const intents = buildFreeTextOpportunisticIntents([
      {
        slot: slot('q', 'free_text'),
        fill: fill('d', { paraphrase: '', value: ['CRM', '', 'email'] }),
      },
    ]);
    expect(intents[0].value).toBe('CRM, email');
  });

  it('skips a target whose fill yields no usable text', () => {
    const intents = buildFreeTextOpportunisticIntents([
      { slot: slot('q', 'free_text'), fill: fill('d', { paraphrase: '   ', value: null }) },
    ]);
    expect(intents).toHaveLength(0);
  });
});

describe('capOpportunisticConfidence', () => {
  it('caps a confident fit down to the typed ceiling (preserving clarity) and marks it inferred', () => {
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
    // A clearly-pinned likert reads "Fairly sure", not "Tentative" — the resolver's clarity is
    // preserved up to the typed ceiling, not flattened to the free-text seed's 0.45.
    expect(capped[0].confidence).toBe(OPPORTUNISTIC_TYPED_CONFIDENCE_CAP);
    expect(OPPORTUNISTIC_TYPED_CONFIDENCE_CAP).toBeGreaterThan(OPPORTUNISTIC_CONFIDENCE_CAP);
    expect(capped[0].provenance).toBe('inferred');
    expect(capped[0].value).toBe(2); // value preserved
  });

  it('passes a mid-range fit through untouched (below the typed ceiling)', () => {
    const capped = capOpportunisticConfidence([
      {
        slotKey: 'talent_3',
        questionType: 'likert',
        value: 3,
        confidence: 0.6, // points at the right region but not unmistakable
        provenance: 'inferred',
        rationale: '',
        isActiveQuestion: false,
      },
    ]);
    expect(capped[0].confidence).toBe(0.6);
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

  it('holds a resolver-confident FREE-TEXT answer to the flat Tentative ceiling', () => {
    // Free text now rides the same resolver pass as typed answers, but keeps the lower ceiling:
    // a scale point can be PINNED by a clear sentiment, whereas prose the respondent never offered
    // for this question stays a guess to confirm however well the resolver wrote it.
    const capped = capOpportunisticConfidence([
      {
        slotKey: 'ego_expression',
        questionType: 'free_text',
        value: 'They say their ego shows up as self-criticism.',
        confidence: 0.9,
        provenance: 'direct',
        rationale: 'they described self-criticism',
        isActiveQuestion: false,
      },
    ]);
    expect(capped[0].confidence).toBe(OPPORTUNISTIC_CONFIDENCE_CAP);
    expect(capped[0].provenance).toBe('inferred');
  });
});

describe('freeTextFitCandidates', () => {
  it('hands the resolver one candidate per mapped question, so each is judged on its own wording', () => {
    const targets = selectOpportunisticTargets({
      dataSlotFills: [fill('ego_higher_self')],
      dataSlotCandidates: [
        dataSlot('ego_higher_self', ['ego_meaning', 'ego_expression', 'higher_self_expression']),
      ],
      candidateSlots: [
        slot('ego_meaning', 'free_text'),
        slot('ego_expression', 'free_text'),
        slot('higher_self_expression', 'free_text'),
      ],
      answeredKeys: new Set(),
    });
    expect(freeTextFitCandidates(targets.freeText).map((s) => s.key)).toEqual([
      'ego_meaning',
      'ego_expression',
      'higher_self_expression',
    ]);
  });
});

describe('soleMappedFreeTextTargets', () => {
  const targetsFor = (mapped: string[]) =>
    selectOpportunisticTargets({
      dataSlotFills: [fill('ego_higher_self')],
      dataSlotCandidates: [dataSlot('ego_higher_self', mapped)],
      candidateSlots: mapped.map((k) => slot(k, 'free_text')),
      answeredKeys: new Set(),
    }).freeText;

  it('keeps a fill that maps exactly one free-text question (duplication impossible)', () => {
    expect(soleMappedFreeTextTargets(targetsFor(['ego_meaning'])).map((t) => t.slot.key)).toEqual([
      'ego_meaning',
    ]);
  });

  it('drops a fill mapping several free-text questions rather than seeding an arbitrary one', () => {
    // The `JP29` case. With no per-question judgment available, picking a winner among three
    // unjudged questions would be a coin toss shown to the respondent as their answer.
    const many = targetsFor(['ego_meaning', 'ego_expression', 'higher_self_expression']);
    expect(many).toHaveLength(3);
    expect(soleMappedFreeTextTargets(many)).toEqual([]);
  });

  it('keeps the sole-mapped fill while dropping a multi-mapped one in the same turn', () => {
    const mixed = selectOpportunisticTargets({
      dataSlotFills: [fill('ego_higher_self'), fill('human_experience')],
      dataSlotCandidates: [
        dataSlot('ego_higher_self', ['ego_meaning', 'ego_expression']),
        dataSlot('human_experience', ['lived_experience']),
      ],
      candidateSlots: [
        slot('ego_meaning', 'free_text'),
        slot('ego_expression', 'free_text'),
        slot('lived_experience', 'free_text'),
      ],
      answeredKeys: new Set(),
    }).freeText;
    expect(soleMappedFreeTextTargets(mixed).map((t) => t.slot.key)).toEqual(['lived_experience']);
  });
});

describe('dedupeIdenticalFreeText', () => {
  const freeTextIntent = (slotKey: string, value: string, confidence = 0.45): AnswerSlotIntent => ({
    slotKey,
    questionType: 'free_text',
    value,
    confidence,
    provenance: 'inferred',
    rationale: 'r',
    isActiveQuestion: false,
  });

  const PARAPHRASE =
    'They describe their inner world as one of sadness and depression, feeling like there is a ' +
    'weight attached to their stomach pulling them down.';

  it('writes one theme paraphrase under a single question, never three (the JP29 screenshot)', () => {
    const result = dedupeIdenticalFreeText([
      freeTextIntent('ego_meaning', PARAPHRASE),
      freeTextIntent('ego_expression', PARAPHRASE),
      freeTextIntent('higher_self_expression', PARAPHRASE),
    ]);
    expect(result.intents.map((i) => i.slotKey)).toEqual(['ego_meaning']);
    expect(result.dropped.map((d) => d.slotKey)).toEqual([
      'ego_expression',
      'higher_self_expression',
    ]);
  });

  it('keeps the highest-confidence duplicate, not merely the first seen', () => {
    const result = dedupeIdenticalFreeText([
      freeTextIntent('ego_meaning', PARAPHRASE, 0.4),
      freeTextIntent('ego_expression', PARAPHRASE, 0.45),
    ]);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].slotKey).toBe('ego_expression');
    expect(result.dropped[0].slotKey).toBe('ego_meaning');
  });

  it('catches near-identical prose differing only in case, spacing or punctuation', () => {
    // A model asked not to repeat itself often reproduces the same answer with a comma moved —
    // an exact-string guard would let that straight through.
    const result = dedupeIdenticalFreeText([
      freeTextIntent('a', 'They spend a lot of time ruminating and regretting.'),
      freeTextIntent('b', 'They spend a lot of time  ruminating, and regretting'),
    ]);
    expect(result.intents.map((i) => i.slotKey)).toEqual(['a']);
  });

  it('leaves genuinely tailored answers on one theme alone', () => {
    const result = dedupeIdenticalFreeText([
      freeTextIntent('ego_meaning', 'They say the ego is the part of them that judges.'),
      freeTextIntent('higher_self_expression', 'They describe the Higher Self as a calmer voice.'),
    ]);
    expect(result.intents).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('never collapses typed answers that legitimately share a value', () => {
    // Two likert questions on one theme genuinely both land on 3; identical typed values carry no
    // misfiled prose, so the free-text guard must not touch them.
    const typed = (slotKey: string): AnswerSlotIntent => ({
      slotKey,
      questionType: 'likert',
      value: 3,
      confidence: 0.7,
      provenance: 'inferred',
      rationale: 'r',
      isActiveQuestion: false,
    });
    const result = dedupeIdenticalFreeText([typed('q1'), typed('q2')]);
    expect(result.intents).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('passes through a free-text intent with a non-string value untouched', () => {
    const odd = { ...freeTextIntent('q', ''), value: null };
    const result = dedupeIdenticalFreeText([odd]);
    expect(result.intents).toEqual([odd]);
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

  it('does not refresh a mapped question that has no answer yet (a seed case, not a refresh)', () => {
    // The fill strengthened, but talent_3 was never answered → nothing to strengthen.
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.7 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.4 },
        },
      ],
      answered: [], // no answered entry for the mapped question
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(0);
  });

  it('defaults the refresh target type to free_text when the answer has no questionType', () => {
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.62 })],
      dataSlotCandidates: [
        {
          ...dataSlot('enablement', ['talent_3']),
          current: { value: null, paraphrase: null, confidence: 0.45 },
        },
      ],
      answered: [answered({ confidence: 0.45, questionType: undefined })],
      handledKeys: new Set(),
      confirmFloor: ANSWER_CONFIRM_FLOOR,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].questionType).toBe('free_text');
  });

  it('returns [] when the data-slot candidate has no prior recorded confidence (current absent)', () => {
    // cand.current is undefined → prior is undefined → typeof prior !== 'number' → the
    // strengthen-check skips immediately; even a high new-fill confidence cannot trigger a refresh.
    const targets = selectRefreshTargets({
      dataSlotFills: [fill('enablement', { confidence: 0.9 })],
      dataSlotCandidates: [dataSlot('enablement', ['talent_3'])], // no `current` → prior is undefined
      answered: [answered({ confidence: 0.45 })],
      handledKeys: new Set(),
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
