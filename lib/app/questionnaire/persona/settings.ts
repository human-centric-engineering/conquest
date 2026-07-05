/**
 * Selectable interviewer personas (F-persona) — read-path narrowing + effective-tone resolution.
 *
 * Pure helpers, no I/O — unit-tested in isolation (mirrors `lib/app/questionnaire/chat/tone.ts`):
 *   - {@link narrowPersonaSelection} coerces the opaque `personaSelection` Json into a complete,
 *     clamped {@link PersonaSelectionSettings}.
 *   - {@link narrowPersonas} coerces the opaque `personas` Json into a valid {@link PersonaOption}[].
 *     An empty/malformed library falls back to {@link BUILT_IN_PERSONAS}; admin edits are merged over
 *     the built-ins by key so a partially-edited library still resolves the untouched built-ins.
 *   - {@link resolveEffectiveTone} picks the {@link ToneSettings} that governs a session: the chosen
 *     persona's tone when selection is on and a valid key is picked (falling back to the default
 *     persona), otherwise the version's own `tone`. This is the single seam the runtime uses to make
 *     a respondent's choice take effect.
 */

import {
  DEFAULT_PERSONA_KEY,
  DEFAULT_PERSONA_SELECTION,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_KEY_MAX_LENGTH,
  PERSONA_LABEL_MAX_LENGTH,
  type PersonaOption,
  type PersonaSelectionSettings,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';
import { narrowToneSettings } from '@/lib/app/questionnaire/chat/tone';
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
  return {
    enabled: obj.enabled === true,
    defaultPersonaKey: defaultPersonaKey.length > 0 ? defaultPersonaKey : DEFAULT_PERSONA_KEY,
  };
}

/** Coerce one (possibly garbage) library entry into a valid {@link PersonaOption}, or `null`. */
function narrowPersonaOption(value: unknown): PersonaOption | null {
  if (!isRecord(value)) return null;
  const key = narrowString(value.key, PERSONA_KEY_MAX_LENGTH);
  if (key.length === 0) return null;
  return {
    key,
    label: narrowString(value.label, PERSONA_LABEL_MAX_LENGTH),
    description: narrowString(value.description, PERSONA_DESCRIPTION_MAX_LENGTH),
    tone: narrowToneSettings(value.tone),
  };
}

/**
 * Project the stored `personas` Json onto a valid library. Empty/malformed input yields the full
 * {@link BUILT_IN_PERSONAS} set. When rows exist, each is narrowed and de-duplicated by key (first
 * wins), then any built-in persona the admin hasn't overridden is appended — so the default persona
 * is always present even if the admin only edited a subset.
 */
export function narrowPersonas(value: unknown): PersonaOption[] {
  const rows = Array.isArray(value) ? value : [];
  const narrowed = rows.map(narrowPersonaOption).filter((p): p is PersonaOption => p !== null);

  if (narrowed.length === 0) return BUILT_IN_PERSONAS.map((p) => ({ ...p }));

  const byKey = new Map<string, PersonaOption>();
  for (const p of narrowed) {
    if (!byKey.has(p.key)) byKey.set(p.key, p);
  }
  for (const builtIn of BUILT_IN_PERSONAS) {
    if (!byKey.has(builtIn.key)) byKey.set(builtIn.key, { ...builtIn });
  }
  return [...byKey.values()];
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

export { DEFAULT_PERSONA_SELECTION };
