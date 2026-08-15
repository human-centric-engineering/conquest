/**
 * Adaptive Scope × scoring — the comparability checks (P17, F17.15). Pure.
 *
 * ## The question this answers
 *
 * Adaptive Scope decides which parts of an instrument a respondent is asked. Scoring combines
 * answers into a scale. Put the two together and a scale can be computed from a different subset of
 * its own items for every respondent — and `scoreSession` will return a number either way.
 *
 * F17.13 fixed the reporting half: `buildCohortDataset` computes scale means over respondents asked
 * the WHOLE scale and counts the rest as `partiallyAssessed`, so a chart never silently averages
 * two different instruments. That is the right behaviour and it has a consequence nobody is told
 * about at authoring time — **a scale that no plan can ever cover completely is excluded for every
 * respondent**, and the cohort report says "not reportable" after the instrument has been fielded.
 *
 * These checks move that discovery to the Topics tab, where it costs an edit rather than a re-run.
 *
 * ## Why the arithmetic is sound rather than suggestive
 *
 * "Can a plan ever seat all the topics this scale needs?" is a set-cover question: an item is asked
 * if ANY topic owning it is seated, so an item claimed by two topics is satisfied by either. The
 * minimum cover is NP-hard in general and trivial at these sizes — but a greedy answer can
 * OVERSTATE how many topics are needed, and overstating here means telling an author "no respondent
 * is ever asked all of this" when one might be. A warning that cries wolf is worse than no warning.
 *
 * So the count is taken from the items with exactly ONE owning topic. Those topics are unavoidable
 * — no cover omits them — which makes the number a lower bound on what any plan must seat, and a
 * finding raised from it is never a false alarm. In practice the two are the same number: a question
 * claimed by two topics is rare enough that `duplicate_membership` reports it as a mistake.
 *
 * ## What is deliberately NOT modelled
 *
 * `light` depth. A conditional topic seated as the blind-spot check contributes only its two
 * highest-weight members, so a scale drawing on it is partially assessed even when the topic IS
 * seated. That makes `scale_split_by_scope` an understatement, never an overstatement — the
 * finding already tells the author the scale is scope-dependent, and enumerating the depth case
 * would add a sentence without changing the fix.
 */

