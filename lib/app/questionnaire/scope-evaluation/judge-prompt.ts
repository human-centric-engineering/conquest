/**
 * Prompt builder for the scope-evaluation judges (F17.21).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` with no provider/SDK import, mirroring
 * `evaluation/judge-prompt.ts`. The rubric lives here, in code, not on the agent row — the seeded
 * judge agents carry a mirror of it purely so they're self-describing in the admin UI.
 *
 * Every judge is handed the SAME serialised config and the SAME `knownIssues` list — what
 * `validateConditionalTopics` already caught — and told explicitly not to repeat it. The four dimensions
 * are deliberately structural-only (no live session data, no `analytics/routing.ts` behavioural
 * findings): see `scope-evaluation/types.ts`'s module doc for why.
 *
 * Output contract (validated by `judge-schema.ts`): one JSON object with a continuous `score` in
 * [0, 1] and a `findings` array. Each finding addresses its target by `targetKey`: `topic:<key>`,
 * or the literal `settings`.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import { MAX_SCOPE_FINDINGS_PER_JUDGE } from '@/lib/app/questionnaire/scope-evaluation/judge-schema';
import type {
  ScopeEvaluationDimension,
  ScopeStructureInput,
  ScopeStructureTopic,
} from '@/lib/app/questionnaire/scope-evaluation/types';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import { ALWAYS_PHASES } from '@/lib/app/questionnaire/scope/types';

/** The rubric inserts for one dimension. */
interface ScopeDimensionRubric {
  focus: string;
  scale: string;
  ignore: string;
  editGuidance: string;
}

const DIMENSION_RUBRICS: Record<ScopeEvaluationDimension, ScopeDimensionRubric> = {
  criteria_quality: {
    focus:
      'Judge whether each CONDITIONAL topic\'s "include this when…" criteria is specific and observable from what an opening conversation could plausibly surface — not vague ("if relevant"), not requiring information the opening never gathers. Flag two topics whose criteria overlap so heavily that a real respondent would plausibly qualify for both when only one is meant to apply, or conflict outright.',
    scale: `- 1.0 — Every conditional topic's criteria is specific, observable, and distinct from the others.
- 0.7 — Mostly clear; one topic's criteria is a little vague or overlaps slightly with another.
- 0.5 — Several topics have vague or overlapping criteria.
- 0.3 — Most conditional topics' criteria would not reliably separate respondents.
- 0.0 — Criteria are pervasively vague, missing, or contradictory.`,
    ignore:
      'Whether a topic has NO criteria at all, or is conditional with an empty criteria field — the coherence checker already flags that (`conditional_without_criteria`) as an error/warning; do not repeat it. The budget (Budget-Realism judges that), or whether a topic is reachable at all (Coverage-and-Burden).',
    editGuidance:
      'When you can propose clearer criteria, target `"topic:<key>"` and attach `"proposedEdit": { "op": "edit_topic_criteria", "criteria": "<the full rewritten criteria text>" }`. Preserve the author\'s own list style (bullets, priority markers) where the original had one — you are sharpening the wording, not restructuring it, unless the structure itself is the problem.',
  },
  budget_realism: {
    focus:
      'Judge whether the session time budget and opening-probe allowance leave realistic room for the conditional topics that matter, using the PRE-COMPUTED cost figures given to you — never re-derive your own arithmetic. Consider: does the routed allowance comfortably fit more than one conditional topic at once (so the interview can actually adapt, not just pick one thing and stop)? Is `maxConditionalTopics` too tight for what the routed allowance can actually afford, or too loose relative to how many conditional topics exist? Does `maxOpeningProbes` (when the opening is limited) look sufficient for however many data-gathering questions the opening topic asks?',
    scale: `- 1.0 — The budget and caps are well-matched to the topic mix; the interview can meaningfully adapt within them.
- 0.7 — Mostly realistic; one figure is a little tight or a little generous.
- 0.5 — The budget or a cap noticeably constrains what the interview can actually do.
- 0.3 — The budget or caps make adaptation nearly impossible in practice.
- 0.0 — The numbers are incoherent (e.g. the allowance cannot fit even the cheapest topic).`,
    ignore:
      'Whether the budget is BELOW the mandatory floor, or too small for even the cheapest conditional topic — the coherence checker already catches both (`budget_below_floor`, `budget_admits_no_topic`) as an error/warning; do not repeat them. Criteria wording (Criteria-Quality).',
    editGuidance:
      'Target `"settings"` and attach `"proposedEdit": { "op": "adjust_budget", "sessionBudgetSeconds": <seconds>, "maxOpeningProbes": <n>, "maxConditionalTopics": <n> }` — include only the field(s) you are actually changing. If the fix is to the planner\'s own guidance rather than a number, use `{ "op": "edit_planner_instructions", "plannerInstructions": "<the full replacement text>" }`.',
  },
  coverage_and_burden: {
    focus:
      'Judge two things: (1) whether any conditional topic has no realistic path to ever being selected — its criteria describes something the opening cannot plausibly surface, or no fallback ever reaches it (an unreachable topic the respondent will never see, however relevant it might be); and (2) whether the topic set as a whole — its count and depth relative to the budget and cap — risks overburdening a respondent, i.e. there are so many plausible-sounding conditional topics that the planner is likely to seat as many as the cap allows on most respondents, defeating the purpose of narrowing at all.',
    scale: `- 1.0 — Every conditional topic is reachable, and the overall set is well-scoped to the budget.
- 0.7 — Mostly fine; one topic looks hard to reach or the set is a little heavy.
- 0.5 — A topic or two looks unreachable, or the topic count/depth looks likely to overburden most respondents.
- 0.3 — Multiple topics are effectively unreachable, or the set is clearly too broad for its budget.
- 0.0 — The conditional set does not meaningfully narrow anything, or several topics can never be asked.`,
    ignore:
      'A question or data slot belonging to no topic at all — the coherence checker already catches that (`orphaned_questions`, `orphaned_data_slots`); a topic with genuinely no members (`empty_topic`); whether the CAP itself is well-sized for the budget (Budget-Realism judges that number). You judge reachability and overall burden, not the arithmetic behind them.',
    editGuidance:
      'For an unreachable topic, target `"topic:<key>"` — if the fix is sharper criteria, attach `{ "op": "edit_topic_criteria", "criteria": "<rewritten>" }`; if the topic should be a safe default rather than something the planner has to notice on its own, target `"settings"` with `{ "op": "add_fallback_topic", "topicKey": "<key>" }`. For a topic that would read the same information more cheaply as a sample, target `"topic:<key>"` with `{ "op": "edit_topic_depth", "depth": "light" }`.',
  },
};

