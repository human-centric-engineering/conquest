/**
 * Read-time resolution of a scope finding's `targetKey` into something an admin can read.
 *
 * Mirrors `evaluation-target.ts`'s design over the scope panel's own vocabulary — `topic:<key>`
 * resolves to the topic's label, `rule:<id>` to its rendered sentence, and `settings` to a fixed
 * label. Resolution prefers the LIVE config and falls back to the run's snapshot, flagging
 * `removed` when only the snapshot knows the target.
 *
 * Pure: two {@link ScopeStructureInput}s in, a view out. No Prisma.
 */

import type { ScopeStructureInput } from '@/lib/app/questionnaire/scope-evaluation';
import type { ScopeFindingTargetView } from '@/lib/app/questionnaire/views';

const TOPIC_PREFIX = 'topic:';
const SETTINGS_KEY = 'settings';
const SETTINGS_LABEL = 'Conditional topics settings';

/**
 * Resolve one scope finding's `targetKey` against the live config, falling back to the run's
 * snapshot. `null` only when there is no structure to resolve against at all. A key that resolves
 * in neither structure yields `kind: 'unknown'` with the key as its label — a judge occasionally
 * invents a key, and a review card must still render.
 */
export function resolveScopeFindingTarget(
  targetKey: string,
  current: ScopeStructureInput | null,
  snapshot: ScopeStructureInput | null
): ScopeFindingTargetView | null {
  if (!current && !snapshot) return null;

  if (targetKey === SETTINGS_KEY) {
    return { kind: 'settings', key: targetKey, label: SETTINGS_LABEL, removed: false };
  }

  if (targetKey.startsWith(TOPIC_PREFIX)) {
    const key = targetKey.slice(TOPIC_PREFIX.length);
    const live = current?.topics.find((t) => t.key === key) ?? null;
    const located = live ?? snapshot?.topics.find((t) => t.key === key) ?? null;
    if (!located) {
      return { kind: 'unknown', key: targetKey, label: targetKey, removed: false };
    }
    return {
      kind: 'topic',
      key: targetKey,
      label: located.label,
      removed: current !== null && live === null,
    };
  }

  return { kind: 'unknown', key: targetKey, label: targetKey, removed: false };
}
