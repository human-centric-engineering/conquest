/**
 * Read-time staleness + applicability derivation for policy-evaluation findings (F18.8).
 *
 * A finding's suggestion can be made obsolete by an intervening edit — the rule reworded by hand,
 * the approach changed on the Settings tab, the question's slider moved. So `stale` is derived at
 * read time by diffing the targeted slice of the run's `policySnapshot` against the live config,
 * never stored as a flag that would rot. Same posture as both sibling panels.
 *
 * **Every comparison is per-op, and that is load-bearing here in a way it is not on the siblings.**
 * This panel has no reconcile step *and* a real collision case: three of its four dimensions can
 * propose an edit to the same field of the same object. Per-op staleness is therefore the only
 * thing stopping the second of two colliding findings from silently overwriting the first.
 *
 * The trap that follows: a `default:` branch that stringifies a whole block would mark EVERY
 * finding on that block stale the moment any one of them applied — a reviewer would apply one
 * strategy finding and watch the other three grey out for no reason they could see, and reasonably
 * conclude the panel was broken. So each op compares only the field it writes, and the fallbacks
 * are deliberately narrow.
 *
 * Pure: two {@link PolicyStructureInput}s plus the finding's `targetKey` and effective op. No
 * Prisma — the caller supplies both structures.
 */

import type {
  PolicyProposedEdit,
  PolicyStructureHouseRules,
  PolicyStructureInput,
  PolicyStructureQuestion,
  PolicyStructureStrategy,
} from '@/lib/app/questionnaire/policy-evaluation';
// Generic vocab shared with both sibling panels — not re-declared, per the module doc.
import type { FindingApplicability } from '@/lib/app/questionnaire/evaluation/types';

const HOUSE_RULE_PREFIX = 'house_rule:';
const QUESTION_PREFIX = 'question:';
const HOUSE_RULES_KEY = 'house_rules';
const STRATEGY_KEY = 'strategy';
const FIDELITY_KEY = 'fidelity';
const TONE_KEY = 'tone';

/** What the deriver needs about one finding (no DB row dependency). */
export interface PolicyStalenessInput {
  targetKey: string;
  /** The effective op (`editedOverride ?? proposedEdit`), or `null` when prose-only/degraded. */
  op: PolicyProposedEdit | null;
}

export interface DerivedPolicyFindingState {
  stale: boolean;
  applicable: FindingApplicability;
}

/**
 * How a policy finding can be actioned, from its effective op alone: no op → `manual`; any of the
 * twelve structured ops → `apply`.
 *
 * `deep-link` never applies here, deliberately. No policy op drafts something that does not exist
 * yet the way the design panel's `add_question` does, and keeping policy findings out of the
 * question editor is one of the four things that stops this panel colliding with that one.
 */
export function derivePolicyApplicability(op: PolicyProposedEdit | null): FindingApplicability {
  return op ? 'apply' : 'manual';
}

function findRule(rules: PolicyStructureHouseRules, id: string) {
  return rules.rules.find((r) => r.id === id) ?? null;
}

function findQuestion(
  structure: PolicyStructureInput,
  key: string
): PolicyStructureQuestion | null {
  return structure.fidelity.questions.find((q) => q.key === key) ?? null;
}

/** A rule-targeted finding. Compares only what the op writes. */
function isRuleFindingStale(
  op: PolicyProposedEdit | null,
  snap: NonNullable<ReturnType<typeof findRule>>,
  live: ReturnType<typeof findRule>
): boolean {
  if (!live) return true; // the rule was deleted since the run
  switch (op?.op) {
    case 'delete_house_rule':
      // Present in both → still deletable. Nothing about it can have "drifted" for this purpose.
      return false;
    case 'set_house_rule_enabled':
      return snap.enabled !== live.enabled;
    case 'edit_house_rule':
      return snap.text !== live.text || snap.kind !== live.kind || snap.trigger !== live.trigger;
    default:
      // Prose-only: the reviewer is acting on the rule's wording, so that is what must not have moved.
      return snap.text !== live.text;
  }
}

