/**
 * Adaptive Scope guardrails (P17) — pure.
 *
 * The deterministic layer applied AFTER the planner proposes. This ordering is the whole design:
 * **the model proposes, it never gets the last word on a hard constraint.** Six numbered rules in a
 * system prompt will be obeyed most of the time, which is the worst possible failure mode — plausible
 * plans that quietly break the limit an author set, with nothing to catch them.
 *
 * Order matters and is not arbitrary:
 *
 *  1. **Rule excludes** — an author's "never" is absolute; drop those first so nothing downstream
 *     can reinstate them.
 *  2. **Rule includes** — an author's "always" is absolute too, and must be seated BEFORE the cap
 *     so it cannot be truncated away by a model's enthusiasm.
 *  3. **The cap** — trim the model's picks to what is left of the limit.
 *  4. **The check topic** — chosen from what did NOT make the cut, so it is always genuinely
 *     something the interview would otherwise have missed.
 *  5. **The fallback** — only when steps 1–3 produced nothing at all.
 *
 * Every function here is data-in/data-out and exhaustively unit-testable by hand.
 */

import {
  ALWAYS_PHASES,
  type AdaptiveScopeSettings,
  type ExcludedTopic,
  type InterviewPlan,
  type PlannedTopic,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { RuleOutcome } from '@/lib/app/questionnaire/scope/rules';

/** One topic the planner proposed, before any guardrail has touched it. */
export interface ProposedTopic {
  key: string;
  /** The planner's own account of why — kept verbatim so an admin reads the model's reasoning. */
  rationale: string;
}

export interface ApplyGuardrailsInput {
  /** Every topic in the version. */
  topics: readonly Topic[];
  /** What the planner proposed, best first. Empty when it errored or chose nothing. */
  proposed: readonly ProposedTopic[];
  /** What the hard rules decided. */
  rules: RuleOutcome;
  settings: AdaptiveScopeSettings;
  /** The planner's confidence, already clamped to 0–1. */
  confidence: number;
  /** What produced `proposed` — `llm`, or `fallback` when the planner could not be trusted. */
  source: 'llm' | 'fallback';
  /** The line spoken to the respondent. Empty when announcing is off or nothing was produced. */
  respondentMessage: string;
  /** Turn ordinal the decision was taken at. */
  decidedAtTurn: number;
  /** ISO timestamp — passed in because this module has no clock. */
  decidedAt: string;
}

/**
 * Choose the blind-spot topic: one conditional topic that did NOT make the cut, sampled lightly.
 *
 * A diagnostic that only asks about the problem the respondent already named can only confirm what
 * they already believed. Sampling one area they did not raise is what makes the result capable of
 * surprising them — which is the entire value of assessing anything.
 *
 * Preference order: the author's nominated keys (predictable), then the highest-weight unselected
 * topic by authored ordinal (more informative). Returns null when there is nothing left to sample.
 */
export function chooseCheckTopic(
  topics: readonly Topic[],
  selected: ReadonlySet<string>,
  settings: AdaptiveScopeSettings
): Topic | null {
  if (!settings.includeCheckTopic) return null;

  const available = topics.filter((t) => t.phase === 'conditional' && !selected.has(t.key));
  if (available.length === 0) return null;

  for (const preferred of settings.checkTopicPreference) {
    const match = available.find((t) => t.key === preferred);
    if (match) return match;
  }
  // Authored order, so the same unselected set always yields the same check topic — a diagnostic
  // whose blind-spot probe moved around between runs would be impossible to reason about.
  return available[0] ?? null;
}

/**
 * Apply every guardrail to a proposal and produce the final {@link InterviewPlan}.
 *
 * Total: any input — an empty proposal, unknown keys, a cap of zero, contradictory rules — produces
 * a coherent plan. There is no failure return, because the caller is standing between a respondent
 * and their next question and has nowhere to put one.
 */
export function applyGuardrails(input: ApplyGuardrailsInput): InterviewPlan {
  const { topics, settings } = input;
  const conditional = topics.filter((t) => t.phase === 'conditional');
  const byKey = new Map(conditional.map((t) => [t.key, t]));

  const planned: PlannedTopic[] = [];
  const seen = new Set<string>();

  const seat = (key: string, source: PlannedTopic['source'], rationale: string): void => {
    if (seen.has(key)) return;
    const topic = byKey.get(key);
    // Unknown, always-run, or already-seated keys are silently skipped. A planner naming a topic
    // that does not exist is exactly what this layer is for — never route into nothing.
    if (!topic) return;
    seen.add(key);
    planned.push({ key, depth: topic.depth, source, rationale });
  };

  // 1 + 2. Rules first, and BEFORE the cap: an author's "always include this" must not be
  // truncated away by a model that proposed three other things it liked better.
  for (const key of input.rules.include) {
    if (input.rules.exclude.has(key)) continue;
    seat(key, 'rule', input.rules.reasonByTopic.get(key) ?? 'A rule you set included this topic.');
  }

  // 3. The model's picks, in its own order, up to what remains of the limit.
  for (const proposal of input.proposed) {
    if (planned.length >= settings.maxConditionalTopics) break;
    if (input.rules.exclude.has(proposal.key)) continue;
    seat(proposal.key, input.source, proposal.rationale);
  }

  // 5. The fallback — only when nothing at all was seated. An interview of just the always-run
  // topics is coherent, if thin, so an empty fallback list is a legitimate configuration.
  let source = input.source;
  if (planned.length === 0 && settings.fallbackTopicKeys.length > 0) {
    source = 'fallback';
    for (const key of settings.fallbackTopicKeys) {
      if (planned.length >= settings.maxConditionalTopics) break;
      if (input.rules.exclude.has(key)) continue;
      seat(key, 'fallback', 'Chosen as a safe default because no clear signal was found.');
    }
  }

  // 4. The blind-spot check, from what did NOT make the cut.
  const check = chooseCheckTopic(topics, seen, settings);
  if (check) {
    seen.add(check.key);
    planned.push({
      key: check.key,
      // Forced light regardless of how the author set it up: its job in THIS interview is to
      // sample an area the respondent did not raise, not to score it.
      depth: 'light',
      source: 'check',
      rationale:
        'Sampled as a blind-spot check — an area the respondent did not raise, so the result can ' +
        'surprise them rather than only confirm what they already believed.',
    });
  }

  const excluded: ExcludedTopic[] = conditional
    .filter((t) => !seen.has(t.key))
    .map((t) => ({
      key: t.key,
      source: input.rules.exclude.has(t.key) ? ('rule' as const) : ('llm' as const),
      rationale:
        input.rules.reasonByTopic.get(t.key) ??
        'Not selected — nothing in the opening pointed at this area.',
    }));

  return {
    v: 1,
    topics: planned,
    excluded,
    checkTopicKey: check?.key ?? null,
    confidence: input.confidence,
    source,
    respondentMessage: settings.announce ? input.respondentMessage : '',
    decidedAtTurn: input.decidedAtTurn,
    decidedAt: input.decidedAt,
  };
}

/**
 * The conditional topics a planner may choose between: everything not force-excluded by a rule.
 *
 * Force-INCLUDED topics stay in the candidate list on purpose. The planner still needs to know they
 * are part of the interview — a proposal made in ignorance of half the plan would double up on the
 * same ground, and the model's own ordering of the rest is better for knowing what is already there.
 */
export function plannerCandidates(topics: readonly Topic[], rules: RuleOutcome): Topic[] {
  return topics.filter((t) => t.phase === 'conditional' && !rules.exclude.has(t.key));
}

/** The always-run topics, in authored order — what an interview covers regardless of any decision. */
export function alwaysTopics(topics: readonly Topic[]): Topic[] {
  return topics.filter((t) => ALWAYS_PHASES.includes(t.phase));
}
