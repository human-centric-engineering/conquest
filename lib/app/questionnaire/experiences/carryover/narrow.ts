/**
 * Carry-over payload → defensive projection.
 *
 * `AppExperienceRun.carryOver` is an opaque Json column. We wrote it, but it may have been written
 * by an older deploy's shape, hand-edited, or truncated. This module narrows it structurally —
 * **never a cast** — so a malformed payload degrades to "less context" rather than escaping as an
 * untyped value into an interviewer prompt.
 *
 * Pure, no I/O. Shared by the read path and its tests.
 */

import type { Prisma } from '@prisma/client';

import { isRecord } from '@/lib/utils';
import { SENSITIVITY_SEVERITIES, type SensitivitySeverity } from '@/lib/app/questionnaire/types';
import type {
  CarriedSensitivityNote,
  CarryOverContext,
  CarryOverFill,
} from '@/lib/app/questionnaire/experiences/run/types';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Narrow to a severity, or null.
 *
 * Deliberately null-returning rather than defaulting through `narrowToEnum`: an unreadable
 * severity means "we do not know how sensitive this was", and silently reading it as `low` would
 * understate a disclosure the respondent actually made.
 */
function asSeverity(value: unknown): SensitivitySeverity | null {
  if (typeof value !== 'string') return null;
  return SENSITIVITY_SEVERITIES.find((s) => s === value) ?? null;
}

/**
 * Narrow one fill.
 *
 * A fill with no `key` is unusable — the key is how a routing rule and the prompt both name it —
 * so it is dropped rather than carried as an anonymous entry.
 */
function narrowFill(value: unknown): CarryOverFill | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const key = asString(obj.key);
  if (key === '') return null;
  return {
    key,
    name: asString(obj.name, key),
    theme: asNullableString(obj.theme),
    paraphrase: asNullableString(obj.paraphrase),
    // `value` is legitimately any JSON shape (string, number, array, object) — it is passed
    // through untouched and every consumer treats it as `unknown`.
    value: obj.value ?? null,
    confidence: asNullableNumber(obj.confidence),
  };
}

/** Narrow one carried safeguarding note. Requires a summary — a note with none says nothing. */
function narrowNote(value: unknown): CarriedSensitivityNote | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const severity = asSeverity(obj.severity);
  const summary = asString(obj.summary);
  if (!severity || summary === '') return null;
  return { severity, category: asString(obj.category, 'unspecified'), summary };
}

function narrowArray<T>(value: unknown, narrow: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const narrowed = narrow(item);
    if (narrowed) out.push(narrowed);
  }
  return out;
}

/**
 * Project a stored `carryOver` column onto a {@link CarryOverContext}, or null when it holds
 * nothing usable.
 *
 * Returns null (rather than an empty context) for a non-object column, so the caller's
 * "is this an experience leg with context?" check stays a single truthiness test.
 */
export function narrowCarryOver(value: unknown): CarryOverContext | null {
  const obj = asRecord(value);
  if (!obj) return null;

  return {
    fromStepKey: asString(obj.fromStepKey),
    fromSessionId: asString(obj.fromSessionId),
    fills: narrowArray(obj.fills, narrowFill),
    profile: asRecord(obj.profile),
    sensitivityLevel: asSeverity(obj.sensitivityLevel),
    sensitivityNotes: narrowArray(obj.sensitivityNotes, narrowNote),
    scores: asRecord(obj.scores),
    briefing: asNullableString(obj.briefing),
    openingLine: asNullableString(obj.openingLine),
    carriedThemes: narrowArray(obj.carriedThemes, (t) =>
      typeof t === 'string' && t.trim() !== '' ? t : null
    ),
    builtAt: asString(obj.builtAt),
  };
}

/** Narrow the session column's `sensitivityNotes` into the carried projection. */
export function narrowSessionSensitivityNotes(value: unknown): CarriedSensitivityNote[] {
  return narrowArray(value, narrowNote);
}

/**
 * Serialise a context for the `carryOver` Json column.
 *
 * `CarryOverFill.value` is legitimately `unknown` (a slot holds any JSON shape), which Prisma's
 * `InputJsonValue` will not accept directly. A JSON round-trip both satisfies the type and does
 * the right thing semantically: this is the moment the payload is FROZEN, and round-tripping
 * guarantees what is stored is exactly what a later read will see — no `undefined` keys, no Date
 * objects, no class instances that would deserialise differently.
 *
 * Returns `null` if the context somehow cannot be serialised (a cycle), which the column accepts
 * and `narrowCarryOver` reads back as "no carry-over" — a degraded but safe outcome.
 */
export function serialiseCarryOver(context: CarryOverContext): Prisma.InputJsonValue | null {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(context));
    return isRecord(parsed) ? (parsed as Prisma.InputJsonValue) : null;
  } catch {
    return null;
  }
}
