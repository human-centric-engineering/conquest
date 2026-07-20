/**
 * Defensive narrowing for the stored `refinementHistory` Json (P15.5).
 *
 * `AppDataSlotFill.refinementHistory` is an untyped `Json` column holding `RefinementHistoryEntry[]`.
 * It reaches the synthesis material — and therefore a prompt — so it is narrowed at the boundary
 * rather than cast, in line with the no-`as`-on-external-data rule.
 *
 * Fails soft to `[]` throughout: a malformed history means "we cannot tell this story", never a
 * failed synthesis. Individual malformed entries are dropped rather than sinking the whole array,
 * because one bad row should not cost a facilitator the other nine movements in a breakout.
 */

import { isRecord } from '@/lib/utils';
import type { RefinementHistoryEntry } from '@/lib/app/questionnaire/refinement/types';
import { ANSWER_PROVENANCES, narrowToEnum } from '@/lib/app/questionnaire/types';

/** A finite number, or null. Guards NaN/Infinity, both reachable through a JSON round-trip. */
function asConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrow one stored entry.
 *
 * `rationale` is REQUIRED to be a non-empty string: an entry without one carries no story, and the
 * material builder drops it anyway. Rejecting it here keeps the invalid shape from travelling.
 * `previousValue` / `newValue` stay `unknown` deliberately — they are whatever the data slot holds,
 * and the material builder renders them safely.
 */
function narrowEntry(value: unknown): RefinementHistoryEntry | null {
  if (!isRecord(value)) return null;
  const rationale = typeof value.rationale === 'string' ? value.rationale : '';
  if (!rationale.trim()) return null;

  return {
    previousValue: value.previousValue,
    previousProvenance: narrowToEnum(
      typeof value.previousProvenance === 'string' ? value.previousProvenance : '',
      ANSWER_PROVENANCES,
      'direct'
    ),
    newValue: value.newValue,
    rationale,
    // `source` is a free vocabulary on the refinement side; the synthesis does not branch on it,
    // so it is passed through as a string rather than narrowed against a tuple that may grow.
    source: (typeof value.source === 'string'
      ? value.source
      : 'refinement') as RefinementHistoryEntry['source'],
    ...(typeof value.turnIndex === 'number' && Number.isFinite(value.turnIndex)
      ? { turnIndex: value.turnIndex }
      : {}),
    previousConfidence: asConfidence(value.previousConfidence),
    newConfidence: asConfidence(value.newConfidence),
  };
}

/** Narrow the stored history array, dropping entries that cannot be read. */
export function narrowRefinementHistory(value: unknown): RefinementHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(narrowEntry).filter((e): e is RefinementHistoryEntry => e !== null);
}
