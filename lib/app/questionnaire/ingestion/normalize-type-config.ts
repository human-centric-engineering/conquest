/**
 * Choice-config normaliser for extractor / composer output (F1.1 follow-up).
 *
 * The extractor's structured-output schema is deliberately loose —
 * `suggestedTypeConfig` is `z.record(z.string(), z.unknown())`
 * (`ingestion/extraction-schema.ts`), so a model is free to shape a choice
 * question's options however it likes. But every downstream reader
 * (`form/type-config.ts` `readChoicesConfig`, the interviewer's `choiceOptions`,
 * the admin `ChoicesEditor`) parses through the TIGHT authoring schema, which
 * requires `choices: [{ value, label }, …]` with ≥2 distinct values. A model
 * that emits a bare string array (`["Never", "Once or twice"]`) — the shape the
 * prompt historically showed — passes ingestion validation, is stored verbatim,
 * and then renders as NOTHING selectable because the tight read schema rejects it.
 *
 * This helper closes that gap deterministically at the persistence boundary
 * ({@link file://../../../../app/api/v1/app/questionnaires/_lib/persist.ts}
 * `writeGraph`): it coerces whatever shape the model produced into the canonical
 * `{ value, label }` option list. Prompts are probabilistic; this makes the
 * option list survive regardless of formatting drift.
 *
 * Pure: no Prisma / Next. Non-choice types (and unreadable configs) pass through
 * untouched.
 */

import { isRecord } from '@/lib/utils';
import type { QuestionType } from '@/lib/app/questionnaire/types';
import { nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';

/** The canonical option shape every downstream reader expects (see `choiceSchema`). */
interface NormalizedChoice {
  value: string;
  label: string;
}

const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set(['single_choice', 'multi_choice']);

/**
 * Snake_case slug for a choice `value`, matching the prompt's `snake_case`
 * instruction and the `defaultTypeConfig` convention (`option_1`, …). Deliberately
 * NOT `slugifyKey` — that strips stopwords and caps at 4 words, which would mangle
 * an option label ("Once or twice" → "once_twice"). We keep every word: NFKD-fold
 * accents (so "café" → "cafe"), lowercase, collapse every non-alphanumeric run
 * (including the combining marks NFKD leaves behind) to `_`, and trim. Returns ''
 * when the label has no slug-able characters (e.g. a stray glyph) — the caller
 * falls back to a positional value so a value is never empty.
 */
function slugifyChoiceValue(label: string): string {
  return label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Coerce a single raw `choices` entry into `{ value, label }`, or `null` when it
 * carries no usable label. Accepts a bare string (the label IS the option text)
 * or an object with `label` and/or `value` (a half-populated object gets its
 * missing side derived).
 */
function coerceChoice(raw: unknown, index: number): NormalizedChoice | null {
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (!label) return null;
    return { value: slugifyChoiceValue(label) || `option_${index + 1}`, label };
  }
  if (isRecord(raw)) {
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const rawValue = typeof raw.value === 'string' ? raw.value.trim() : '';
    // A model sometimes emits only one side; use whichever it gave as the label.
    const effectiveLabel = label || rawValue;
    if (!effectiveLabel) return null;
    const value = rawValue || slugifyChoiceValue(effectiveLabel) || `option_${index + 1}`;
    return { value, label: effectiveLabel };
  }
  return null;
}

/**
 * Normalise a raw `choices` value into a distinct-valued option list, or `null`
 * when it is not an array. Colliding values get a `_2`, `_3`, … suffix via
 * {@link nextAvailableKey} (the same disambiguation the question-key writer uses),
 * so the tight schema's uniqueness rule holds; empty/unusable entries are dropped.
 */
function normalizeChoices(rawChoices: unknown): NormalizedChoice[] | null {
  if (!Array.isArray(rawChoices)) return null;
  const taken = new Set<string>();
  const out: NormalizedChoice[] = [];
  rawChoices.forEach((entry, index) => {
    const choice = coerceChoice(entry, index);
    if (!choice) return;
    const value = nextAvailableKey(choice.value, taken);
    taken.add(value);
    out.push({ value, label: choice.label });
  });
  return out;
}

/**
 * Normalise an extractor/composer `suggestedTypeConfig` for persistence. For
 * `single_choice`/`multi_choice`, rewrites `choices` into the canonical
 * `{ value, label }[]` shape. Everything else — non-choice types, non-object
 * configs, or a choice config that yields fewer than 2 usable options — is
 * returned unchanged (there is nothing to safely invent; the admin corrects a
 * degenerate list in the Structure editor).
 */
export function normalizeSuggestedTypeConfig(type: QuestionType, raw: unknown): unknown {
  if (!CHOICE_TYPES.has(type)) return raw;
  if (!isRecord(raw)) return raw;
  const choices = normalizeChoices(raw.choices);
  if (!choices || choices.length < 2) return raw;
  return { ...raw, choices };
}
