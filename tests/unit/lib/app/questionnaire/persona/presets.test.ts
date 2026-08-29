/**
 * Built-in persona library (F-persona) — `lib/app/questionnaire/persona/presets.ts`.
 *
 * The seeded menu must be internally consistent: unique keys, the neutral default present and
 * behaving like today's baseline (all-off tone, no overlay), and every character a valid, bounded,
 * self-contained persona. These invariants back the read-path fallback (`narrowPersonas` returns
 * this set) and the schema (which accepts a built-in `defaultPersonaKey`).
 */

import { describe, it, expect } from 'vitest';

import { BUILT_IN_PERSONAS, BUILT_IN_PERSONA_KEYS } from '@/lib/app/questionnaire/persona/presets';
import { narrowPersonas } from '@/lib/app/questionnaire/persona/settings';
import {
  DEFAULT_PERSONA_KEY,
  PERSONA_CATEGORIES,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_LABEL_MAX_LENGTH,
  TONE_DIMENSION_KEYS,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  TONE_PERSONA_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';

describe('BUILT_IN_PERSONAS', () => {
  it('ships a library of unique keys', () => {
    const keys = BUILT_IN_PERSONAS.map((p) => p.key);
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('files every persona under a known category, and fills every category', () => {
    for (const p of BUILT_IN_PERSONAS) {
      expect(PERSONA_CATEGORIES).toContain(p.category);
    }
    // The admin panel renders one group per category; an empty one would be a heading with nothing
    // under it, which reads as a bug rather than a deliberately narrow library.
    for (const category of PERSONA_CATEGORIES) {
      expect(BUILT_IN_PERSONAS.some((p) => p.category === category)).toBe(true);
    }
  });

  it('groups the library by category — every category contiguous, in roster order', () => {
    // The picker and the admin tick-boxes both render in library order, so a persona filed away
    // from its group would appear under the wrong heading.
    const order = BUILT_IN_PERSONAS.map((p) => PERSONA_CATEGORIES.indexOf(p.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps descriptions free of em dashes — they read as a single plain sentence', () => {
    for (const p of BUILT_IN_PERSONAS) {
      expect(p.description).not.toMatch(/[—–]/);
    }
  });

  it('leads with the neutral default, seeded as an objective coach (prompt + dials)', () => {
    const first = BUILT_IN_PERSONAS[0];
    expect(first.key).toBe(DEFAULT_PERSONA_KEY);
    // The default is a fully-seeded persona, not an empty baseline.
    expect(first.tone.persona.enabled).toBe(true);
    expect(first.tone.persona.text.trim().length).toBeGreaterThan(0);
    expect(first.tone.curiosity.enabled).toBe(true);
  });

  it('gives every persona a bounded, non-empty label + description and slug key', () => {
    for (const p of BUILT_IN_PERSONAS) {
      expect(p.key).toMatch(/^[a-z0-9-]+$/);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.label.length).toBeLessThanOrEqual(PERSONA_LABEL_MAX_LENGTH);
      expect(p.description.trim().length).toBeGreaterThan(0);
      expect(p.description.length).toBeLessThanOrEqual(PERSONA_DESCRIPTION_MAX_LENGTH);
      expect(p.tone.persona.text.length).toBeLessThanOrEqual(TONE_PERSONA_MAX_LENGTH);
    }
  });

  it('ships every persona fully seeded — a persona prompt and at least one enabled tone dial', () => {
    for (const p of BUILT_IN_PERSONAS) {
      expect(p.tone.persona.enabled).toBe(true);
      expect(p.tone.persona.text.trim().length).toBeGreaterThan(0);
      const anyDialOn = TONE_DIMENSION_KEYS.some((k) => p.tone[k].enabled);
      expect(anyDialOn).toBe(true);
    }
  });

  it('survives a round-trip through narrowPersonas unchanged (already valid)', () => {
    const out = narrowPersonas(BUILT_IN_PERSONAS.map((p) => ({ ...p })));
    expect(out.map((p) => p.key)).toEqual(BUILT_IN_PERSONAS.map((p) => p.key));
  });

  it('exposes its keys via BUILT_IN_PERSONA_KEYS for the schema', () => {
    expect(BUILT_IN_PERSONA_KEYS).toEqual(BUILT_IN_PERSONAS.map((p) => p.key));
    expect(BUILT_IN_PERSONA_KEYS).toContain(DEFAULT_PERSONA_KEY);
  });

  it('authors dials on the −2…+2 display scale but STORES valid 1–5 levels', () => {
    // Guards against double-conversion / an un-offset preset: every enabled dial must land in 1–5.
    for (const p of BUILT_IN_PERSONAS) {
      for (const key of TONE_DIMENSION_KEYS) {
        const dim = p.tone[key];
        if (!dim.enabled) continue;
        expect(dim.level).toBeGreaterThanOrEqual(TONE_LEVEL_MIN);
        expect(dim.level).toBeLessThanOrEqual(TONE_LEVEL_MAX);
      }
    }
  });

  it('maps the display scale to the expected stored levels (Coach: curiosity +1→4, warmth −1→2)', () => {
    // Pins the −2…+2 → 1–5 conversion for a known persona, so the seeded voice can't shift silently.
    const coach = BUILT_IN_PERSONAS[0];
    expect(coach.tone.curiosity).toEqual({ enabled: true, level: 4 });
    expect(coach.tone.warmth).toEqual({ enabled: true, level: 2 });
    const director = BUILT_IN_PERSONAS.find((p) => p.key === 'director')!;
    expect(director.tone.verbosity).toEqual({ enabled: true, level: 1 }); // −2 → 1
    expect(director.tone.formality).toEqual({ enabled: true, level: 4 }); // +1 → 4
  });
});
