/**
 * Completion-sweep finding filter (pure) — the "final check" gate at submit time.
 *
 * A submit / early-finish runs one last contradiction pass over ALL answers before the session
 * completes and the respondent report is generated (a report built on contradictory answers would be
 * misleading). This pure helper decides which of the sweep's raw findings still deserve to surface,
 * consulting the session's {@link RaisedContradiction} ledger so the final check never re-nags about a
 * conflict already dealt with during the conversation:
 *
 *   - `resolved` / `kept` / `flagged` — already reconciled (or explicitly declined) mid-conversation.
 *     SUPPRESS: the respondent has had their say; re-raising at the finish line is the nagging the
 *     ledger exists to stop.
 *   - `unresolved` — raised but never reconciled (the probe was the last thing before they finished).
 *     SURFACE: this is exactly the "raise any unresolved contradictions as a final check" case.
 *   - not in the ledger — a genuinely NEW conflict the per-turn pass never caught (the sweep's real
 *     value: cross-slot conflicts only visible once every answer is in). SURFACE.
 *
 * DB-free and framework-free: the impure submit route runs the detector + persists; this only ranks.
 */

import { contradictionKey } from '@/lib/app/questionnaire/contradiction/detection-logic';
import type {
  ContradictionFinding,
  RaisedContradiction,
} from '@/lib/app/questionnaire/contradiction/types';

/**
 * Given the sweep's raw findings and the session ledger, return the findings that should be raised as
 * the final check — genuinely new conflicts plus still-`unresolved` ones — dropping any conflict
 * already `resolved` / `kept` / `flagged` this session. Order is preserved (highest-confidence-first
 * as the detector/normaliser produced it).
 */
export function filterSweepFindings(
  findings: ContradictionFinding[],
  ledger: readonly RaisedContradiction[]
): ContradictionFinding[] {
  const dealtWith = new Set(ledger.filter((r) => r.resolution !== 'unresolved').map((r) => r.key));
  return findings.filter((f) => !dealtWith.has(contradictionKey(f.slotKeys)));
}
