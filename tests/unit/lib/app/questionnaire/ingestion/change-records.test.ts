import { describe, it, expect } from 'vitest';

import { normalizeChangeRecords } from '@/lib/app/questionnaire/ingestion/change-records';
import type { ExtractedChange } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import { CHANGE_TYPES } from '@/lib/app/questionnaire/ingestion/types';

/**
 * Tests for change-record normalisation (F1.1 / PR2).
 *
 * Pure function: LLM-reported `changes` + admin metadata → coherent,
 * suppression-filtered intents. These pin the two contracts the persistence
 * layer (PR4) and the revert flow (F2.3) depend on: per-type coherence
 * (prune ⇒ null afterJson, infer ⇒ version target) and admin-wins-per-field
 * inference suppression.
 */

function change(
  partial: Partial<ExtractedChange> & Pick<ExtractedChange, 'changeType'>
): ExtractedChange {
  return {
    targetEntityType: 'question',
    ...partial,
  };
}

describe('normalizeChangeRecords — edits pass through coherently', () => {
  it('preserves provenance fields for an edit targeting a question', () => {
    const { intents, dropped } = normalizeChangeRecords([
      change({
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        sourceQuote: 'u happy?',
        beforeJson: { prompt: 'u happy?' },
        afterJson: { prompt: 'How satisfied are you?' },
        rationale: 'Clarity',
        confidence: 0.7,
      }),
    ]);
    expect(dropped).toHaveLength(0);
    expect(intents).toEqual([
      {
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        sourceQuote: 'u happy?',
        beforeJson: { prompt: 'u happy?' },
        afterJson: { prompt: 'How satisfied are you?' },
        rationale: 'Clarity',
        confidence: 0.7,
      },
    ]);
  });

  it('omits optional provenance keys that were not reported', () => {
    const { intents } = normalizeChangeRecords([
      change({
        changeType: 'infer_type',
        targetEntityType: 'question',
        afterJson: { type: 'boolean' },
      }),
    ]);
    expect(intents[0]).not.toHaveProperty('sourceQuote');
    expect(intents[0]).not.toHaveProperty('rationale');
    expect(intents[0]).not.toHaveProperty('confidence');
    expect(intents[0]).toMatchObject({ changeType: 'infer_type', targetEntityType: 'question' });
  });

  it('produces one coherent intent for every non-version change type', () => {
    const entityChangeTypes = CHANGE_TYPES.filter(
      (t) => t !== 'infer_goal' && t !== 'infer_audience'
    );
    const { intents, dropped } = normalizeChangeRecords(
      entityChangeTypes.map((changeType) =>
        change({ changeType, targetEntityType: 'question', beforeJson: { a: 1 } })
      )
    );
    expect(dropped).toHaveLength(0);
    expect(intents.map((i) => i.changeType)).toEqual(entityChangeTypes);
  });
});

describe('normalizeChangeRecords — prune coherence', () => {
  it('forces afterJson to null and preserves beforeJson', () => {
    const { intents } = normalizeChangeRecords([
      change({
        changeType: 'prune_section',
        targetEntityType: 'section',
        beforeJson: { title: 'For office use only' },
        afterJson: { stillHere: true }, // model wrongly populated this
      }),
    ]);
    expect(intents[0].afterJson).toBeNull();
    expect(intents[0].beforeJson).toEqual({ title: 'For office use only' });
  });

  it('defaults a missing beforeJson to null', () => {
    const { intents } = normalizeChangeRecords([
      change({ changeType: 'prune_question', targetEntityType: 'question' }),
    ]);
    expect(intents[0].beforeJson).toBeNull();
    expect(intents[0].afterJson).toBeNull();
  });

  it('drops an incoherent prune that targets the version', () => {
    const { intents, dropped } = normalizeChangeRecords([
      change({ changeType: 'prune_question', targetEntityType: 'version' }),
    ]);
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/prune cannot target the version/);
  });
});

describe('normalizeChangeRecords — inference coherence', () => {
  it('forces infer_goal onto the version even if the model mislabelled the target', () => {
    const { intents } = normalizeChangeRecords([
      change({
        changeType: 'infer_goal',
        targetEntityType: 'question',
        afterJson: 'Collect profile',
      }),
    ]);
    expect(intents[0]).toMatchObject({
      changeType: 'infer_goal',
      targetEntityType: 'version',
      afterJson: 'Collect profile',
    });
  });

  it('drops infer_audience whose afterJson is not an object', () => {
    const { intents, dropped } = normalizeChangeRecords([
      change({ changeType: 'infer_audience', targetEntityType: 'version', afterJson: 'patients' }),
    ]);
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/not an object/);
  });

  it('drops a vacuous infer_audience (empty afterJson) as incoherent, not suppressed', () => {
    // With no admin input, an empty {} can't be a suppression — the reason must
    // say the model inferred nothing, not that the admin masked everything.
    const { intents, dropped } = normalizeChangeRecords([
      change({ changeType: 'infer_audience', targetEntityType: 'version', afterJson: {} }),
    ]);
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/has no fields/);
    expect(dropped[0].reason).not.toMatch(/suppressed/);
  });
});

describe('normalizeChangeRecords — admin-wins-per-field suppression', () => {
  const goalChange = change({
    changeType: 'infer_goal',
    targetEntityType: 'version',
    afterJson: 'Inferred goal',
  });
  const audienceChange = change({
    changeType: 'infer_audience',
    targetEntityType: 'version',
    afterJson: { role: 'patient', expertiseLevel: 'novice', sensitivity: 'high' },
  });

  it('keeps inferences when the admin supplied nothing', () => {
    const { intents, dropped } = normalizeChangeRecords([goalChange, audienceChange]);
    expect(dropped).toHaveLength(0);
    expect(intents).toHaveLength(2);
  });

  it('drops infer_goal when the admin supplied a goal (incl. empty string)', () => {
    const { intents, dropped } = normalizeChangeRecords([goalChange], { goal: '' });
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/admin supplied goal/);
  });

  it('removes only the admin-supplied audience keys, keeping the rest', () => {
    const { intents } = normalizeChangeRecords([audienceChange], {
      audience: { role: 'clinician', expertiseLevel: 'expert' },
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].afterJson).toEqual({ sensitivity: 'high' });
  });

  it('drops infer_audience entirely when every inferred key is admin-supplied', () => {
    const { intents, dropped } = normalizeChangeRecords([audienceChange], {
      audience: { role: 'clinician', expertiseLevel: 'expert', sensitivity: 'low' },
    });
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/all inferred audience fields admin-supplied/);
  });

  it('suppresses inference without affecting non-inference edits in the same batch', () => {
    const edit = change({
      changeType: 'correct_grammar',
      targetEntityType: 'question',
      afterJson: { x: 1 },
    });
    const { intents } = normalizeChangeRecords([goalChange, edit], { goal: 'Admin goal' });
    expect(intents.map((i) => i.changeType)).toEqual(['correct_grammar']);
  });
});

describe('normalizeChangeRecords — edits cannot target the version', () => {
  it('drops a non-inference change that claims to target the version', () => {
    const { intents, dropped } = normalizeChangeRecords([
      change({ changeType: 'rewrite_prompt', targetEntityType: 'version' }),
    ]);
    expect(intents).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/cannot target the version/);
  });
});
