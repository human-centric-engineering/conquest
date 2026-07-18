/**
 * Read-time resolution of a finding's `targetKey` into something an admin can read.
 *
 * A judge addresses its finding by `targetKey` — a slot `key` (`q_role`), `section:<title>`,
 * `goal`, or `audience` — because the pure core has no ids to hand it (see `JudgeFinding`).
 * That key is the right *machine* handle (it survives reordering and is what apply resolves
 * against), but on its own it tells the reviewer nothing: "q_role · Rewrite the question prompt"
 * gives no way to judge the suggestion without opening the structure editor in another tab.
 *
 * So we resolve the key to its subject — the question's prompt, its section, its position —
 * at read time, the same posture as `deriveFindingState`: never stored (a stored prompt would
 * rot the moment the question was reworded), always derived from the structures the read seam
 * already loads. Resolution prefers the **live** structure (what the admin would edit now) and
 * falls back to the run's snapshot, flagging `removed` when only the snapshot knows the target —
 * a question deleted since the run still gets named rather than showing a bare key.
 *
 * Pure: two {@link VersionStructureInput}s in, a view out. No Prisma.
 */

import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation';
import type { FindingTargetView } from '@/lib/app/questionnaire/views';
import { locateSlot } from '@/app/api/v1/app/questionnaires/_lib/evaluation-staleness';

/** The `section:` prefix a `targetKey` uses to address a section by title. */
const SECTION_PREFIX = 'section:';

/** Human labels for the two version-level targets, which have no structure node to name. */
const GOAL_LABEL = 'Questionnaire goal';
const AUDIENCE_LABEL = 'Target audience';

/**
 * Resolve one finding's `targetKey` against the live structure, falling back to the run's
 * snapshot. Returns `null` only when there is no structure to resolve against at all (both
 * loads failed) — the UI then falls back to showing the raw key.
 *
 * A key that resolves in neither structure yields `kind: 'unknown'` with the key as its label:
 * judges occasionally invent a key, and a review card must still render (fail-cleanly, the same
 * posture apply takes when a key doesn't reconcile).
 */
export function resolveFindingTarget(
  targetKey: string,
  current: VersionStructureInput | null,
  snapshot: VersionStructureInput | null
): FindingTargetView | null {
  if (!current && !snapshot) return null;

  if (targetKey === 'goal') {
    return {
      kind: 'goal',
      key: targetKey,
      label: GOAL_LABEL,
      sectionTitle: null,
      position: null,
      removed: false,
    };
  }
  if (targetKey === 'audience') {
    return {
      kind: 'audience',
      key: targetKey,
      label: AUDIENCE_LABEL,
      sectionTitle: null,
      position: null,
      removed: false,
    };
  }

  if (targetKey.startsWith(SECTION_PREFIX)) {
    const title = targetKey.slice(SECTION_PREFIX.length);
    // A section is addressed by title, which is neither unique nor stable — "removed" here means
    // no live section carries that title any more (the staleness deriver treats ambiguity too,
    // but for *naming* the target a single match isn't required).
    const live = current?.sections.some((s) => s.title === title) ?? false;
    return {
      kind: 'section',
      key: targetKey,
      label: title,
      sectionTitle: null,
      position: null,
      removed: current !== null && !live,
    };
  }

  // A question, addressed by slot key. Prefer the live structure; fall back to the snapshot so a
  // since-deleted question is still named (marked `removed`) rather than shown as a bare key.
  const live = current ? locateSlot(current, targetKey) : null;
  const located = live ?? (snapshot ? locateSlot(snapshot, targetKey) : null);
  if (!located) {
    return {
      kind: 'unknown',
      key: targetKey,
      label: targetKey,
      sectionTitle: null,
      position: null,
      removed: false,
    };
  }
  return {
    kind: 'question',
    key: targetKey,
    label: located.question.prompt,
    sectionTitle: located.sectionTitle,
    // 1-based for display — the stored `indexInSection` is 0-based.
    position: located.indexInSection + 1,
    removed: live === null,
  };
}
