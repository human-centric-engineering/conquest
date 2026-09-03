import { describe, it, expect } from 'vitest';

import {
  applyEarlyJudgements,
  drainDeferred,
  earlySeatingBriefingLine,
  earlySeatingCandidates,
  earlySeatingGate,
  emptyEarlySeating,
  evidenceKeyOf,
  type EarlyJudgement,
} from '@/lib/app/questionnaire/scope/early-seating';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  EARLY_SEATING_CADENCE_TURNS,
  EVIDENCE_KEY_MAX_LENGTH,
  narrowEarlySeating,
  type ConditionalTopicsSettings,
  type EarlySeating,
  type InterviewPlan,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import type { OpeningReadiness } from '@/lib/app/questionnaire/scope/readiness';

function topic(key: string, phase: TopicPhase = 'conditional', over: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [`${key}_ds`], questionKeys: [`${key}_q`] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...over,
  };
}

const TOPICS = [
  topic('open', 'opening'),
  topic('pipeline'),
  topic('forecast'),
  topic('talent'),
  topic('close', 'closing'),
];

function settings(over: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return {
    ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
    enabled: true,
    earlyTopicSeating: true,
    ...over,
  };
}

function readiness(ratio: number): OpeningReadiness {
  return {
    covered: Math.round(ratio * 10),
    total: 10,
    ratio,
    uncovered: { dataSlotKeys: [], questionKeys: [] },
  };
}

function gateInput(over: Record<string, unknown> = {}) {
  return {
    settings: settings(),
    early: null as EarlySeating | null,
    plan: null as InterviewPlan | null,
    readiness: readiness(0.8),
    turnCount: 5,
    evidenceKey: 'e1',
    openingComplete: false,
    ...over,
  } as Parameters<typeof earlySeatingGate>[0];
}

describe('evidenceKeyOf', () => {
  it('is stable under reordering, so a re-read cannot look like new evidence', () => {
    const a = evidenceKeyOf(
      [
        { key: 'b', value: null, paraphrase: null },
        { key: 'a', value: null, paraphrase: null },
      ],
      ['q2', 'q1']
    );
    const b = evidenceKeyOf(
      [
        { key: 'a', value: null, paraphrase: null },
        { key: 'b', value: null, paraphrase: null },
      ],
      ['q1', 'q2']
    );
    expect(a).toBe(b);
  });

  it('moves when a new fill or a new answer lands', () => {
    const base = evidenceKeyOf([{ key: 'a', value: null, paraphrase: null }], ['q1']);
    expect(
      evidenceKeyOf(
        [
          { key: 'a', value: null, paraphrase: null },
          { key: 'b', value: null, paraphrase: null },
        ],
        ['q1']
      )
    ).not.toBe(base);
    expect(evidenceKeyOf([{ key: 'a', value: null, paraphrase: null }], ['q1', 'q2'])).not.toBe(
      base
    );
  });
});

describe('evidenceKeyOf — the round trip through the stored row', () => {
  /** A realistically-sized opening: eight data slots and five questions, authored key names. */
  const FILLS = [
    'current_situation',
    'primary_goals',
    'main_challenges',
    'business_impact',
    'decision_timeline',
    'budget_range',
    'team_structure',
    'existing_tooling',
  ].map((key) => ({ key, value: null, paraphrase: null }));
  const ANSWERS = ['q_role_title', 'q_team_size', 'q_sector', 'q_tenure_years', 'q_reporting_line'];

  it('survives being written and read back, at a size a real opening reaches', () => {
    // The gate is an EQUALITY test between a freshly computed key and one that has been through
    // the Json column. The read caps the string, so a writer that did not cap it identically
    // produced a stored value that could never match — and the "nothing new was said" gate, the
    // one condition meant to remove most turns, would never fire once an opening got big enough.
    const fresh = evidenceKeyOf(FILLS, ANSWERS);
    const stored = narrowEarlySeating({
      ...emptyEarlySeating(),
      evidenceKey: fresh,
    })?.evidenceKey;

    expect(stored).toBe(fresh);
  });

  it('is bounded, so one enormous opening cannot write an unbounded cell', () => {
    const huge = evidenceKeyOf(
      Array.from({ length: 200 }, (_, i) => ({ key: `slot_${i}`, value: null, paraphrase: null })),
      Array.from({ length: 200 }, (_, i) => `question_${i}`)
    );

    expect(huge.length).toBeLessThanOrEqual(EVIDENCE_KEY_MAX_LENGTH);
  });

  it('still moves when a member arrives, even at a length that truncates', () => {
    // Why the counts lead the string: the tail is what gets cut, so the part that always changes
    // has to sit at the front.
    const before = evidenceKeyOf(FILLS, ANSWERS);
    const after = evidenceKeyOf(
      [...FILLS, { key: 'zz_late', value: null, paraphrase: null }],
      ANSWERS
    );

    expect(after).not.toBe(before);
  });
});

