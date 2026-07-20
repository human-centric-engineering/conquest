import { describe, it, expect } from 'vitest';

import {
  narrowCarryOver,
  narrowSessionSensitivityNotes,
  serialiseCarryOver,
} from '@/lib/app/questionnaire/experiences/carryover/narrow';
import type { CarryOverContext } from '@/lib/app/questionnaire/experiences/run/types';

function context(overrides: Partial<CarryOverContext> = {}): CarryOverContext {
  return {
    fromStepKey: 'opening',
    fromSessionId: 'sess_1',
    fills: [],
    profile: null,
    sensitivityLevel: null,
    sensitivityNotes: [],
    scores: null,
    briefing: null,
    openingLine: null,
    carriedThemes: [],
    builtAt: '2026-07-19T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * `AppExperienceRun.carryOver` is an opaque Json column whose contents are injected into the NEXT
 * questionnaire's interviewer prompt. A malformed payload must therefore degrade to less context —
 * never escape as an untyped value, and never drop a safeguarding disclosure silently.
 */
describe('narrowCarryOver', () => {
  it('returns null for anything that is not an object', () => {
    for (const value of [null, undefined, 'text', 42, [], true]) {
      expect(narrowCarryOver(value)).toBeNull();
    }
  });

  it('round-trips a well-formed context unchanged', () => {
    const original = context({
      fills: [
        {
          key: 'pain',
          name: 'Main difficulty',
          theme: 'operations',
          paraphrase: 'coordination across departments',
          value: 'coordination',
          confidence: 0.8,
        },
      ],
      sensitivityLevel: 'high',
      sensitivityNotes: [{ severity: 'high', category: 'health', summary: 'mentioned burnout' }],
      briefing: 'They lead a distributed team.',
      openingLine: 'You mentioned coordination — can we stay there?',
      carriedThemes: ['coordination', 'workload'],
    });

    expect(narrowCarryOver(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it('fills missing keys with safe empties rather than undefined', () => {
    const narrowed = narrowCarryOver({});
    expect(narrowed).not.toBeNull();
    expect(narrowed?.fills).toEqual([]);
    expect(narrowed?.sensitivityNotes).toEqual([]);
    expect(narrowed?.carriedThemes).toEqual([]);
    expect(narrowed?.profile).toBeNull();
    expect(narrowed?.briefing).toBeNull();
  });

  describe('fills', () => {
    it('drops a fill with no key', () => {
      // The key is how a routing rule and the prompt both name a fill; an anonymous one is unusable.
      const narrowed = narrowCarryOver({ fills: [{ name: 'Nameless', value: 'x' }] });
      expect(narrowed?.fills).toEqual([]);
    });

    it('drops non-object entries rather than carrying them', () => {
      const narrowed = narrowCarryOver({ fills: ['nonsense', 42, null, { key: 'ok' }] });
      expect(narrowed?.fills.map((f) => f.key)).toEqual(['ok']);
    });

    it('defaults a missing name to the key', () => {
      const narrowed = narrowCarryOver({ fills: [{ key: 'headcount' }] });
      expect(narrowed?.fills[0].name).toBe('headcount');
    });

    it('passes any JSON value shape through untouched', () => {
      const narrowed = narrowCarryOver({
        fills: [
          { key: 'a', value: ['x', 'y'] },
          { key: 'b', value: { nested: true } },
          { key: 'c', value: 0 },
          { key: 'd', value: false },
        ],
      });
      expect(narrowed?.fills.map((f) => f.value)).toEqual([['x', 'y'], { nested: true }, 0, false]);
    });

    it('rejects a non-finite confidence rather than carrying NaN into a prompt', () => {
      const narrowed = narrowCarryOver({ fills: [{ key: 'a', confidence: Number.NaN }] });
      expect(narrowed?.fills[0].confidence).toBeNull();
    });
  });

  describe('safeguarding notes', () => {
    it('keeps a well-formed note', () => {
      const narrowed = narrowCarryOver({
        sensitivityNotes: [{ severity: 'high', category: 'health', summary: 'disclosed illness' }],
      });
      expect(narrowed?.sensitivityNotes).toHaveLength(1);
      expect(narrowed?.sensitivityNotes[0].severity).toBe('high');
    });

    it('drops a note with an unrecognised severity', () => {
      // Better to carry nothing than to carry a disclosure at the wrong severity — and defaulting
      // an unknown value to `low` would understate something the respondent actually said.
      const narrowed = narrowCarryOver({
        sensitivityNotes: [{ severity: 'catastrophic', category: 'x', summary: 'y' }],
      });
      expect(narrowed?.sensitivityNotes).toEqual([]);
    });

    it('drops a note with no summary', () => {
      const narrowed = narrowCarryOver({
        sensitivityNotes: [{ severity: 'high', category: 'x', summary: '' }],
      });
      expect(narrowed?.sensitivityNotes).toEqual([]);
    });

    it('defaults a missing category rather than dropping the note', () => {
      // The summary is the load-bearing part; losing a real disclosure over a missing label would
      // be the wrong trade.
      const narrowed = narrowCarryOver({
        sensitivityNotes: [{ severity: 'medium', summary: 'mentioned bereavement' }],
      });
      expect(narrowed?.sensitivityNotes).toHaveLength(1);
      expect(narrowed?.sensitivityNotes[0].category).toBe('unspecified');
    });

    it('narrows an unrecognised sensitivityLevel to null, not to a severity', () => {
      expect(narrowCarryOver({ sensitivityLevel: 'extreme' })?.sensitivityLevel).toBeNull();
      expect(narrowCarryOver({ sensitivityLevel: 'high' })?.sensitivityLevel).toBe('high');
    });
  });

  it('drops empty and non-string carried themes', () => {
    const narrowed = narrowCarryOver({ carriedThemes: ['workload', '', '  ', 42, null] });
    expect(narrowed?.carriedThemes).toEqual(['workload']);
  });

  it('is idempotent', () => {
    const once = narrowCarryOver({ fills: [{ key: 'a', value: 'x' }], briefing: 'b' });
    expect(narrowCarryOver(once)).toEqual(once);
  });
});

describe('narrowSessionSensitivityNotes', () => {
  it('projects the session column onto carried notes, dropping the turn metadata', () => {
    const notes = narrowSessionSensitivityNotes([
      {
        severity: 'high',
        category: 'health',
        summary: 'disclosed illness',
        turnOrdinal: 4,
        createdAt: '2026-07-19T10:00:00.000Z',
      },
    ]);
    expect(notes).toEqual([{ severity: 'high', category: 'health', summary: 'disclosed illness' }]);
  });

  it('returns empty for a non-array column', () => {
    expect(narrowSessionSensitivityNotes(null)).toEqual([]);
    expect(narrowSessionSensitivityNotes({})).toEqual([]);
  });
});

describe('serialiseCarryOver', () => {
  it('produces a plain JSON object the column will accept', () => {
    const serialised = serialiseCarryOver(
      context({
        fills: [
          { key: 'a', name: 'A', theme: null, paraphrase: null, value: { x: 1 }, confidence: 0.5 },
        ],
      })
    );
    expect(serialised).not.toBeNull();
    expect(narrowCarryOver(serialised)?.fills[0].value).toEqual({ x: 1 });
  });

  it('survives a round-trip back through narrowing', () => {
    const original = context({ briefing: 'b', carriedThemes: ['t'] });
    expect(narrowCarryOver(serialiseCarryOver(original))).toEqual(original);
  });

  it('returns null rather than throwing on an unserialisable value', () => {
    // A cycle is not reachable through the normal build path, but the column write must never be
    // the thing that fails a handoff.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const broken = context({
      fills: [
        { key: 'a', name: 'A', theme: null, paraphrase: null, value: cyclic, confidence: null },
      ],
    });
    expect(serialiseCarryOver(broken)).toBeNull();
  });
});
