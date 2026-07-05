/**
 * Selectable interviewer persona helpers (F-persona) — `lib/app/questionnaire/persona/settings.ts`.
 *
 * All pure. `narrowPersonaSelection` / `narrowPersonas` are read-path coercers (opaque Json → typed);
 * `selectPersona` / `resolveEffectiveTone` decide which voice governs a session. The key invariants:
 *   - an empty/garbage library falls back to the full built-in set;
 *   - admin edits merge over built-ins by key, and every built-in stays reachable;
 *   - with selection OFF, `resolveEffectiveTone` returns the version tone byte-for-byte (the
 *     "nothing changes when the feature is off" guarantee);
 *   - with selection ON, the chosen persona's tone replaces it, falling back to the default key.
 */

import { describe, it, expect } from 'vitest';

import {
  narrowPersonas,
  narrowPersonaSelection,
  selectPersona,
  resolveEffectiveTone,
} from '@/lib/app/questionnaire/persona/settings';
import { BUILT_IN_PERSONAS } from '@/lib/app/questionnaire/persona/presets';
import {
  DEFAULT_PERSONA_KEY,
  DEFAULT_TONE_SETTINGS,
  type PersonaOption,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

/** A distinctive tone (persona enabled + one dimension) so equality checks are meaningful. */
function markedTone(text: string): ToneSettings {
  return {
    ...DEFAULT_TONE_SETTINGS,
    humour: { enabled: true, level: 5 },
    persona: { enabled: true, text },
  };
}

function persona(key: string, text = `voice-${key}`): PersonaOption {
  return { key, label: `Label ${key}`, description: `Desc ${key}`, tone: markedTone(text) };
}

describe('narrowPersonaSelection', () => {
  it('coerces null/garbage to selection off with the neutral default key', () => {
    for (const bad of [null, undefined, 7, 'nope', []]) {
      expect(narrowPersonaSelection(bad)).toEqual({
        enabled: false,
        defaultPersonaKey: DEFAULT_PERSONA_KEY,
      });
    }
  });

  it('reads a valid selection through, trimming the default key', () => {
    expect(narrowPersonaSelection({ enabled: true, defaultPersonaKey: '  comedian  ' })).toEqual({
      enabled: true,
      defaultPersonaKey: 'comedian',
    });
  });

  it('treats a non-boolean enabled as false and a blank key as the neutral default', () => {
    expect(narrowPersonaSelection({ enabled: 'yes', defaultPersonaKey: '' })).toEqual({
      enabled: false,
      defaultPersonaKey: DEFAULT_PERSONA_KEY,
    });
  });
});

describe('narrowPersonas', () => {
  it('falls back to the full built-in library for an empty or garbage value', () => {
    for (const bad of [null, undefined, [], 'nope', {}]) {
      const out = narrowPersonas(bad);
      expect(out.map((p) => p.key)).toEqual(BUILT_IN_PERSONAS.map((p) => p.key));
    }
  });

  it('drops malformed entries (no key) but keeps valid ones', () => {
    const out = narrowPersonas([persona('a'), { label: 'no key' }, null, persona('b')]);
    // Valid customs first, then every built-in the admin didn't override is appended.
    expect(out.slice(0, 2).map((p) => p.key)).toEqual(['a', 'b']);
    expect(out.some((p) => p.key === DEFAULT_PERSONA_KEY)).toBe(true);
  });

  it('merges an admin override over the built-in of the same key (first wins), no duplicates', () => {
    const overridden = persona(DEFAULT_PERSONA_KEY, 'my-own-coach');
    const out = narrowPersonas([overridden]);
    const keys = out.map((p) => p.key);
    expect(keys.filter((k) => k === DEFAULT_PERSONA_KEY)).toHaveLength(1);
    const coach = out.find((p) => p.key === DEFAULT_PERSONA_KEY);
    expect(coach?.tone.persona.text).toBe('my-own-coach');
    // Every built-in remains reachable.
    for (const b of BUILT_IN_PERSONAS) expect(keys).toContain(b.key);
  });

  it('narrows each entry tone through narrowToneSettings (clamps a bad level)', () => {
    const out = narrowPersonas([
      { key: 'x', label: 'X', description: '', tone: { humour: { enabled: true, level: 99 } } },
    ]);
    expect(out[0].tone.humour).toEqual({ enabled: true, level: 5 });
  });
});

describe('selectPersona', () => {
  const list = [persona('a'), persona('b'), persona('c')];

  it('returns the chosen persona when the key matches', () => {
    expect(selectPersona(list, 'b', 'a')?.key).toBe('b');
  });

  it('falls back to the default key when nothing is chosen', () => {
    expect(selectPersona(list, null, 'c')?.key).toBe('c');
  });

  it('falls back to the first entry when neither chosen nor default resolves', () => {
    expect(selectPersona(list, 'missing', 'also-missing')?.key).toBe('a');
  });

  it('returns null for an empty library', () => {
    expect(selectPersona([], 'a', 'a')).toBeNull();
  });
});

describe('resolveEffectiveTone', () => {
  const versionTone = markedTone('version-voice');
  const personas = [persona('a', 'voice-a'), persona('b', 'voice-b')];

  it('returns the version tone unchanged when selection is off (nothing changes)', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas,
      personaSelection: { enabled: false, defaultPersonaKey: 'a' },
      selectedPersonaKey: 'b',
    });
    expect(out).toBe(versionTone);
  });

  it('returns the chosen persona tone when selection is on', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas,
      personaSelection: { enabled: true, defaultPersonaKey: 'a' },
      selectedPersonaKey: 'b',
    });
    expect(out.persona.text).toBe('voice-b');
  });

  it('falls back to the default persona when the respondent has not chosen', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas,
      personaSelection: { enabled: true, defaultPersonaKey: 'a' },
      selectedPersonaKey: null,
    });
    expect(out.persona.text).toBe('voice-a');
  });

  it('falls back to the version tone when selection is on but the library is empty', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas: [],
      personaSelection: { enabled: true, defaultPersonaKey: 'a' },
      selectedPersonaKey: 'a',
    });
    expect(out).toBe(versionTone);
  });
});