describe('earlySeatingGate', () => {
  it('stops on the two switches, cheapest first', () => {
    expect(earlySeatingGate(gateInput({ settings: settings({ enabled: false }) }))).toEqual({
      kind: 'stop',
      reason: 'conditional topics is off',
    });
    expect(
      earlySeatingGate(gateInput({ settings: settings({ earlyTopicSeating: false }) }))
    ).toEqual({ kind: 'stop', reason: 'early seating is off' });
  });

  it('stops once a plan exists — this feature only acts before the seal', () => {
    const plan = { topics: [] } as unknown as InterviewPlan;
    expect(earlySeatingGate(gateInput({ plan }))).toEqual({
      kind: 'stop',
      reason: 'already planned',
    });
  });

  it('stands down on the turn the opening completes, so nothing decides twice', () => {
    // The planner is about to judge the complete opening. Front-running it by one function call
    // buys nothing and puts two decisions about the same interview on the same turn.
    expect(earlySeatingGate(gateInput({ openingComplete: true }))).toEqual({
      kind: 'stop',
      reason: 'the opening completed this turn',
    });
  });

  it('stops below the coverage floor', () => {
    expect(
      earlySeatingGate(
        gateInput({ readiness: readiness(0.5), settings: settings({ earlySeatingFloor: 0.6 }) })
      )
    ).toEqual({ kind: 'stop', reason: 'below the opening-coverage floor' });
  });

  it('stops when the pass is not due this turn yet', () => {
    // The cadence gate, checked BEFORE the evidence check and after the floor. It is what stops a
    // respondent who is answering quickly from buying a judge call on consecutive turns; without
    // it the evidence check alone would let every turn that added a fill pay for one.
    const early: EarlySeating = { ...emptyEarlySeating(), lastPassAtTurn: 5, evidenceKey: 'old' };

    expect(
      earlySeatingGate(gateInput({ early, turnCount: 5 + EARLY_SEATING_CADENCE_TURNS - 1 }))
    ).toEqual({ kind: 'stop', reason: 'not due this turn' });

    // And the turn it comes due, with the evidence moved, it judges.
    expect(
      earlySeatingGate(gateInput({ early, turnCount: 5 + EARLY_SEATING_CADENCE_TURNS })).kind
    ).toBe('judge');
  });

  it('stops when nothing new was said since the last pass', () => {
    // The condition that removes most turns regardless of cadence: a turn that added no fill and
    // no answer cannot change the judgement, so it must not pay for one.
    const early: EarlySeating = { ...emptyEarlySeating(), lastPassAtTurn: 4, evidenceKey: 'e1' };
    expect(earlySeatingGate(gateInput({ early, evidenceKey: 'e1' }))).toEqual({
      kind: 'stop',
      reason: 'no new evidence since the last pass',
    });
    expect(earlySeatingGate(gateInput({ early, evidenceKey: 'e2' })).kind).toBe('judge');
  });

  it('stops once the early allowance is spent', () => {
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      seated: [
        {
          key: 'pipeline',
          depth: 'full',
          confidence: 0.9,
          rationale: '',
          respondentReason: '',
          atTurn: 2,
        },
      ],
    };
    expect(
      earlySeatingGate(gateInput({ early, settings: settings({ maxEarlySeatedTopics: 1 }) }))
    ).toEqual({ kind: 'stop', reason: 'the early-seating allowance is spent' });
  });

  it('spends ONE breadth budget — the overall cap bounds early seats too', () => {
    // Breadth is one budget. A session that has seated its whole `maxConditionalTopics` allowance
    // early has nothing left for the planner either, and the planner is the stage that should be
    // spending it.
    const seat = (key: string) => ({
      key,
      depth: 'full' as const,
      confidence: 0.9,
      rationale: '',
      respondentReason: '',
      atTurn: 1,
    });
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      seated: [seat('pipeline'), seat('forecast')],
    };

    expect(
      earlySeatingGate(
        gateInput({
          early,
          settings: settings({ maxEarlySeatedTopics: 9, maxConditionalTopics: 2 }),
        })
      )
    ).toEqual({ kind: 'stop', reason: 'the early-seating allowance is spent' });
  });

  describe('tier 0 — draining deferred picks', () => {
    const deferredEarly: EarlySeating = {
      ...emptyEarlySeating(),
      lastPassAtTurn: 4,
      evidenceKey: 'e1',
      deferred: [
        {
          key: 'forecast',
          depth: 'full',
          confidence: 0.95,
          rationale: 'r',
          respondentReason: 'rr',
          atTurn: 4,
        },
        {
          key: 'talent',
          depth: 'full',
          confidence: 0.91,
          rationale: 'r',
          respondentReason: 'rr',
          atTurn: 4,
        },
      ],
    };

    it('drains at the per-turn rate, before any other check and with no model call', () => {
      const gate = earlySeatingGate(
        gateInput({ early: deferredEarly, settings: settings({ maxRoutingDecisionsPerTurn: 1 }) })
      );

      expect(gate.kind).toBe('drain');
      if (gate.kind !== 'drain') return;
      expect(gate.picks.map((p) => p.key)).toEqual(['forecast']);
    });

    it('drains even when the evidence has not moved', () => {
      // Without this the picks would strand forever: the evidence would not change on the next
      // turn, so tier 1 would block and they would never be seated at all.
      const gate = earlySeatingGate(gateInput({ early: deferredEarly, evidenceKey: 'e1' }));
      expect(gate.kind).toBe('drain');
    });

    it('drains even below the coverage floor', () => {
      // The judgement was already made, above the floor, on a subset of the evidence that now
      // exists. Re-checking the floor would discard a decision that has been taken.
      const gate = earlySeatingGate(gateInput({ early: deferredEarly, readiness: readiness(0.1) }));
      expect(gate.kind).toBe('drain');
    });

    it('does not drain past the session allowance', () => {
      const gate = earlySeatingGate(
        gateInput({
          early: deferredEarly,
          settings: settings({ maxEarlySeatedTopics: 1, maxRoutingDecisionsPerTurn: 5 }),
        })
      );
      expect(gate.kind).toBe('drain');
      if (gate.kind !== 'drain') return;
      expect(gate.picks).toHaveLength(1);
    });
  });

  it('reports both remaining allowances when it lets a judgement through', () => {
    const gate = earlySeatingGate(
      gateInput({
        settings: settings({
          maxEarlySeatedTopics: 3,
          maxRoutingDecisionsPerTurn: 2,
          maxConditionalTopics: 5,
        }),
      })
    );
    expect(gate).toEqual({ kind: 'judge', remainingSessionSeats: 3, remainingTurnSeats: 2 });
  });
});