/** A strategy-targeted finding. Each op owns one field; nothing compares the whole blob. */
function isStrategyFindingStale(
  op: PolicyProposedEdit | null,
  snap: PolicyStructureStrategy,
  live: PolicyStructureStrategy
): boolean {
  switch (op?.op) {
    case 'set_approach':
      return snap.approach !== live.approach;
    case 'set_pace':
      return snap.pace !== live.pace;
    case 'set_opening_mode':
      return snap.openingMode !== live.openingMode;
    case 'set_tactics':
      // Only the tactics the op actually names — a finding that turns `reflect` on is not made
      // obsolete by someone toggling `batchRelated`.
      return (
        (op.probeDepth !== undefined && snap.probeDepth !== live.probeDepth) ||
        (op.reflect !== undefined && snap.reflect !== live.reflect) ||
        (op.batchRelated !== undefined && snap.batchRelated !== live.batchRelated)
      );
    default:
      // Prose-only: the arc as a whole is the subject, but still not the whole blob — the opening
      // examples are the assistant's territory and change independently of the arc's shape.
      return (
        snap.enabled !== live.enabled ||
        snap.approach !== live.approach ||
        snap.pace !== live.pace ||
        snap.openingMode !== live.openingMode
      );
  }
}

/** A fidelity-gate-targeted finding. */
function isFidelityFindingStale(
  op: PolicyProposedEdit | null,
  snapshot: PolicyStructureInput,
  current: PolicyStructureInput
): boolean {
  switch (op?.op) {
    case 'set_fidelity_enabled':
      return snapshot.fidelity.enabled !== current.fidelity.enabled;
    case 'set_default_fidelity':
      return snapshot.fidelity.defaultFidelity !== current.fidelity.defaultFidelity;
    default:
      return (
        snapshot.fidelity.enabled !== current.fidelity.enabled ||
        snapshot.fidelity.defaultFidelity !== current.fidelity.defaultFidelity
      );
  }
}

/**
 * Derive `{ stale, applicable }` for one policy finding.
 *
 * With no snapshot (should not happen — every run carries one — but degrades safely), staleness
 * cannot be derived: `stale: false` best-effort, applicability still from the op. Applied and
 * declined findings are terminal and should be short-circuited by the caller before this runs.
 */
export function derivePolicyFindingState(
  input: PolicyStalenessInput,
  snapshot: PolicyStructureInput | null,
  current: PolicyStructureInput
): DerivedPolicyFindingState {
  const op = input.op;
  const applicable = derivePolicyApplicability(op);
  if (!snapshot) return { stale: false, applicable };

  let stale = false;

  if (input.targetKey === STRATEGY_KEY) {
    stale = isStrategyFindingStale(op, snapshot.strategy, current.strategy);
  } else if (input.targetKey === FIDELITY_KEY) {
    stale = isFidelityFindingStale(op, snapshot, current);
  } else if (input.targetKey === TONE_KEY) {
    // Only the dial the op names. Someone turning humour down does not obsolete a finding about
    // verbosity.
    if (op?.op === 'set_tone_dimension') {
      const dimension = op.dimension;
      const snapDial = snapshot.tone.dials.find((d) => d.key === dimension) ?? null;
      const liveDial = current.tone.dials.find((d) => d.key === dimension) ?? null;
      stale =
        (snapDial === null) !== (liveDial === null) ||
        (snapDial !== null && liveDial !== null && snapDial.displayLevel !== liveDial.displayLevel);
    } else {
      stale = snapshot.tone.personaSelectionEnabled !== current.tone.personaSelectionEnabled;
    }
  } else if (input.targetKey === HOUSE_RULES_KEY) {
    // `add_house_rule` has nothing existing to have drifted.
    stale =
      op?.op === 'add_house_rule'
        ? false
        : snapshot.houseRules.enabled !== current.houseRules.enabled;
  } else if (input.targetKey.startsWith(HOUSE_RULE_PREFIX)) {
    const id = input.targetKey.slice(HOUSE_RULE_PREFIX.length);
    const snap = findRule(snapshot.houseRules, id);
    stale = snap ? isRuleFindingStale(op, snap, findRule(current.houseRules, id)) : false;
  } else if (input.targetKey.startsWith(QUESTION_PREFIX)) {
    const key = input.targetKey.slice(QUESTION_PREFIX.length);
    const snap = findQuestion(snapshot, key);
    if (snap) {
      const live = findQuestion(current, key);
      // A question absent from the CURRENT sample is not necessarily deleted — the loader caps the
      // list at 150 and prefers non-Balanced questions, so a question whose slider was moved to
      // Balanced can legitimately drop out. Treating that as "removed" would show a false
      // target-gone; the apply engine re-checks against the real row anyway.
      stale = live ? snap.storedLevel !== live.storedLevel : false;
    }
  }

  return { stale, applicable };
}
