/**
 * The k-anonymity gate for meeting insights (P15.5).
 *
 * A meeting synthesis is read ALOUD to the room it came from — the audience and the subjects are
 * the same people, sitting together. These tests pin the floor that keeps a finding from pointing
 * at an identifiable individual.
 */

import { describe, it, expect } from 'vitest';

import {
  applySupportGate,
  meetsSupportThreshold,
  respondentVisibleInsights,
  summariseSuppression,
} from '@/lib/app/questionnaire/experiences/meeting/anonymity';
import type { MeetingInsightView } from '@/lib/app/questionnaire/experiences/meeting/types';

function insight(over: Partial<MeetingInsightView> = {}): MeetingInsightView {
  return {
    id: 'i1',
    stepId: 'step_1',
    kind: 'tension',
    statement: 'The room split on how much scope to cut.',
    detail: null,
    supportCount: 3,
    ordinal: 0,
    covered: false,
    visibleToRespondents: false,
    ...over,
  };
}

describe('meetsSupportThreshold', () => {
  it('admits a finding at exactly the threshold', () => {
    expect(meetsSupportThreshold(3, 3)).toBe(true);
  });

  it('rejects a finding one short', () => {
    expect(meetsSupportThreshold(2, 3)).toBe(false);
  });

  it('NEVER honours a threshold below two, whatever the caller passes', () => {
    // A threshold of 1 means "publish findings resting on one person" — in a room of colleagues
    // that is an attribution, not an insight. The floor is defensive because the setting reaches
    // here from a Json blob that could have been hand-edited.
    expect(meetsSupportThreshold(1, 1)).toBe(false);
    expect(meetsSupportThreshold(1, 0)).toBe(false);
    expect(meetsSupportThreshold(1, -5)).toBe(false);
    // Two still passes at the floor — the floor is 2, not 3.
    expect(meetsSupportThreshold(2, 1)).toBe(true);
  });

  it('floors a fractional threshold rather than rounding it up', () => {
    // 2.9 must not silently become 3 and suppress a legitimate two-person finding at the floor.
    expect(meetsSupportThreshold(2, 2.9)).toBe(true);
  });

  it('rejects zero support outright', () => {
    expect(meetsSupportThreshold(0, 3)).toBe(false);
    expect(meetsSupportThreshold(0, 2)).toBe(false);
  });
});

describe('applySupportGate', () => {
  it('drops every finding below the threshold', () => {
    const gated = applySupportGate(
      [
        insight({ id: 'a', supportCount: 5 }),
        insight({ id: 'b', supportCount: 2 }),
        insight({ id: 'c', supportCount: 3 }),
      ],
      3
    );
    expect(gated.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('preserves order', () => {
    const gated = applySupportGate(
      [
        insight({ id: 'a', supportCount: 4, ordinal: 0 }),
        insight({ id: 'b', supportCount: 4, ordinal: 1 }),
      ],
      3
    );
    expect(gated.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('still suppresses a stored scribe finding on READ, whatever basis generated it', () => {
    // Scribe rooms count occupancy rather than sessions to decide whether to synthesise at all,
    // but nothing about that reaches the read path. The gate sees a stored `supportCount` and
    // knows nothing of rooms — so raising `insightMinSupport` after a meeting thins an existing
    // scribe synthesis exactly as it thins any other, without regenerating it.
    const stored = [
      insight({ id: 'room', supportCount: 6 }),
      insight({ id: 'thin', supportCount: 1 }),
    ];
    expect(applySupportGate(stored, 3).map((i) => i.id)).toEqual(['room']);
    // Raised after the fact: the six-person finding goes too, on read, with no regeneration.
    expect(applySupportGate(stored, 7)).toEqual([]);
  });

  it('returns nothing when a small room produced only thin findings', () => {
    // The realistic failure a facilitator must not misread: three participants, every finding
    // resting on one or two of them. Better an empty synthesis than an attributable one.
    expect(
      applySupportGate([insight({ supportCount: 1 }), insight({ supportCount: 2 })], 3)
    ).toEqual([]);
  });
});

describe('summariseSuppression', () => {
  it('reports what was shown and what was withheld', () => {
    const result = summariseSuppression(
      [insight({ supportCount: 4 }), insight({ supportCount: 1 }), insight({ supportCount: 2 })],
      3
    );
    expect(result).toEqual({ shown: 1, withheld: 2 });
  });

  it('reports a count only — never the suppressed statements', () => {
    // A facilitator who could read the withheld findings would be reading exactly the attributable
    // ones the gate exists to prevent, and in a small room could place them.
    const result = summariseSuppression([insight({ supportCount: 1 })], 3);
    expect(Object.keys(result).sort()).toEqual(['shown', 'withheld']);
  });
});

describe('respondentVisibleInsights', () => {
  it('requires BOTH the support gate and the visibility flag', () => {
    const visible = respondentVisibleInsights(
      [
        insight({ id: 'a', supportCount: 4, visibleToRespondents: true }),
        insight({ id: 'b', supportCount: 4, visibleToRespondents: false }),
        insight({ id: 'c', supportCount: 2, visibleToRespondents: true }),
      ],
      3
    );
    expect(visible.map((i) => i.id)).toEqual(['a']);
  });

  it('does NOT let the visibility flag override the safety gate', () => {
    // The load-bearing assertion. A facilitator ticking "show this" on a two-person tension must
    // not be able to publish an attribution.
    const visible = respondentVisibleInsights(
      [insight({ supportCount: 2, visibleToRespondents: true })],
      3
    );
    expect(visible).toEqual([]);
  });

  it('shows nothing when the facilitator has surfaced nothing', () => {
    expect(
      respondentVisibleInsights([insight({ supportCount: 9, visibleToRespondents: false })], 3)
    ).toEqual([]);
  });
});