describe('earlySeatingCandidates', () => {
  it('is the conditional topics minus anything already seated', () => {
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      seated: [
        {
          key: 'pipeline',
          depth: 'full',
          confidence: 1,
          rationale: '',
          respondentReason: '',
          atTurn: 1,
        },
      ],
    };
    expect(earlySeatingCandidates(TOPICS, early).map((t) => t.key)).toEqual(['forecast', 'talent']);
  });

  it('never offers an always-run topic', () => {
    expect(earlySeatingCandidates(TOPICS, null).map((t) => t.key)).toEqual([
      'pipeline',
      'forecast',
      'talent',
    ]);
  });
});

describe('applyEarlyJudgements', () => {
  const judgement = (key: string, confidence: number): EarlyJudgement => ({
    key,
    confidence,
    rationale: `because ${key}`,
    respondentReason: `you mentioned ${key}`,
  });

  function apply(
    judgements: EarlyJudgement[],
    over: { settings?: ConditionalTopicsSettings; early?: EarlySeating | null; turn?: number } = {}
  ) {
    const s = over.settings ?? settings();
    return applyEarlyJudgements({
      early: over.early ?? null,
      judgements,
      topics: TOPICS,
      settings: s,
      remainingSessionSeats: s.maxEarlySeatedTopics,
      remainingTurnSeats: s.maxRoutingDecisionsPerTurn,
      turnCount: over.turn ?? 5,
      evidenceKey: 'e2',
    });
  }

  it('seats what clears the bar and records the evidence it ran on', () => {
    const result = apply([judgement('pipeline', 0.9)]);

    expect(result.newlySeated.map((s) => s.key)).toEqual(['pipeline']);
    expect(result.early.seated).toHaveLength(1);
    expect(result.early.seated[0]).toMatchObject({ key: 'pipeline', confidence: 0.9, atTurn: 5 });
    expect(result.early.evidenceKey).toBe('e2');
    expect(result.early.lastPassAtTurn).toBe(5);
  });

  it('DISCARDS a judgement below the confidence bar rather than deferring it', () => {
    // It was not a decision, it was a guess. Parking it in `deferred` would let it become a seat
    // for free on a later turn, which is exactly the thin-evidence seat the bar exists to prevent.
    const result = apply([judgement('pipeline', 0.5)], {
      settings: settings({ earlySeatingMinConfidence: 0.85 }),
    });

    expect(result.newlySeated).toEqual([]);
    expect(result.early.deferred).toEqual([]);
    expect(result.early.overCap).toBe(false);
  });

  it('defers what the per-turn cap could not take, and flags the over-cap', () => {
    const result = apply(
      [judgement('pipeline', 0.95), judgement('forecast', 0.92), judgement('talent', 0.9)],
      { settings: settings({ maxRoutingDecisionsPerTurn: 1, maxEarlySeatedTopics: 3 }) }
    );

    expect(result.newlySeated.map((s) => s.key)).toEqual(['pipeline']);
    expect(result.early.deferred.map((s) => s.key)).toEqual(['forecast', 'talent']);
    // No silent truncation: a cap that quietly discards reads afterwards as "it only found one".
    expect(result.early.overCap).toBe(true);
  });

  it('drops an unknown key, an always-run key and an already-seated key', () => {
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      seated: [
        {
          key: 'pipeline',
          depth: 'full',
          confidence: 1,
          rationale: '',
          respondentReason: '',
          atTurn: 1,
        },
      ],
    };
    const result = apply(
      [
        judgement('invented', 0.99),
        judgement('open', 0.99),
        judgement('pipeline', 0.99),
        judgement('forecast', 0.99),
      ],
      { early, settings: settings({ maxEarlySeatedTopics: 4, maxRoutingDecisionsPerTurn: 4 }) }
    );

    expect(result.newlySeated.map((s) => s.key)).toEqual(['forecast']);
  });

  it('replaces the deferred list rather than merging it', () => {
    // A fresh pass has just judged the current evidence, so anything the previous pass was still
    // holding is a stale judgement and must not outlive it.
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      deferred: [
        {
          key: 'talent',
          depth: 'full',
          confidence: 0.9,
          rationale: 'old',
          respondentReason: '',
          atTurn: 2,
        },
      ],
    };
    const result = apply([judgement('pipeline', 0.95), judgement('forecast', 0.94)], {
      early,
      settings: settings({ maxRoutingDecisionsPerTurn: 1, maxEarlySeatedTopics: 3 }),
    });

    expect(result.early.deferred.map((s) => s.key)).toEqual(['forecast']);
  });

  it('only ever appends to seated — nothing removes an earlier seat', () => {
    const early: EarlySeating = {
      ...emptyEarlySeating(),
      seated: [
        {
          key: 'pipeline',
          depth: 'full',
          confidence: 1,
          rationale: 'first',
          respondentReason: '',
          atTurn: 1,
        },
      ],
    };
    const result = apply([judgement('forecast', 0.95)], {
      early,
      settings: settings({ maxEarlySeatedTopics: 3 }),
    });

    expect(result.early.seated.map((s) => s.key)).toEqual(['pipeline', 'forecast']);
  });

  it('keeps overCap sticky once a session has hit it', () => {
    const early: EarlySeating = { ...emptyEarlySeating(), overCap: true };
    expect(apply([], { early }).early.overCap).toBe(true);
  });
});

