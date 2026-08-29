/**
 * Selectable interviewer personas (F-persona) — read-path narrowing + effective-tone resolution.
 *
 * Pure helpers, no I/O — unit-tested in isolation (mirrors `lib/app/questionnaire/chat/tone.ts`):
 *   - {@link narrowPersonaSelection} coerces the opaque `personaSelection` Json into a complete,
 *     clamped {@link PersonaSelectionSettings}.
 *   - {@link narrowPersonas} returns the fixed {@link BUILT_IN_PERSONAS} set. The persona library is
 *     hard-coded (not per-version config); the legacy `personas` Json is ignored.
 *   - {@link availablePersonas} narrows that fixed library to the ones a questionnaire OFFERS —
 *     the admin's `availableKeys` tick-boxes. The library is global; the offer is per-version.
 *   - {@link resolveEffectiveTone} picks the {@link ToneSettings} that governs a session: the chosen
 *     persona's tone when selection is on and a valid key is picked (falling back to the default
 *     persona), otherwise the version's own `tone`. This is the single seam the runtime uses to make
 *     a respondent's choice take effect.
 */

import {
  DEFAULT_PERSONA_KEY,
  DEFAULT_PERSONA_SELECTION,
  PERSONA_KEY_MAX_LENGTH,
  PERSONA_SWITCHERS,
  type PersonaOption,
  type PersonaSelectionSettings,
  type PersonaSwitcher,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';
import { BUILT_IN_PERSONAS, BUILT_IN_PERSONA_KEYS } from '@/lib/app/questionnaire/persona/presets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function narrowString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/**
 * Narrow the stored `availableKeys` — the admin's tick-box subset of the built-in library. Unknown
 * keys are dropped and the survivors are returned in the library's canonical order (so the offered
 * set reads the same everywhere, whatever order they were ticked in). An empty result — no field,
 * a junk field, or every key unknown — stays empty, which is the "offer everything" shape read by
 * {@link availablePersonaKeys}; it is never "offer nothing".
 */
function narrowAvailableKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(
    value
      .map((v) => narrowString(v, PERSONA_KEY_MAX_LENGTH))
      .filter((key) => key.length > 0 && BUILT_IN_PERSONA_KEYS.includes(key))
  );
  return BUILT_IN_PERSONA_KEYS.filter((key) => wanted.has(key));
}

/**
 * The keys actually on offer: the admin's subset, or — for the empty "all of them" shape — the
 * whole built-in library. Always non-empty, so callers never have to handle "no interviewer".
 */
export function availablePersonaKeys(selection: PersonaSelectionSettings): readonly string[] {
  return selection.availableKeys.length > 0 ? selection.availableKeys : BUILT_IN_PERSONA_KEYS;
}

/**
 * The personas actually on offer, in library order — {@link availablePersonaKeys} applied to a
 * library. Empty only if the caller passed a library sharing no keys with the offered set.
 */
export function availablePersonas(
  personas: PersonaOption[],
  selection: PersonaSelectionSettings
): PersonaOption[] {
  const keys = availablePersonaKeys(selection);
  return personas.filter((p) => keys.includes(p.key));
}

/**
 * Coerce the opaque `personaSelection` Json into a complete {@link PersonaSelectionSettings}.
 *
 * Guarantees the invariant the rest of the feature relies on: `defaultPersonaKey` is always one of
 * the offered personas. A default that was un-ticked (or is junk) falls back to the first offered
 * key — which, when the admin offers exactly one persona, makes that persona the default without
 * anyone having to pin it.
 */
