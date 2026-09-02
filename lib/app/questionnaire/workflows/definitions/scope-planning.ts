/**
 * Workflow diagram: Conditional Topics session planning (P17).
 *
 * Runs ONCE per session, right after the turn that completes the opening topics —
 * `maybePlanScope` (`app/api/v1/app/questionnaire-sessions/_lib/plan-scope.ts`), which triggers
 * `planScope` (`lib/app/questionnaire/scope/planner.ts`). Two tiers, in order, and the order is
 * the whole design — **the model proposes, it never gets the last word on a hard constraint**:
 *
 *  1. **The Scope Planner** — a judgement call over the author's criteria and what the respondent
 *     actually said.
 *  2. **Guardrails** (`scope/guardrails.ts`) — the cap, the fallback, the budget fit, the
 *     blind-spot check — applied to whatever came back, so a model that ignores a limit cannot
 *     break it.
 *
 * `planScope` never throws: every failure mode — the opening still open, no agent configured, a
 * timeout, unparseable JSON, confidence below the floor — resolves to a plan (in the worst case,
 * every topic runs) rather than an exception. A thin interview is recoverable; a stuck turn is not.
 */

import { applies, diagram, inactive, node } from '@/lib/app/questionnaire/workflows/types';
import { SCOPE_PLANNER_AGENT_SLUG } from '@/lib/app/questionnaire/scope/constants';

export const scopePlanningWorkflow = diagram({
  slug: 'scope-planning',
  title: 'Conditional Topics session planning',
  description: "Decide which conditional topics this session's interview will cover, once.",
  sourceModule: 'app/api/v1/app/questionnaire-sessions/_lib/plan-scope.ts',
  entryStepId: 'opening-gate',
  steps: [
    node({
      id: 'opening-gate',
      name: 'Opening complete?',
      type: 'guard',
      x: 0,
      y: 0,
      description:
        'Planning waits until every member of every opening topic is covered — its data slots filled AND its questions answered. Both halves matter: an opening topic built only from questions used to read as complete before it had actually been asked.',
      meta: {
        note: 'A deterministic coverage check. Fail → the trigger is a no-op this turn; it re-checks after the next one.',
      },
      next: [{ targetStepId: 'planner', condition: 'Pass' }],
    }),
    node({
      id: 'planner',
      name: 'Scope Planner',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        "Reads the author's per-topic criteria against what the respondent actually said in the opening — their answers and data-slot fills — and selects which conditional topics this interview should cover, with a rationale and a confidence score per pick. Skipped entirely when there is no conditional topic to choose between, so paying for a foregone conclusion never happens.",
      meta: {
        agentSlug: SCOPE_PLANNER_AGENT_SLUG,
        note: 'Fail-soft: no agent configured, no provider, a timeout, or unparseable JSON all resolve to the fallback plan, not an exception.',
      },
      next: ['confidence-gate'],
    }),
    node({
      id: 'confidence-gate',
      name: 'Confidence ≥ floor?',
      type: 'guard',
      x: 660,
      y: 0,
      description:
        "The planner's confidence is checked against the version's configured minimum. Pass → the model's picks proceed to the guardrails. Fail → the picks are discarded and the plan falls back to whatever the guardrails' own fallback produces — the model's explanatory message is discarded with it, so the respondent is never told about topics the fallback did not choose.",
      meta: {
        note: 'A deterministic scalar comparison (settings.minConfidence). A planner call that failed outright is treated the same as confidence 0.',
        settings: [
          {
            key: 'conditionalTopics.minConfidence',
            label: 'Minimum planner confidence',
            effect: "Below this, the planner's picks are discarded in favour of the fallback plan.",
          },
        ],
      },
      next: [
        { targetStepId: 'guardrails', condition: 'Pass' },
        { targetStepId: 'guardrails', condition: 'Fail' },
      ],
    }),
    node({
      id: 'guardrails',
      name: 'Apply guardrails',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        "Six ordered, deterministic steps applied to whatever the rules and the planner produced: rule excludes drop first so nothing downstream can reinstate them; rule includes seat next, before the cap can truncate them away; the cap trims the model's picks to what is left of the limit; the fallback seats a topic only when the first three steps produced nothing at all; the budget fit drops from the bottom until the seated set costs no more than the session budget leaves; and a check topic is chosen from what did NOT make the cut, so it is always something the interview would otherwise have missed.",
      meta: {
        note: 'applyGuardrails() — pure, order is not arbitrary. The model never gets the last word on a hard constraint.',
      },
      next: ['persist'],
    }),
    node({
      id: 'persist',
      name: 'Persist interview plan',
      type: 'report',
      x: 1100,
      y: 0,
      description:
        'Write the resolved plan to the session\'s interviewPlan — guarded so a concurrent second call is a no-op rather than a silent replacement mid-interview — and record the run (including the deterministic-only path, so "why did this respondent get those topics" always has an answer).',
      meta: {
        note: 'Conditional write: interviewPlan must still be null, or the update is skipped entirely.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.config.conditionalTopics.enabled) {
      return inactive(
        'Conditional Topics is off for this version — every topic runs, and this planner never fires.'
      );
    }
    return applies(
      "Conditional Topics is on — this planner decides each session's conditional topics once the opening is answered."
    );
  },
});