describe('drainDeferred', () => {
  const early: EarlySeating = {
    ...emptyEarlySeating(),
    lastPassAtTurn: 4,
    evidenceKey: 'e1',
    deferred: [
      {
        key: 'forecast',
        depth: 'full',
        confidence: 0.95,
        rationale: 'r',
        respondentReason: 'rr',
        atTurn: 4,
      },
      {
        key: 'talent',
        depth: 'full',
        confidence: 0.9,
        rationale: 'r',
        respondentReason: 'rr',
        atTurn: 4,
      },
    ],
  };

  it('moves the taken picks into seated and leaves the rest deferred', () => {
    const result = drainDeferred(early, [early.deferred[0]], 7);

    expect(result.newlySeated.map((s) => s.key)).toEqual(['forecast']);
    expect(result.early.seated.map((s) => s.key)).toEqual(['forecast']);
    expect(result.early.deferred.map((s) => s.key)).toEqual(['talent']);
  });

  it('re-stamps the turn the topic actually came into scope on', () => {
    // The panel, the rescan and the announcement all ask "when did this appear", and the answer is
    // the turn it was seated, not the turn it was judged.
    const result = drainDeferred(early, [early.deferred[0]], 7);
    expect(result.newlySeated[0]?.atTurn).toBe(7);
  });

  it('leaves the pass bookkeeping alone, because draining is not a new judgement', () => {
    const result = drainDeferred(early, [early.deferred[0]], 7);
    expect(result.early.lastPassAtTurn).toBe(4);
    expect(result.early.evidenceKey).toBe('e1');
  });
});

