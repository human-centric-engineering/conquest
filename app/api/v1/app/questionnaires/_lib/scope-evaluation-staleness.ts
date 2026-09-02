/**
 * Read-time staleness + applicability derivation for scope-evaluation findings (F17.21).
 *
 * Mirrors `evaluation-staleness.ts`'s design exactly, over the scope panel's own target
 * vocabulary (`topic:<key>` | `rule:<id>` | `settings`) instead of the question structure's.
 * A finding's suggestion can be made obsolete by an intervening edit — the topic's criteria
 * edited by hand, the rule it names deleted, the budget changed on the Settings tab — so this
 * derives `stale` at read time by diffing the targeted slice of the run's `scopeSnapshot`
 * against the live scope config, rather than storing a flag that would rot.
 *
 * Pure: operates on two {@link ScopeStructureInput}s + the finding's `targetKey` and effective
 * op. No Prisma — the caller (the run-detail read seam) supplies both structures.
 */

import type {
  ScopeProposedEdit,
  ScopeStructureInput,
  ScopeStructureSettings,
  ScopeStructureTopic,
} from '@/lib/app/questionnaire/scope-evaluation';
// Generic vocab shared with the design-evaluation panel — not re-declared per module doc.
import type { FindingApplicability } from '@/lib/app/questionnaire/evaluation/types';

const TOPIC_PREFIX = 'topic:';
const SETTINGS_KEY = 'settings';

/** What the deriver needs about one finding (no DB row dependency). */
export interface ScopeStalenessInput {
  /** The finding's `targetKey`: `topic:<key>` | `rule:<id>` | `settings`. */
  targetKey: string;
  /** The effective op (`editedOverride ?? proposedEdit`), or `null` when prose-only/degraded. */
  op: ScopeProposedEdit | null;
}

/** The derived read-time facts the view carries. */
export interface DerivedScopeFindingState {
  stale: boolean;
  applicable: FindingApplicability;
}

/**
 * How a scope finding can be actioned, from its effective op alone: no op → `manual`; any of the
 * eight structured ops → `apply`. Unlike the design-evaluation panel, no scope op creates a
 * draft that needs pre-filling (there is no `add_question` equivalent), so `deep-link` never
 * applies here.
 */
export function deriveScopeApplicability(op: ScopeProposedEdit | null): FindingApplicability {
  return op ? 'apply' : 'manual';
}

function findTopic(structure: ScopeStructureInput, key: string): ScopeStructureTopic | null {
  return structure.topics.find((t) => t.key === key) ?? null;
}

/** Is the topic-targeted finding stale? Compares only the field the op touches. */
function isTopicFindingStale(
  op: ScopeProposedEdit | null,
  snap: ScopeStructureTopic,
  live: ScopeStructureTopic | null
): boolean {
  if (!live) return true; // target removed since the run
  switch (op?.op) {
    case 'edit_topic_criteria':
      return (snap.criteria ?? null) !== (live.criteria ?? null);
    case 'edit_topic_depth':
      return snap.depth !== live.depth;
    default:
      return (snap.criteria ?? null) !== (live.criteria ?? null) || snap.depth !== live.depth;
  }
}

/** Is the settings-targeted finding stale? An addition (`add_fallback_topic`) never is. */
function isSettingsFindingStale(
  op: ScopeProposedEdit | null,
  snap: ScopeStructureSettings,
  live: ScopeStructureSettings
): boolean {
  switch (op?.op) {
    case 'adjust_budget':
      return (
        (op.sessionBudgetSeconds !== undefined &&
          snap.sessionBudgetSeconds !== live.sessionBudgetSeconds) ||
        (op.maxOpeningProbes !== undefined && snap.maxOpeningProbes !== live.maxOpeningProbes) ||
        (op.maxConditionalTopics !== undefined &&
          snap.maxConditionalTopics !== live.maxConditionalTopics)
      );
    case 'edit_planner_instructions':
      return snap.plannerInstructions !== live.plannerInstructions;
    case 'add_fallback_topic':
      return false; // nothing existing to have drifted
    default:
      return JSON.stringify(snap) !== JSON.stringify(live);
  }
}

/**
 * Derive `{ stale, applicable }` for one scope finding. With no snapshot (should not happen post
 * F17.21 — every run carries one — but degrades safely), staleness can't be derived: `stale:
 * false` (best-effort), applicability still from the op. Applied/declined findings are terminal
 * and should be short-circuited by the caller before this runs.
 */
export function deriveScopeFindingState(
  input: ScopeStalenessInput,
  snapshot: ScopeStructureInput | null,
  current: ScopeStructureInput
): DerivedScopeFindingState {
  const op = input.op;
  const applicable = deriveScopeApplicability(op);
  if (!snapshot) return { stale: false, applicable };

  let stale: boolean;
  if (input.targetKey === SETTINGS_KEY) {
    stale = isSettingsFindingStale(op, snapshot.settings, current.settings);
  } else if (input.targetKey.startsWith(TOPIC_PREFIX)) {
    const key = input.targetKey.slice(TOPIC_PREFIX.length);
    const snap = findTopic(snapshot, key);
    stale = snap ? isTopicFindingStale(op, snap, findTopic(current, key)) : false;
  } else {
    stale = false;
  }

  return { stale, applicable };
}
