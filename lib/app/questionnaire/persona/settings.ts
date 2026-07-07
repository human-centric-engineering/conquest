/**
 * Selectable interviewer personas (F-persona) — read-path narrowing + effective-tone resolution.
 *
 * Pure helpers, no I/O — unit-tested in isolation (mirrors `lib/app/questionnaire/chat/tone.ts`):
 *   - {@link narrowPersonaSelection} coerces the opaque `personaSelection` Json into a complete,
 *     clamped {@link PersonaSelectionSettings}.
 *   - {@link narrowPersonas} returns the fixed {@link BUILT_IN_PERSONAS} set. The persona library is
 *     hard-coded (not per-version config); the legacy `personas` Json is ignored.
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
import { BUILT_IN_PERSONAS } from '@/lib/app/questionnaire/persona/presets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function narrowString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** Coerce the opaque `personaSelection` Json into a complete {@link PersonaSelectionSettings}. */
export function narrowPersonaSelection(value: unknown): PersonaSelectionSettings {
  const obj = isRecord(value) ? value : {};
  const defaultPersonaKey = narrowString(obj.defaultPersonaKey, PERSONA_KEY_MAX_LENGTH);
  const switcher: PersonaSwitcher = PERSONA_SWITCHERS.includes(obj.switcher as PersonaSwitcher)
    ? (obj.switcher as PersonaSwitcher)
    : 'page';
  return {
    enabled: obj.enabled === true,
    defaultPersonaKey: defaultPersonaKey.length > 0 ? defaultPersonaKey : DEFAULT_PERSONA_KEY,
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
  const persona = selectPersona(personas, selectedPersonaKey, personaSelection.defaultPersonaKey);
  return persona ? persona.tone : toneConfig;
}

/**
 * The tone that governs a live session's turns, applying the FULL persona gate — the single seam the
 * turn loop should use so the gate can't be re-derived inconsistently at the call site. On top of
 * {@link resolveEffectiveTone} it folds in the two gates that live outside the version config:
 *   - `personaFlagEnabled` — the platform persona-selection flag(s) (`isPersonaSelectionEnabled()`).
 *     It's a kill-switch: built-in persona mode governs only when it AND the version toggle are on, so
 *     when the flag is off the version's own tone prevails (returned unchanged) even if a version was
 *     left with `personaSelection.enabled` true.
 *   - `allowRespondentSwitch` — a respondent's own stored `selectedPersonaKey` is honoured only when
 *     switching is allowed; otherwise the pinned default persona governs everyone (a stale key chosen
 *     while switching was on is ignored).
 */
export function resolveSessionTone(input: {
  toneConfig: ToneSettings;
  personas: PersonaOption[];
  personaSelection: PersonaSelectionSettings;
  selectedPersonaKey: string | null;
  personaFlagEnabled: boolean;
}): ToneSettings {
  const { toneConfig, personas, personaSelection, selectedPersonaKey, personaFlagEnabled } = input;
  const modeActive = personaFlagEnabled && personaSelection.enabled;
  const honorChoice = modeActive && personaSelection.allowRespondentSwitch;
  return resolveEffectiveTone({
    toneConfig,
    personas,
    // `enabled` carries the full platform-AND-version gate so the kill-switch genuinely disables mode.
    personaSelection: { ...personaSelection, enabled: modeActive },
    selectedPersonaKey: honorChoice ? selectedPersonaKey : null,
  });
}

export { DEFAULT_PERSONA_SELECTION };
