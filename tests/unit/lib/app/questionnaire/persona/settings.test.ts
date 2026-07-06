/**
 * Selectable interviewer persona helpers (F-persona) — `lib/app/questionnaire/persona/settings.ts`.
 *
 * All pure. `narrowPersonaSelection` is a read-path coercer (opaque Json → typed); `narrowPersonas`
 * returns the fixed built-in library (the persona set is hard-coded, not per-version config);
 * `selectPersona` / `resolveEffectiveTone` decide which voice governs a session. The key invariants:
 *   - `narrowPersonas` always yields the full built-in set, ignoring any stored/legacy value;
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
  it('coerces null/garbage to selection off with the neutral default key + page switcher', () => {
    for (const bad of [null, undefined, 7, 'nope', []]) {
      expect(narrowPersonaSelection(bad)).toEqual({
        enabled: false,
        defaultPersonaKey: DEFAULT_PERSONA_KEY,
        switcher: 'page',
      });
    }
  });

  it('reads a valid selection through, trimming the default key', () => {
    expect(
      narrowPersonaSelection({
        enabled: true,
        defaultPersonaKey: '  comedian  ',
        switcher: 'indicator',
      })
    ).toEqual({
      enabled: true,
      defaultPersonaKey: 'comedian',
      switcher: 'indicator',
    });
  });

  it('treats a non-boolean enabled as false, a blank key as the default, a bad switcher as page', () => {
    expect(
      narrowPersonaSelection({ enabled: 'yes', defaultPersonaKey: '', switcher: 'nonsense' })
    ).toEqual({
      enabled: false,
      defaultPersonaKey: DEFAULT_PERSONA_KEY,
      switcher: 'page',
    });
  });
});

describe('narrowPersonas', () => {
  it('always yields the full built-in library, ignoring any stored/legacy value', () => {
    // The persona library is fixed — a stored custom library (or garbage) never changes the result.
    for (const value of [null, undefined, [], 'nope', {}, [persona('a'), persona('b')]]) {
      const out = narrowPersonas(value);
      expect(out.map((p) => p.key)).toEqual(BUILT_IN_PERSONAS.map((p) => p.key));
    }
  });

  it('returns a fresh array of fresh option objects (not the preset instances)', () => {
    const out = narrowPersonas();
    expect(out).not.toBe(BUILT_IN_PERSONAS);
    out.forEach((p, i) => expect(p).not.toBe(BUILT_IN_PERSONAS[i]));
    // Reassigning a top-level field on a returned option doesn't leak into the presets.
    out[0].label = 'mutated';
    expect(BUILT_IN_PERSONAS[0].label).not.toBe('mutated');
  });

  it('includes the neutral default persona', () => {
    expect(narrowPersonas().some((p) => p.key === DEFAULT_PERSONA_KEY)).toBe(true);
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
      personaSelection: { enabled: false, defaultPersonaKey: 'a', switcher: 'page' },
      selectedPersonaKey: 'b',
    });
    expect(out).toBe(versionTone);
  });

  it('returns the chosen persona tone when selection is on', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas,
      personaSelection: { enabled: true, defaultPersonaKey: 'a', switcher: 'page' },
      selectedPersonaKey: 'b',
    });
    expect(out.persona.text).toBe('voice-b');
  });

  it('falls back to the default persona when the respondent has not chosen', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas,
      personaSelection: { enabled: true, defaultPersonaKey: 'a', switcher: 'page' },
      selectedPersonaKey: null,
    });
    expect(out.persona.text).toBe('voice-a');
  });

  it('falls back to the version tone when selection is on but the library is empty', () => {
    const out = resolveEffectiveTone({
      toneConfig: versionTone,
      personas: [],
      personaSelection: { enabled: true, defaultPersonaKey: 'a', switcher: 'page' },
      selectedPersonaKey: 'a',
    });
    expect(out).toBe(versionTone);
  });
});