describe('earlySeatingBriefingLine — what the respondent hears (F17.36 phase 5)', () => {
  const seat = (over: Record<string, unknown> = {}) => ({
    label: 'Talent & hiring',
    respondentReason: 'You mentioned the team has doubled this year.',
    itemCount: 4,
    ...over,
  });

  it('names the area, sizes it, and carries the reason the respondent may be given', () => {
    const line = earlySeatingBriefingLine([seat()]) ?? '';
    expect(line).toContain('Talent & hiring');
    expect(line).toContain('a handful of questions');
    expect(line).toContain('You mentioned the team has doubled this year.');
  });

  it('makes no size claim when the count is unknown', () => {
    // A topic the author deleted mid-interview. A missing size is silence; a wrong one is a
    // promise the interview will not keep.
    const line = earlySeatingBriefingLine([seat({ itemCount: undefined })]) ?? '';
    expect(line).toContain('Talent & hiring');
    expect(line).not.toContain('there is');
  });

  it('gives no reason at all rather than inventing one', () => {
    const line = earlySeatingBriefingLine([seat({ respondentReason: '  ' })]) ?? '';
    expect(line).not.toContain('the reason to give them');
  });

  it('coalesces a multi-area turn into ONE instruction, not one per area', () => {
    // The whole point of the per-turn cap being allowed above 1: "hiring and capacity" is one
    // sentence a person would say, three acknowledgements is a drip nobody would.
    const line =
      earlySeatingBriefingLine([seat(), seat({ label: 'Capacity planning', itemCount: 2 })]) ?? '';
    expect(line).toContain('2 areas');
    expect(line).toContain('Talent & hiring');
    expect(line).toContain('Capacity planning');
    expect(line).toContain('just a couple of questions');
  });

  it('says the opening is unfinished, which is what separates it from the handover line', () => {
    expect(earlySeatingBriefingLine([seat()])).toContain('The opening is not finished');
  });

  it('keeps the implementation vocabulary off the screen', () => {
    const line = (earlySeatingBriefingLine([seat()]) ?? '').toLowerCase();
    // The ban is what makes giving a reason safe: the interviewer may say what it will cover and
    // why, never how the interview decides.
    expect(line).toContain('do not use the words topic, section, plan, scope or depth');
    expect(line).toContain('do not explain how the interview decides');
  });

  it('is null when there is nothing to announce, so no caller checks emptiness twice', () => {
    expect(earlySeatingBriefingLine([])).toBeNull();
    // A seat whose topic no longer resolves carries no label, and an announcement that names
    // nothing is worse than none at all.
    expect(earlySeatingBriefingLine([seat({ label: '  ' })])).toBeNull();
  });
});