import {
  ALWAYS_PHASES,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';
import type { ScoringItem, ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

export interface ComparabilityInput {
  topics: readonly Topic[];
  settings: AdaptiveScopeSettings;
  /** The version's scoring schema. An empty one produces no findings — there is nothing to compare. */
  scoring: ScoringSchemaContent;
  /**
   * Every question / data-slot key the version actually has, when the caller knows them.
   *
   * Only used to separate two failures that look identical from the schema alone: a key that EXISTS
   * but belongs to no topic (an authoring mistake, fixable on the Topics tab, and an error) from one
   * that no longer exists at all (a stale scoring reference left behind by a deleted question, only
   * fixable in the scoring schema, and a warning). Without them the finding degrades to the
   * warning, because an error an admin cannot act on is worse than a warning they can.
   */
  inventory?: {
    questionKeys: readonly string[];
    dataSlotKeys: readonly string[];
  };
  /**
   * The time arithmetic (C7), when the caller priced it. Optional for the same reason
   * {@link ValidateScopeInput.seconds} is: pricing needs question types, and a caller without them
   * still gets the count-based findings.
   */
  seconds?: {
    /** Full-depth cost per topic key. */
    byTopicKey: Readonly<Record<string, number>>;
    /** What is left for routed topics after the always-run floor. */
    routedAllowance: number;
  };
}

/**
 * Whether the version still HAS the key this item scores.
 *
 * With no inventory to check against, the answer is "assume it does not" — which routes the finding
 * to the softer `scale_item_stale` warning. Guessing the other way would raise a launch-blocking
 * error on a key nobody can prove is missing.
 */
function existsOnVersion(item: ScoringItem, inventory: ComparabilityInput['inventory']): boolean {
  if (!inventory) return false;
  const keys = item.source === 'question' ? inventory.questionKeys : inventory.dataSlotKeys;
  return keys.includes(item.ref);
}

/** Every topic that would ask this item, whichever phase it sits in. */
function ownersOf(item: ScoringItem, topics: readonly Topic[]): Topic[] {
  const members = item.source === 'question' ? 'questionKeys' : 'dataSlotKeys';
  return topics.filter((t) => t.members[members].includes(item.ref));
}

/**
 * Check what routing does to each scale's comparability.
 *
 * Runs whether or not `enabled` is set: "what would routing do to my scores" is precisely the
 * question an author needs answered BEFORE they flip the switch, and afterwards the symptom is a
 * cohort report with an empty column. The messages say "while Adaptive Scope is on" so a finding
 * read against a switched-off version is not mistaken for a live one.
 */
export function checkScaleComparability(input: ComparabilityInput): ScopeIssue[] {
  const { topics, settings, scoring } = input;
  const issues: ScopeIssue[] = [];
  if (scoring.items.length === 0 || scoring.scales.length === 0) return issues;

  const cap = settings.maxConditionalTopics;
  // Topics a hard rule forces in (and no rule vetoes back out) — seated regardless of the cap.
  const excluded = new Set(
    settings.rules.filter((r) => r.action === 'exclude').map((r) => r.topicKey)
  );
  const ruleIncluded = new Set(
    settings.rules
      .filter((r) => r.action === 'include' && !excluded.has(r.topicKey))
      .map((r) => r.topicKey)
  );

  for (const scale of scoring.scales) {
    const items = scoring.items.filter((i) => i.scaleKey === scale.key);
    if (items.length === 0) continue;

    /** Scored keys that exist on the version but sit in no topic — never asked while scope is on. */
    const unowned: string[] = [];
    /** Scored keys the version no longer has at all — a stale schema reference. */
    const stale: string[] = [];
    /** Conditional topics NO cover can omit — the item they own is owned by nothing else. */
    const unavoidable = new Set<string>();
    /** Every conditional topic the scale touches — the breadth of its exposure to routing. */
    const touched = new Set<string>();

    for (const item of items) {
      const owners = ownersOf(item, topics);
      if (owners.length === 0) {
        (existsOnVersion(item, input.inventory) ? unowned : stale).push(item.ref);
        continue;
      }
      // An item in ANY always-run topic is asked of everyone, so it never puts the scale at risk —
      // even when a conditional topic also claims it.
      if (owners.some((t) => ALWAYS_PHASES.includes(t.phase))) continue;

      const conditionalOwners = owners.filter((t) => t.phase === 'conditional');
      for (const owner of conditionalOwners) touched.add(owner.key);
      if (conditionalOwners.length === 1) unavoidable.add(conditionalOwners[0].key);
    }

    if (unowned.length > 0 && topics.length > 0) {
      issues.push({
        severity: settings.enabled ? 'error' : 'warning',
        code: 'scale_item_unowned',
        message: `"${scale.name}" scores ${formatKeys(unowned)}, which belong${unowned.length === 1 ? 's' : ''} to no topic — so while Adaptive Scope is on ${unowned.length === 1 ? 'it is' : 'they are'} never asked and never contribute${unowned.length === 1 ? 's' : ''} to the scale.`,
      });
    }

    // Deliberately a WARNING even while the feature is on, and never an error. Deleting a question
    // does not prune the scoring schema, so a stale reference is both easy to acquire and
    // impossible to fix from the Topics tab — making it an error would block launch AND preview
    // with a message pointing at a surface where the key cannot be found.
    if (stale.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'scale_item_stale',
        message: `"${scale.name}" scores ${formatKeys(stale)}, which no longer exist${stale.length === 1 ? 's' : ''} on this version. Remove ${stale.length === 1 ? 'it' : 'them'} from the scoring schema — nothing can ever fill ${stale.length === 1 ? 'it' : 'them'}.`,
      });
    }

    if (touched.size === 0) continue;

    // ── Can any plan cover the whole scale? ────────────────────────────────────────────────
    // Both tests use `unavoidable` rather than `touched`, so neither can fire on a scale that some
    // plan could in fact cover. See the module note on why the count is taken that way.
    //
    // Rule-included topics are seated BEFORE the cap in `applyGuardrails` and are not truncated by
    // it, so a plan can legitimately exceed `maxConditionalTopics`. Counting them against the cap
    // would warn "no respondent is ever asked the whole scale" about a scale every respondent is
    // asked in full — the exact false alarm this module promises not to raise.
    const capBound = [...unavoidable].filter((key) => !ruleIncluded.has(key));
    if (capBound.length > cap) {
      issues.push({
        severity: 'warning',
        code: 'scale_never_whole',
        message: `"${scale.name}" draws on ${capBound.length} conditional topics your criteria must choose between, but a plan seats at most ${cap}. With Adaptive Scope on, no respondent is ever asked the whole scale — every score is partial and the cohort report has nothing to aggregate. Move the shared items into an always-run topic, or raise the limit to ${capBound.length}.`,
      });
      continue;
    }

    const seconds = input.seconds;
    if (seconds && settings.sessionBudgetSeconds > 0 && unavoidable.size > 0) {
      let needed = 0;
      for (const key of unavoidable) needed += seconds.byTopicKey[key] ?? 0;
      if (needed > seconds.routedAllowance) {
        issues.push({
          severity: 'warning',
          code: 'scale_never_whole',
          message: `"${scale.name}" draws on conditional topics costing about ${needed}s together, but only ${seconds.routedAllowance}s is left for routed topics. They can never all be seated, so with Adaptive Scope on no respondent is ever asked the whole scale.`,
        });
        continue;
      }
    }

    issues.push({
      severity: 'warning',
      code: 'scale_split_by_scope',
      message: `"${scale.name}" draws on ${touched.size === 1 ? 'a conditional topic' : `${touched.size} conditional topics`}, so while Adaptive Scope is on a respondent not routed to ${touched.size === 1 ? 'it' : 'all of them'} is scored on part of the scale. Cohort averages and band distributions exclude those respondents.`,
    });
  }

  return issues;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and 2 more` — a key list an author can act on without a scroll. */
function formatKeys(keys: readonly string[]): string {
  const quoted = keys.map((k) => `"${k}"`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} more`;
}