/** Render the pre-computed cost arithmetic into readable lines. */
function renderCosts(costs: ScopeStructureInput['costs']): string {
  const lines = [
    `session budget: ${costs.budgetSeconds > 0 ? formatSeconds(costs.budgetSeconds) : '(none set)'}`,
    `always-run topics cost: ${formatSeconds(costs.alwaysSeconds)}`,
    `left for routed (conditional) topics: ${formatSeconds(costs.routedAllowanceSeconds)}`,
  ];
  const perTopic = costs.perTopic
    .map(
      (c) =>
        `  - ${c.key}: full=${formatSeconds(c.fullSeconds)}, light=${formatSeconds(c.lightSeconds)}`
    )
    .join('\n');
  return perTopic.length > 0
    ? `${lines.join('\n')}\nper-topic cost:\n${perTopic}`
    : lines.join('\n');
}

/** Render one topic, numbering conditional topics for a readable flow. */
function renderTopic(topic: ScopeStructureTopic): string {
  const always = (ALWAYS_PHASES as readonly string[]).includes(topic.phase);
  const members =
    topic.members.length > 0
      ? topic.members.map((m) => `      - ${m.label}`).join('\n')
      : '      (no members)';
  const criteria = always ? '(always run — no criteria needed)' : (topic.criteria ?? '(none set)');
  return `  [key=${topic.key}] "${topic.label}" — phase=${topic.phase}, depth=${topic.depth}\n    criteria: ${criteria}\n    members:\n${members}`;
}

/** Render the known coherence-checker issues, so the judges see what is already caught. */
function renderKnownIssues(issues: ScopeStructureInput['knownIssues']): string {
  if (issues.length === 0) return '(none)';
  return issues.map((i) => `  - [${i.severity}/${i.code}] ${i.message}`).join('\n');
}

