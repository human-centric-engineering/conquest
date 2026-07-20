/**
 * What the breakout synthesiser reads (P15.5).
 *
 * The contract: data slots, rationales, movement and questionnaire background — never raw chat,
 * never an identity. These tests pin both halves of that.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSynthesisMaterial,
  hasEnoughToSynthesise,
  positionText,
  type SynthesisFillRow,
  type SynthesisSlotDefinition,
} from '@/lib/app/questionnaire/experiences/meeting/synthesis-material';
import type { RefinementHistoryEntry } from '@/lib/app/questionnaire/refinement/types';

const BACKGROUND = {
  questionnaireTitle: 'Team Health',
  goal: 'understand where the team is strained',
  breakoutTitle: 'Where are we stretched?',
  briefing: 'Be candid — nothing here is attributed.',
  synthesisFocus: 'Surface disagreements about workload.',
};

const DEFS: SynthesisSlotDefinition[] = [
  { key: 'workload', name: 'Workload', description: 'How stretched', theme: 'Capacity' },
  { key: 'clarity', name: 'Clarity', description: null, theme: null },
];

function fill(over: Partial<SynthesisFillRow> = {}): SynthesisFillRow {
  return {
    sessionId: 'sess_a',
    slotKey: 'workload',
    value: 'stretched',
    paraphrase: 'We are stretched thin',
    confidence: 0.8,
    rationale: 'Said so directly when asked about capacity',
    provenanceLabel: 'direct',
    refinementHistory: [],
    ...over,
  };
}

function movement(over: Partial<RefinementHistoryEntry> = {}): RefinementHistoryEntry {
  return {
    previousValue: 'fine',
    previousProvenance: 'direct',
    newValue: 'stretched',
    rationale: 'Changed their mind after hearing the delivery dates',
    source: 'refinement',
    previousConfidence: 0.4,
    newConfidence: 0.9,
    ...over,
  } as RefinementHistoryEntry;
}

function build(fills: SynthesisFillRow[], participantCount = 3) {
  return buildSynthesisMaterial({
    background: BACKGROUND,
    definitions: DEFS,
    fills,
    participantCount,
  });
}

describe('positionText', () => {
  it('prefers the paraphrase — the position in the respondent’s own words', () => {
    expect(positionText({ paraphrase: 'Stretched thin', value: 'stretched' })).toBe(
      'Stretched thin'
    );
  });

  it('falls back to a string value', () => {
    expect(positionText({ paraphrase: null, value: 'stretched' })).toBe('stretched');
  });

  it('ignores a blank paraphrase rather than rendering emptiness', () => {
    expect(positionText({ paraphrase: '   ', value: 'stretched' })).toBe('stretched');
  });

  it('NEVER renders an object as [object Object]', () => {
    // The bug lint caught in the carry-over prompts: a structured answer silently replaced by a
    // meaningless token the model cannot recognise as a substitution.
    const text = positionText({ paraphrase: null, value: { level: 'high', trend: 'up' } });
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('high');
  });

  it('renders numbers and booleans', () => {
    expect(positionText({ paraphrase: null, value: 7 })).toBe('7');
    expect(positionText({ paraphrase: null, value: false })).toBe('false');
  });

  it('says so plainly when there is no answer', () => {
    expect(positionText({ paraphrase: null, value: null })).toBe('(no answer)');
  });
});

describe('buildSynthesisMaterial — identity', () => {
  it('labels participants P1, P2, … and never exposes a session id', () => {
    const material = build([
      fill({ sessionId: 'sess_a' }),
      fill({ sessionId: 'sess_b' }),
      fill({ sessionId: 'sess_a', slotKey: 'clarity' }),
    ]);

    const workload = material.slots.find((s) => s.key === 'workload');
    expect(workload?.positions.map((p) => p.participant)).toEqual(['P1', 'P2']);

    // The whole material must contain no session id anywhere.
    const serialised = JSON.stringify(material);
    expect(serialised).not.toContain('sess_a');
    expect(serialised).not.toContain('sess_b');
  });

  it('keeps ONE participant’s positions under the same label across slots', () => {
    // Without this the synthesiser cannot tell a genuine split between two people from one person
    // contradicting themselves.
    const material = build([
      fill({ sessionId: 'sess_a', slotKey: 'workload' }),
      fill({ sessionId: 'sess_a', slotKey: 'clarity' }),
    ]);
    const labels = material.slots.flatMap((s) => s.positions.map((p) => p.participant));
    expect(new Set(labels)).toEqual(new Set(['P1']));
  });

  it('is deterministic — a regenerated synthesis does not renumber everyone', () => {
    const rows = [fill({ sessionId: 'sess_b' }), fill({ sessionId: 'sess_a' })];
    expect(JSON.stringify(build(rows))).toEqual(JSON.stringify(build(rows)));
  });
});

describe('buildSynthesisMaterial — content', () => {
  it('carries rationales through', () => {
    const material = build([fill({ rationale: 'They cited the on-call rota' })]);
    expect(material.slots[0].positions[0].rationale).toBe('They cited the on-call rota');
  });

  it('carries the questionnaire background and the breakout framing', () => {
    const material = build([fill()]);
    expect(material.background.goal).toBe('understand where the team is strained');
    expect(material.background.synthesisFocus).toBe('Surface disagreements about workload.');
  });

  it('marks an inferred position as inferred', () => {
    // A synthesis that treated the pipeline's guesses as the room's own words would report
    // inferences back to the people who never said them.
    const material = build([fill({ provenanceLabel: 'inferred' })]);
    expect(material.slots[0].positions[0].inferred).toBe(true);
  });

  it('treats a direct answer as not inferred', () => {
    expect(build([fill({ provenanceLabel: 'direct' })]).slots[0].positions[0].inferred).toBe(false);
  });

  it('includes every defined slot, even one nobody answered', () => {
    // "Nobody answered this" is itself a finding a facilitator may want.
    const material = build([fill({ slotKey: 'workload' })]);
    const clarity = material.slots.find((s) => s.key === 'clarity');
    expect(clarity).toBeDefined();
    expect(clarity?.respondedCount).toBe(0);
    expect(clarity?.positions).toEqual([]);
  });

  it('uses the COMPLETED count as the denominator, not the number who answered', () => {
    // Deriving it from fills would quietly inflate every proportion — "everyone agreed" when half
    // the room said nothing.
    const material = build([fill()], 8);
    expect(material.participantCount).toBe(8);
    expect(material.slots[0].respondedCount).toBe(1);
  });
});

describe('buildSynthesisMaterial — movement', () => {
  it('surfaces a position that moved, with its rationale', () => {
    const material = build([fill({ refinementHistory: [movement()] })]);

    const moved = material.slots[0].movements;
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      participant: 'P1',
      from: 'fine',
      to: 'stretched',
      rationale: 'Changed their mind after hearing the delivery dates',
    });
  });

  it('carries the confidence trajectory — a position can firm up without changing', () => {
    const material = build([fill({ refinementHistory: [movement()] })]);
    expect(material.slots[0].movements[0]).toMatchObject({
      confidenceBefore: 0.4,
      confidenceAfter: 0.9,
    });
  });

  it('drops a bare value swap with no rationale — it tells no story', () => {
    const material = build([fill({ refinementHistory: [movement({ rationale: '   ' })] })]);
    expect(material.slots[0].movements).toEqual([]);
  });

  it('renders an object-valued movement safely on both sides', () => {
    const material = build([
      fill({
        refinementHistory: [movement({ previousValue: { a: 1 }, newValue: { a: 2 } })],
      }),
    ]);
    const [m] = material.slots[0].movements;
    expect(m.from).not.toContain('[object Object]');
    expect(m.to).not.toContain('[object Object]');
  });

  it('keeps several movements from one participant in order', () => {
    const material = build([
      fill({
        refinementHistory: [
          movement({ newValue: 'a' }),
          movement({ previousValue: 'a', newValue: 'b' }),
        ],
      }),
    ]);
    expect(material.slots[0].movements.map((m) => m.to)).toEqual(['a', 'b']);
  });
});

describe('hasEnoughToSynthesise', () => {
  it('is true once a slot reaches the support floor', () => {
    const material = build([
      fill({ sessionId: 's1' }),
      fill({ sessionId: 's2' }),
      fill({ sessionId: 's3' }),
    ]);
    expect(hasEnoughToSynthesise(material, 3)).toBe(true);
  });

  it('is false when every slot is below it — the gate would suppress everything anyway', () => {
    // Running the model here spends money to produce nothing; the caller says "not enough
    // responses yet", which is also the honest thing to tell a facilitator watching a room of two.
    const material = build([fill({ sessionId: 's1' }), fill({ sessionId: 's2' })]);
    expect(hasEnoughToSynthesise(material, 3)).toBe(false);
  });

  it('honours the hard floor of two even if asked for less', () => {
    const material = build([fill({ sessionId: 's1' })]);
    expect(hasEnoughToSynthesise(material, 1)).toBe(false);
  });

  it('is false for an empty breakout', () => {
    expect(hasEnoughToSynthesise(build([]), 3)).toBe(false);
  });
});
