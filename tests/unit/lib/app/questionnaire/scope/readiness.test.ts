import { describe, it, expect } from 'vitest';

import { openingReadiness } from '@/lib/app/questionnaire/scope/readiness';
import type { Topic, TopicPhase } from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase, overrides: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...overrides,
  };
}

const NONE: ReadonlySet<string> = new Set<string>();

function slots(filled: string[] = [], parked: string[] = []) {
  return { filled: new Set(filled), parked: new Set(parked) };
}

describe('openingReadiness', () => {
  it('counts both kinds of member, and reports what is outstanding', () => {
    const topics = [
      topic('open', 'opening', {
        members: { dataSlotKeys: ['situation', 'goals'], questionKeys: ['q1', 'q2'] },
      }),
    ];

    const r = openingReadiness(
      topics,
      slots(['situation']),
      {
        answered: new Set(['q1']),
        known: new Set(['q1', 'q2']),
      },
      { countParked: true }
    );

    expect(r.covered).toBe(2);
    expect(r.total).toBe(4);
    expect(r.ratio).toBe(0.5);
    expect(r.uncovered).toEqual({ dataSlotKeys: ['goals'], questionKeys: ['q2'] });
  });

  it('ignores every topic that is not the opening', () => {
    // A conditional topic's members are not part of the opening at any depth. Counting them would
    // make the ratio a measure of the whole interview, which is a different number entirely.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: ['situation'], questionKeys: [] } }),
      topic('spine', 'core', { members: { dataSlotKeys: ['budget'], questionKeys: ['q9'] } }),
      topic('pipeline', 'conditional', { members: { dataSlotKeys: ['deals'], questionKeys: [] } }),
    ];

    const r = openingReadiness(topics, slots(['situation']), undefined, { countParked: true });

    expect(r.total).toBe(1);
    expect(r.ratio).toBe(1);
  });

  it('is fully ready when the version has no opening topic at all', () => {
    // Nothing to wait for. Reporting 0 here would strand every such interview unplanned forever,
    // which is the direction this feature has always deliberately avoided.
    const r = openingReadiness([topic('pipeline', 'conditional')], slots(), undefined, {
      countParked: true,
    });

    expect(r.total).toBe(0);
    expect(r.ratio).toBe(1);
  });

  describe('parked fills', () => {
    const topics = [
      topic('open', 'opening', {
        members: { dataSlotKeys: ['situation', 'goals'], questionKeys: [] },
      }),
    ];

    it('counts a park as covered under countParked, which is what the gate does', () => {
      // The orchestrator parks a slot it has given up re-asking. The gate must honour that, or it
      // reintroduces the stall the parking exists to prevent.
      const r = openingReadiness(topics, slots(['situation'], ['goals']), undefined, {
        countParked: true,
      });

      expect(r.ratio).toBe(1);
      expect(r.uncovered.dataSlotKeys).toEqual([]);
    });

    it('does not count a park under countParked: false, which is what the floor reads', () => {
      // A park is a best-effort inference nobody gave. Letting it carry a session over the
      // early-seating floor would seat topics on evidence that does not exist.
      const r = openingReadiness(topics, slots(['situation'], ['goals']), undefined, {
        countParked: false,
      });

      expect(r.covered).toBe(1);
      expect(r.total).toBe(2);
      expect(r.uncovered.dataSlotKeys).toEqual(['goals']);
    });
  });

  it('skips a question key the version no longer has', () => {
    // A question deleted after the topic was authored can never be answered. Counting it would
    // hold every interview in its opening forever.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: [], questionKeys: ['q1', 'deleted'] } }),
    ];

    const r = openingReadiness(
      topics,
      slots(),
      { answered: new Set(['q1']), known: new Set(['q1']) },
      {
        countParked: true,
      }
    );

    expect(r.total).toBe(1);
    expect(r.ratio).toBe(1);
    expect(r.uncovered.questionKeys).toEqual([]);
  });

  it('skips the question half entirely when the caller has no answer data', () => {
    // `undefined` means "I do not know about answers", not "there are none" — so the questions are
    // not counted as uncovered. The caller still gets the data-slot half.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: ['situation'], questionKeys: ['q1'] } }),
    ];

    const r = openingReadiness(topics, slots(['situation']), undefined, { countParked: true });

    expect(r.total).toBe(1);
    expect(r.ratio).toBe(1);
  });

  it('counts a member claimed by two opening topics once', () => {
    // Duplicate membership is a warning, not a prohibition. Counting it twice would make the ratio
    // depend on how the author grouped their topics rather than on what the respondent answered,
    // and would let one shared slot move the floor by two.
    const topics = [
      topic('open_a', 'opening', { members: { dataSlotKeys: ['shared'], questionKeys: [] } }),
      topic('open_b', 'opening', {
        members: { dataSlotKeys: ['shared', 'other'], questionKeys: [] },
      }),
    ];

    const r = openingReadiness(topics, slots(['shared']), undefined, { countParked: true });

    expect(r.total).toBe(2);
    expect(r.covered).toBe(1);
    expect(r.uncovered.dataSlotKeys).toEqual(['other']);
  });

  it('treats an unresolvable data-slot key as uncovered, unlike a question key', () => {
    // Deliberate asymmetry, and it is the pre-existing behaviour: the gate has no data-slot
    // inventory to check a key against, so a stale slot key reads as outstanding. Changing that
    // here would be a behaviour change wearing a refactor's clothes.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: ['gone'], questionKeys: [] } }),
    ];

    const r = openingReadiness(topics, { filled: NONE, parked: NONE }, undefined, {
      countParked: true,
    });

    expect(r.ratio).toBe(0);
    expect(r.uncovered.dataSlotKeys).toEqual(['gone']);
  });
});
