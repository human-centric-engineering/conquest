/**
 * Prompt builder for the cross-judge reconciler.
 *
 * Pure and provider-agnostic, the same contract as `judge-prompt.ts`: `LlmMessage[]` out, no SDK
 * import, the wording free to evolve while the shape stays stable.
 *
 * The job is unlike a judge's. A judge reads the questionnaire and forms an opinion; the reconciler
 * reads *the opinions* and finds the wording that satisfies as many of them as it can. So the
 * questionnaire's goal and audience are context here, not the subject — the subject is a stack of
 * verdicts about one question, and the output is the phrasing that survives all of them.
 *
 * Two rules do the load-bearing work:
 *
 *  1. **Never trade one judge's fix for another's.** The failure mode this whole step exists to
 *     prevent is a rewrite that fixes clarity by reintroducing jargon the audience judge flagged.
 *  2. **Say what you could not fix.** A phrasing that quietly ignores a concern reads to the admin
 *     as consensus. `unresolved` is how the model admits that wording alone will not close
 *     something out — usually because the real fix is structural (split the question, change its
 *     answer type), which is not this step's to make.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import { MAX_ALTERNATIVES_PER_TARGET } from '@/lib/app/questionnaire/evaluation/reconcile-schema';
import type { EvaluationDimension } from '@/lib/app/questionnaire/evaluation/types';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

/** One judge's verdict about the target, as the reconciler reads it. */
export interface ReconcileJudgeInput {
  dimension: EvaluationDimension;
  /** The judge's display name, so the prompt reads as people rather than enum keys. */
  label: string;
  severity: string;
  proposedChange: string;
  rationale: string;
}

/** One contested question: what it currently says, and everything the panel said about it. */
export interface ReconcileTargetInput {
  key: string;
  /** The question as currently worded — what the alternatives replace. */
  prompt: string;
  /** Answer type (`free_text`, `likert`, …); `null` when unknown. */
  questionType: string | null;
  /** Positional chip ("Q3 · Background"); `null` when there is nothing to say. */
  context: string | null;
  /** Every judge that flagged it — at least two, or there would be nothing to reconcile. */
  judges: ReconcileJudgeInput[];
}

/** The questionnaire-level framing every alternative has to stay inside. */
export interface ReconcileContextInput {
  goal: string | null;
  audience: AudienceShape | null;
}

/** Render the audience the same way the judges saw it, so the reconciler is not working blind. */
function renderAudience(audience: AudienceShape | null): string {
  if (!audience) return '(no audience specified)';
  const lines: string[] = [];
  if (audience.description) lines.push(`description: ${audience.description}`);
  if (audience.role) lines.push(`role: ${audience.role}`);
  if (audience.expertiseLevel) lines.push(`expertise: ${audience.expertiseLevel}`);
  if (audience.locale) lines.push(`locale: ${audience.locale}`);
  if (audience.sensitivity) lines.push(`sensitivity: ${audience.sensitivity}`);
  return lines.length > 0 ? lines.join('\n') : '(no audience specified)';
}

/** One contested question and its stack of verdicts. */
function renderTarget(target: ReconcileTargetInput, index: number): string {
  const header = target.context
    ? `${index + 1}. [key=${target.key}] (${target.context}${target.questionType ? `, type=${target.questionType}` : ''})`
    : `${index + 1}. [key=${target.key}]${target.questionType ? ` (type=${target.questionType})` : ''}`;
  const judges = target.judges.map(
    (j) =>
      `   - ${j.label} (${j.dimension}, ${j.severity}): ${j.proposedChange}\n     why: ${j.rationale}`
  );
  return `${header}\n   CURRENT WORDING: ${target.prompt}\n   JUDGES:\n${judges.join('\n')}`;
}

const SYSTEM_RULES = `You are reconciling the verdicts of a panel of independent questionnaire judges.

Each judge reviewed the same questionnaire on ONE dimension only — clarity, coverage, duplicates, type fit, ordering, audience match, goal match — and none of them saw the others' opinions. That is by design: it keeps their verdicts independent. It also means that when several judges flag the SAME question, the admin is left holding several rewrites that each fix one thing and quietly undo another.

YOUR JOB
For each question below, propose the wording that satisfies AS MANY of that question's judges as possible, at once. You are rewriting wording — you are not redesigning the questionnaire.

RULES
- Never buy one judge's fix with another's. A rewrite that fixes the clarity complaint by reintroducing the jargon the audience judge flagged is a failure, not a compromise.
- Propose ${MAX_ALTERNATIVES_PER_TARGET} alternatives at most, best first. Offer a second ONLY when there is a real trade-off worth an admin's decision (brevity vs nuance, plain language vs precision). When one phrasing satisfies every judge, give exactly one — a menu recreates the problem you are here to solve.
- Keep the question's INTENT. You may change wording, order of clauses, and register. You may not change what is being asked, invent facts about the respondent's context, or answer a judge by deleting the substance they were worried about.
- "addresses" lists the dimensions a phrasing genuinely resolves. Do not claim a dimension you did not fix.
- "unresolved" lists concerns no wording of yours can fix — nearly always because the real fix is structural (split into two questions, change the answer type, move it to another section). Naming them is useful; pretending they are handled is not. Leave it empty when your alternatives cover everything.
- Stay inside the stated goal and audience. They are given as context and are not yours to change.
- Reconcile only the questions listed. Do not invent a key you were not given, and do not return a question you have nothing better to say about.

OUTPUT — respond with ONLY this JSON object, no prose around it and no code fences:
{
  "reconciliations": [
    {
      "targetKey": "<the key exactly as given>",
      "alternatives": [
        { "prompt": "<the rewritten question>", "addresses": ["clarity", "audience_match"], "note": "<why this wording, or what it trades away>" }
      ],
      "unresolved": ["type_fit"]
    }
  ]
}`;

/**
 * Build the system + user messages for one reconcile call over a batch of contested questions.
 * Batched deliberately: the alternative for one question never depends on another, but one call
 * costs one round-trip instead of N, and the model sees the questionnaire's voice as a whole.
 */
export function buildReconcilePrompt(
  targets: ReconcileTargetInput[],
  context: ReconcileContextInput
): LlmMessage[] {
  const body = [
    `GOAL:\n${context.goal ?? '(no goal specified)'}`,
    `AUDIENCE:\n${renderAudience(context.audience)}`,
    `CONTESTED QUESTIONS (${targets.length}, each flagged by more than one judge):\n\n${targets
      .map(renderTarget)
      .join('\n\n')}`,
  ].join('\n\n');

  return [
    { role: 'system', content: SYSTEM_RULES },
    {
      role: 'user',
      content: `Reconcile the judges' verdicts on each question below.\n\n${body}`,
    },
  ];
}

/**
 * Stricter retry message when the first response failed the contract. Does not echo the malformed
 * output (see `runStructuredCompletion`); with no issue paths the likely cause is a fence or a
 * response cut off at the token cap, so it asks for brevity as well as shape — the same reasoning
 * as `buildJudgeRetryMessage`.
 */
export function buildReconcileRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema. Keep the response short —' +
        ' at most one alternative per question, with brief notes — so the JSON object closes well' +
        ' within the token limit.';
  return (
    `Return ONLY the JSON object with a "reconciliations" array (each entry with "targetKey", ` +
    `an "alternatives" array of { "prompt", "addresses", "note" }, and an "unresolved" array), ` +
    `matching the specified shape exactly. Use only the keys and dimension names you were given.` +
    detail
  );
}
