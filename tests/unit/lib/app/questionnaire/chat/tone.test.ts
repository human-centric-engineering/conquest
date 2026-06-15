/**
 * Interviewer tone & persona helpers (F-tone) — `lib/app/questionnaire/chat/tone.ts`.
 *
 * Both functions are pure. `narrowToneSettings` is the read-path coercer (opaque Json → complete,
 * clamped `ToneSettings`); `buildToneInstructions` renders the *enabled* dimensions into the
 * phraser's system-prompt clauses. The default (all-off) block must produce no instructions so the
 * interviewer keeps today's voice — that invariant is asserted explicitly.
 */

import { describe, it, expect } from 'vitest';

import { buildToneInstructions, narrowToneSettings } from '@/lib/app/questionnaire/chat/tone';
import {
  DEFAULT_TONE_SETTINGS,
  TONE_DIMENSION_KEYS,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

/** A fresh, deep copy of the all-off default so per-test mutation can't leak across cases. */
function freshTone(): ToneSettings {
  return narrowToneSettings(DEFAULT_TONE_SETTINGS);
}

describe('narrowToneSettings', () => {
  it('coerces a null/garbage value to the complete all-off default', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { persona: 'wrong-shape' }]) {
      const out = narrowToneSettings(bad);
      for (const key of TONE_DIMENSION_KEYS) {
        expect(out[key]).toEqual({ enabled: false, level: 3 });
      }
      expect(out.persona).toEqual({ enabled: false, text: '' });
    }
  });

  it('clamps an out-of-range level and rounds a fractional one to a valid 1–5 integer', () => {
    expect(narrowToneSettings({ empathy: { enabled: true, level: 9 } }).empathy.level).toBe(5);
    expect(narrowToneSettings({ empathy: { enabled: true, level: -3 } }).empathy.level).toBe(1);
    expect(narrowToneSettings({ empathy: { enabled: true, level: 3.7 } }).empathy.level).toBe(4);
    // A non-numeric / missing level falls back to the neutral midpoint, not 0.
    expect(narrowToneSettings({ empathy: { enabled: true, level: 'x' } }).empathy.level).toBe(3);
    expect(narrowToneSettings({ empathy: { enabled: true } }).empathy.level).toBe(3);
  });

  it('coerces enabled to a strict boolean and fills missing dimensions from the default', () => {
    const out = narrowToneSettings({ mimicry: { enabled: 'yes', level: 4 } });
    // A truthy-but-non-boolean enabled is NOT trusted — only `true` enables.
    expect(out.mimicry.enabled).toBe(false);
    expect(out.mimicry.level).toBe(4);
    // Unmentioned dimensions are still present at the default.
    expect(out.humour).toEqual({ enabled: false, level: 3 });
  });

  it('trims and length-caps the persona text', () => {
    const long = 'x'.repeat(900);
    const out = narrowToneSettings({ persona: { enabled: true, text: `  ${long}  ` } });
    expect(out.persona.enabled).toBe(true);
    expect(out.persona.text.length).toBe(400);
  });
});

describe('buildToneInstructions', () => {
  it('returns an empty string for the all-off default (today’s voice is unchanged)', () => {
    expect(buildToneInstructions(freshTone())).toBe('');
  });

  it('emits a clause only for enabled dimensions', () => {
    const tone = freshTone();
    tone.warmth = { enabled: true, level: 5 };
    const out = buildToneInstructions(tone);
    expect(out).toContain('encouraging');
    // A disabled dimension contributes nothing.
    expect(out.toLowerCase()).not.toContain('humour');
  });

  it('emits nothing for a bipolar dimension at the neutral midpoint, even when enabled', () => {
    const tone = freshTone();
    tone.empathy = { enabled: true, level: 3 };
    expect(buildToneInstructions(tone)).toBe('');
  });

  it('emits opposite-pole clauses for the low vs high end of a bipolar dimension', () => {
    const low = freshTone();
    low.formality = { enabled: true, level: 1 };
    expect(buildToneInstructions(low).toLowerCase()).toContain('casual');

    const high = freshTone();
    high.formality = { enabled: true, level: 5 };
    expect(buildToneInstructions(high).toLowerCase()).toContain('formal');
  });

  it('always emits for a unipolar dimension at level 1 (minimal is still an instruction)', () => {
    const tone = freshTone();
    tone.mirroring = { enabled: true, level: 1 };
    expect(buildToneInstructions(tone)).not.toBe('');
  });

  it('leads with the persona clause when persona is enabled and non-empty', () => {
    const tone = freshTone();
    tone.persona = { enabled: true, text: 'You are a supportive career coach' };
    tone.empathy = { enabled: true, level: 5 };
    const out = buildToneInstructions(tone);
    expect(out.startsWith('Adopt this persona')).toBe(true);
    expect(out).toContain('You are a supportive career coach.');
  });

  it('omits the persona when enabled but blank', () => {
    const tone = freshTone();
    tone.persona = { enabled: true, text: '   ' };
    expect(buildToneInstructions(tone)).toBe('');
  });
});
