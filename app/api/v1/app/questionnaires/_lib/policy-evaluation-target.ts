/**
 * Resolve a policy finding's `targetKey` into the subject a reviewer reads (F18.8).
 *
 * Derived at read time from the live config with the run's snapshot as a fallback, so a target
 * deleted since the run still gets a name (marked `removed`) rather than showing as a bare key.
 *
 * Pure — the caller supplies both structures.
 */

import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation';
import type {
  PolicyFindingTargetKind,
  PolicyFindingTargetView,
} from '@/lib/app/questionnaire/views';

const HOUSE_RULE_PREFIX = 'house_rule:';
const QUESTION_PREFIX = 'question:';

/** Collapse and clip a label so a rule or prompt reads as one line in a list. */
function clip(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

const BLOCK_LABELS: Record<string, { kind: PolicyFindingTargetKind; label: string }> = {
  house_rules: { kind: 'house_rules', label: 'House rules' },
  strategy: { kind: 'strategy', label: 'Questioning approach' },
  fidelity: { kind: 'fidelity', label: 'Asking questions as written' },
  tone: { kind: 'tone', label: 'Interviewer tone' },
};

/**
 * Resolve one `targetKey`.
 *
 * A `question:` target is labelled **`Fidelity — "<prompt>"`**, never the bare prompt. That is one
 * of the four things keeping this panel from colliding with the question-design panel, which also
 * targets questions: the reader is told which subject is being judged before they read the finding,
 * so one question flagged by both panels never looks like one subject in two queues.
 */
export function resolvePolicyFindingTarget(
  targetKey: string,
  current: PolicyStructureInput | null,
  snapshot: PolicyStructureInput | null
): PolicyFindingTargetView | null {
  // Nothing to resolve against — the caller renders the raw key rather than a guess.
  if (!current && !snapshot) return null;

  const block = BLOCK_LABELS[targetKey];
  if (block) {
    return { kind: block.kind, key: targetKey, label: block.label, removed: false };
  }

  if (targetKey.startsWith(HOUSE_RULE_PREFIX)) {
    const id = targetKey.slice(HOUSE_RULE_PREFIX.length);
    const live = current?.houseRules.rules.find((r) => r.id === id);
    if (live) {
      return { kind: 'house_rule', key: targetKey, label: clip(live.text), removed: false };
    }
    const snap = snapshot?.houseRules.rules.find((r) => r.id === id);
    return {
      kind: 'house_rule',
      key: targetKey,
      label: snap ? clip(snap.text) : `Rule ${id}`,
      removed: true,
    };
  }

  if (targetKey.startsWith(QUESTION_PREFIX)) {
    const key = targetKey.slice(QUESTION_PREFIX.length);
    const live = current?.fidelity.questions.find((q) => q.key === key);
    if (live) {
      return {
        kind: 'question',
        key: targetKey,
        label: `Fidelity — “${clip(live.prompt, 90)}”`,
        removed: false,
      };
    }
    const snap = snapshot?.fidelity.questions.find((q) => q.key === key);
    // NOT necessarily deleted: the structure loader caps its question list at 150 and prefers
    // non-Balanced questions, so a question whose slider moved to Balanced can drop out of the
    // sample while still existing. `removed` is only claimed when the snapshot cannot name it
    // either — otherwise a truncated sample would report phantom deletions.
    return {
      kind: 'question',
      key: targetKey,
      label: snap ? `Fidelity — “${clip(snap.prompt, 90)}”` : `Question ${key}`,
      removed: !snap,
    };
  }

  return { kind: 'unknown', key: targetKey, label: targetKey, removed: false };
}
