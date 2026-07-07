/**
 * Interviewer tone & persona → system-prompt text (F-tone).
 *
 * Two pure helpers, no I/O — unit-tested in isolation:
 *   - {@link narrowToneSettings} coerces the opaque `tone` Json column (or any partial/garbage)
 *     into a complete, clamped {@link ToneSettings} — the read path and tests share it.
 *   - {@link buildToneInstructions} renders the *enabled* dimensions (+ persona) into a compact
 *     block of imperative clauses spliced into the conversational phraser's system prompt
 *     (`buildStreamingQuestionPrompt`). Disabled dimensions contribute nothing, so an all-off
 *     block (the default) yields `''` and the interviewer keeps today's voice.
 *
 * Each dimension maps a 1–5 slider to one clause. Bipolar dimensions (empathy, formality,
 * verbosity, readingComplexity, humour) emit nothing at the neutral midpoint (3) — absence *is*
 * neutral. Unipolar dimensions (mirroring, mimicry, warmth, curiosity) always emit when enabled.
 */

import {
  DEFAULT_TONE_SETTINGS,
  TONE_DIMENSION_KEYS,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  TONE_LEVEL_NEUTRAL,
  TONE_PERSONA_MAX_LENGTH,
  type ToneDimension,
  type ToneDimensionKey,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Round + clamp an arbitrary value to a valid 1–5 slider level (neutral when unparseable). */
function clampLevel(value: unknown): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : TONE_LEVEL_NEUTRAL;
  return Math.min(TONE_LEVEL_MAX, Math.max(TONE_LEVEL_MIN, n));
}

/** Coerce one (possibly missing/garbage) dimension to a complete, clamped {@link ToneDimension}. */
function narrowDimension(value: unknown): ToneDimension {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: raw.enabled === true,
    level: 'level' in raw ? clampLevel(raw.level) : TONE_LEVEL_NEUTRAL,
  };
}

/**
 * Project the stored `tone` Json (we wrote it, but it may be `{}`, partial, legacy-null, or
 * malformed) onto a complete {@link ToneSettings}: every dimension present, `enabled` strictly
 * boolean, `level` clamped to 1–5, persona text trimmed to the max length. Unknown keys are
 * dropped; missing ones fall back to {@link DEFAULT_TONE_SETTINGS}.
 */
export function narrowToneSettings(value: unknown): ToneSettings {
  const obj = isRecord(value) ? value : {};
  const dimensions = Object.fromEntries(
    TONE_DIMENSION_KEYS.map((key) => [key, narrowDimension(obj[key])])
  ) as Record<ToneDimensionKey, ToneDimension>;
  const persona = isRecord(obj.persona) ? obj.persona : {};
  return {
    ...dimensions,
    persona: {
      enabled: persona.enabled === true,
      text:
        typeof persona.text === 'string'
          ? persona.text.trim().slice(0, TONE_PERSONA_MAX_LENGTH)
          : DEFAULT_TONE_SETTINGS.persona.text,
    },
  };
}

/**
 * Per-dimension level→clause map — the single source of truth for the imperative clause each 1–5
 * slider position injects. An empty string at a level means "emit nothing" (neutral). Exported so the
 * admin tone editor can preview the exact clause a position adds (`tone-dimensions.tsx`), guaranteed
 * in sync with what the phraser actually sends.
 */