/** Serialise the whole scope config into the judge's user message. */
function renderStructure(structure: ScopeStructureInput): string {
  const sections: string[] = [];

  sections.push(
    `TOPICS (${structure.topics.length}):\n\n${structure.topics.map(renderTopic).join('\n\n')}`
  );

  sections.push();

  const s = structure.settings;
  sections.push(
    `SETTINGS:\n` +
      `  max conditional topics per interview: ${s.maxConditionalTopics}\n` +
      `  include blind-spot check topic: ${s.includeCheckTopic}\n` +
      `  fallback topics (used when the planner can't decide): ${s.fallbackTopicKeys.length > 0 ? s.fallbackTopicKeys.join(', ') : '(none)'}\n` +
      `  planner confidence floor: ${s.minConfidence}\n` +
      `  opening follow-ups limited: ${s.limitOpeningProbes} (allowance: ${s.maxOpeningProbes})\n` +
      `  planner instructions: ${s.plannerInstructions.trim().length > 0 ? s.plannerInstructions : '(none)'}`
  );

  sections.push(
    `TIME ARITHMETIC (pre-computed — use these numbers, do not re-derive them):\n${renderCosts(structure.costs)}`
  );

  sections.push(
    `ALREADY CAUGHT BY THE MECHANICAL COHERENCE CHECKER (do not repeat these as findings):\n${renderKnownIssues(structure.knownIssues)}`
  );

  return sections.join('\n\n');
}

/** The shared system frame, with the dimension's rubric spliced in. */
function systemRules(dimension: ScopeEvaluationDimension): string {
  const rubric = DIMENSION_RUBRICS[dimension];
  return `You are a design-time judge reviewing a conversational questionnaire's CONDITIONAL TOPICS configuration before it is launched — which topics are always asked, which are conditional and on what criteria, and the time budget. You evaluate ONE dimension and propose concrete edits.

The goal Conditional Topics serves: minimise how much a respondent is asked by skipping conditional topics that genuinely do not apply to them, WITHOUT ever silently dropping a topic that does apply. A topic wrongly excluded is a worse failure than a topic wrongly included.

YOUR DIMENSION
${rubric.focus}

SCORING SCALE — continuous 0.0 to 1.0. Use intermediate values (0.4, 0.6, 0.8, …) freely; don't snap to anchors.
${rubric.scale}

IGNORE
${rubric.ignore}

FINDINGS
- Emit a finding for each concrete issue you would fix on this dimension. A well-designed scope config yields an empty findings array — do not invent problems.
- Emit at most ${MAX_SCOPE_FINDINGS_PER_JUDGE} findings, ordered most severe first.
- **Lead with the fix, not the complaint.** Wherever an alternative is feasible, "proposedChange" must BE that alternative — the actual rewritten criteria, the specific number — not a description of what is wrong. Save the diagnosis for "rationale".
- Address each finding's "targetKey" precisely: a topic by its key as "topic:<key>", or the literal "settings" for something not about one topic.
- "severity": "major" (fix before launch), "minor" (real but not blocking), or "info" (nice-to-have).
- "proposedChange": the specific edit to make, in plain prose. "rationale": why, in one or two sentences. "sourceQuote": the offending text, when the finding points at a specific phrase in the criteria or the planner instructions.

STRUCTURED EDIT (optional)
${rubric.editGuidance}
Prefer attaching "proposedEdit" whenever the fix maps to the op above — it is what lets the admin apply your suggestion in one click. Omit it when no op fits, or when a field would have to be guessed: never invent a topic key or data-slot key you cannot see in the config.

OUTPUT — respond with ONLY this JSON object, no prose around it and no code fences:
{
  "score": <number 0.0-1.0>,
  "findings": [
    { "targetKey": "<topic:key | settings>", "severity": "info|minor|major", "proposedChange": "<edit>", "rationale": "<why>", "sourceQuote": "<optional quote>", "proposedEdit": <optional structured op, omit if none fits> }
  ]
}`;
}

/**
 * Build the system + user messages for one judge over one version's scope config. The system
 * message carries the dimension rubric; the user message carries the serialised topics,
 * settings, pre-computed costs, and the known coherence-checker issues.
 */
export function buildScopeJudgePrompt(
  dimension: ScopeEvaluationDimension,
  structure: ScopeStructureInput
): LlmMessage[] {
  return [
    { role: 'system', content: systemRules(dimension) },
    {
      role: 'user',
      content: `Evaluate the following conditional-topics configuration on your dimension.\n\n${renderStructure(structure)}`,
    },
  ];
}

/**
 * Stricter retry message when the first response failed schema validation — mirrors
 * `buildJudgeRetryMessage`.
 */
export function buildScopeJudgeRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema. Keep the response short —' +
        ' emit only your most important findings, with brief rationales — so the JSON object closes' +
        ' well within the token limit.';
  return (
    `Return ONLY the JSON object with a numeric "score" in [0, 1] and a "findings" array ` +
    `(each finding with "targetKey", "severity", "proposedChange", "rationale", an ` +
    `optional "sourceQuote", and an optional structured "proposedEdit"), matching the ` +
    `specified shape exactly. Omit "proposedEdit" rather than guessing one.` +
    detail
  );
}