export function narrowPersonaSelection(value: unknown): PersonaSelectionSettings {
  const obj = isRecord(value) ? value : {};
  const defaultPersonaKey = narrowString(obj.defaultPersonaKey, PERSONA_KEY_MAX_LENGTH);
  const switcher: PersonaSwitcher = PERSONA_SWITCHERS.includes(obj.switcher as PersonaSwitcher)
    ? (obj.switcher as PersonaSwitcher)
    : 'page';
  const availableKeys = narrowAvailableKeys(obj.availableKeys);
  const offered = availableKeys.length > 0 ? availableKeys : BUILT_IN_PERSONA_KEYS;
  const pinned = defaultPersonaKey.length > 0 ? defaultPersonaKey : DEFAULT_PERSONA_KEY;
  return {
    enabled: obj.enabled === true,
    defaultPersonaKey: offered.includes(pinned) ? pinned : (offered[0] ?? DEFAULT_PERSONA_KEY),
    availableKeys,
    allowRespondentSwitch: obj.allowRespondentSwitch === true,
    switcher,
  };
}

/**
 * The selectable persona library is fixed — always the full {@link BUILT_IN_PERSONAS} set. The
 * personas are hard-coded, not per-version config: any admin wanting a bespoke voice uses the
 * version's own interviewer tone & persona block instead. The stored `personas` Json (a legacy
 * column, always `[]` now) is ignored. Returns fresh copies so callers can't mutate the presets.
 */
export function narrowPersonas(_value?: unknown): PersonaOption[] {
  return BUILT_IN_PERSONAS.map((p) => ({ ...p }));
}

/** Find the persona to apply: the chosen key, else the configured default, else the first entry. */
export function selectPersona(
  personas: PersonaOption[],
  selectedPersonaKey: string | null,
  defaultPersonaKey: string
): PersonaOption | null {
  if (personas.length === 0) return null;
  const byChosen = selectedPersonaKey
    ? personas.find((p) => p.key === selectedPersonaKey)
    : undefined;
  if (byChosen) return byChosen;
  const byDefault = personas.find((p) => p.key === defaultPersonaKey);
  return byDefault ?? personas[0];
}

/**
 * The {@link ToneSettings} that governs an interviewer turn. When respondent persona-selection is
 * enabled, the chosen persona's tone REPLACES the version's `tone`; otherwise the version tone is
 * returned unchanged (byte-for-byte today's behaviour). Pure — the runtime resolves `personas`,
 * `personaSelection`, and the session's `selectedPersonaKey` and passes them in.
 */
export function resolveEffectiveTone(input: {
  toneConfig: ToneSettings;
  personas: PersonaOption[];
  personaSelection: PersonaSelectionSettings;
  selectedPersonaKey: string | null;
}): ToneSettings {
  const { toneConfig, personas, personaSelection, selectedPersonaKey } = input;
  if (!personaSelection.enabled) return toneConfig;
  // Confine the choice to the personas this questionnaire offers: a key chosen before the admin
  // un-ticked it is stale, and falls back to the pinned default like any other unknown key.
  const offered = availablePersonas(personas, personaSelection);
  const persona = selectPersona(
    offered.length > 0 ? offered : personas,
    selectedPersonaKey,
    personaSelection.defaultPersonaKey
  );
  return persona ? persona.tone : toneConfig;
}

/**
 * The tone that governs a live session's turns, applying the FULL persona gate — the single seam the
 * turn loop should use so the gate can't be re-derived inconsistently at the call site. On top of
 * {@link resolveEffectiveTone} it folds in the gate that lives outside the version config:
 *   - `allowRespondentSwitch` — a respondent's own stored `selectedPersonaKey` is honoured only when
 *     switching is allowed; otherwise the pinned default persona governs everyone (a stale key chosen
 *     while switching was on is ignored).
 */
export function resolveSessionTone(input: {
  toneConfig: ToneSettings;
  personas: PersonaOption[];
  personaSelection: PersonaSelectionSettings;
  selectedPersonaKey: string | null;
}): ToneSettings {
  const { toneConfig, personas, personaSelection, selectedPersonaKey } = input;
  const modeActive = personaSelection.enabled;
  const honorChoice = modeActive && personaSelection.allowRespondentSwitch;
  return resolveEffectiveTone({
    toneConfig,
    personas,
    personaSelection: { ...personaSelection, enabled: modeActive },
    selectedPersonaKey: honorChoice ? selectedPersonaKey : null,
  });
}

export { DEFAULT_PERSONA_SELECTION };