export const DIMENSION_PHRASES: Record<ToneDimensionKey, Record<number, string>> = {
  empathy: {
    1: 'Keep your manner matter-of-fact and neutral; do not dwell on feelings.',
    2: 'Lean factual — acknowledge any feelings only lightly.',
    3: '',
    4:
      'Be noticeably empathetic — briefly acknowledge how they might feel before moving on, and a ' +
      'little genuine personal warmth is welcome here.',
    5:
      'Lead with warmth and empathy: it is welcome here to express genuine personal warmth in the ' +
      'first person (e.g. "I\'m glad we can talk about this") and to name and gently validate the ' +
      'emotion in what they share before continuing.',
  },
  mirroring: {
    1: 'Do not paraphrase their answers back; simply acknowledge briefly and continue.',
    2: 'Occasionally reflect a key phrase of theirs back, briefly.',
    3: 'Often reflect the gist of what they said back, reframed in your own words, before the next question.',
    4: 'Usually mirror their answer — restate it reframed to show you understood — before moving on.',
    5: 'Always mirror: reframe and reflect back what they said in your own words to confirm understanding before each next question.',
  },
  formality: {
    1: 'Keep it casual and informal — contractions and relaxed phrasing, like a friendly chat.',
    2: 'Lean informal and relaxed.',
    3: '',
    4: 'Keep a professional, polished register.',
    5: 'Maintain a formal, professional register throughout — precise and businesslike.',
  },
  mimicry: {
    1: 'Keep your own neutral voice; do not adopt their wording.',
    2: 'Lightly echo a little of their vocabulary where it feels natural.',
    3: "Match the respondent's general tone and pick up some of their vocabulary.",
    4: "Closely mirror the respondent's vocabulary, register, and speech patterns.",
    5: "Strongly adopt the respondent's own words, phrasing, and rhythm so you sound like them.",
  },
  verbosity: {
    1: 'Be very terse — the fewest words that ask the question clearly.',
    2: 'Lean brief and to the point.',
    3: '',
    4: 'You may be a little fuller — add brief helpful context where it aids them.',
    5: 'Be expansive and thorough — give context and elaborate, while still asking about one thing.',
  },
  warmth: {
    1: 'Stay neutral; minimal praise or encouragement.',
    2: 'Offer light encouragement occasionally.',
    3: 'Be encouraging — affirm their effort as you go.',
    4: 'Be warmly encouraging — regularly affirm and reassure them.',
    5: 'Be highly encouraging and affirming — generous, genuine praise and reassurance throughout.',
  },
  curiosity: {
    1: 'Take answers at face value; avoid follow-ups and keep moving.',
    2: 'Ask a follow-up only when something is genuinely unclear.',
    3: 'Show curiosity — ask a light follow-up when an answer invites it.',
    4: 'Be curious and probing — often dig a little deeper with a follow-up before moving on.',
    5: 'Be highly curious — consistently probe for detail, examples, and the "why" before moving on.',
  },
  readingComplexity: {
    1: 'Use plain, everyday language and short sentences; avoid jargon entirely.',
    2: 'Lean towards simple, accessible language.',
    3: '',
    4: 'You may use richer vocabulary and more developed sentence structure.',
    5: 'Use sophisticated vocabulary and well-developed sentences; assume a high reading level.',
  },
  humour: {
    1: 'Stay strictly earnest and straightforward; no jokes or playfulness.',
    2: 'Keep it mostly earnest, with little levity.',
    3: '',
    4: 'A little light playfulness is welcome where it fits naturally.',
    5: "Be playful and good-humoured where it fits, keeping things light — never at the respondent's expense.",
  },
};

/** Add a full stop to a persona fragment that lacks terminal punctuation. */
function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The exact persona clause {@link buildToneInstructions} injects for a given free-text persona — the
 * leading "Adopt this persona…" wrapper around the admin's prose. Empty for blank text. Exported so
 * the tone editor can preview the precise clause the persona adds, without duplicating the wrapper.
 */
export function personaToneClause(personaText: string): string {
  const text = personaText.trim();
  if (text.length === 0) return '';
  return `Adopt this persona throughout — let it shape your voice and the perspective you bring: ${ensureSentence(text)}`;
}

/**
 * Render the enabled tone dimensions (+ persona) into a compact clause block for the phraser's
 * system prompt. Persona leads (it frames who is speaking), then the dimensions in declared order.
 * Returns `''` when nothing is enabled — the caller then emits no tone guidance at all.
 */
export function buildToneInstructions(tone: ToneSettings): string {
  const clauses: string[] = [];

  if (tone.persona.enabled) {
    const clause = personaToneClause(tone.persona.text);
    if (clause) clauses.push(clause);
  }

  for (const key of TONE_DIMENSION_KEYS) {
    const dim = tone[key];
    if (!dim.enabled) continue;
    const phrase = DIMENSION_PHRASES[key][dim.level];
    if (phrase) clauses.push(phrase);
  }

  return clauses.join(' ');
}
