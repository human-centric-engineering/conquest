/**
 * Re-reading the conversation when the interview grows (F17.33, phase B) — pure half.
 *
 * Conditional Topics settles what is asked, and it settles it LATE: the plan lands when the opening
 * completes, and a respondent amendment can add a topic later still. Everything the respondent said
 * before that moment was extracted against the scope of the time — `buildTurnContext` filters the
 * question and data-slot lists at one choke point, and the route narrows them again before handing
 * them to the extractor — so **a question that was out of scope on the turn it was answered was
 * never a candidate.**
 *
 * That is not an edge case. The opening exists to make the respondent talk broadly about their
 * situation, and the planner seats topics BECAUSE of what they said; the overlap between "what they
 * said in the opening" and "what the seated topics ask about" is the selection criterion, not a
 * coincidence. Without this the interviewer seats a topic and immediately asks a question the
 * transcript already answers.
 *
 * This module owns the two decisions that must be exhaustively testable: **what to re-read against**
 * and **what to keep of what comes back**. The loading, the model call and the writes live at the
 * route seam (`app/api/v1/app/questionnaire-sessions/_lib/widening-rescan.ts`) — the same split
 * `contradiction/completion-sweep.ts` uses.
 *
 * Three rules shape it, and each is a rule the surrounding machinery already keeps:
 *
 *  - **New keys only.** Anything already in scope was extracted at the time; re-reading it would
 *    fight the extractor and pay for the privilege.
 *  - **Gap-fill, never overwrite.** The rule `reconcileChatDataSlotFills` states: a question that
 *    already carries an answer is not this pass's business, whoever wrote it.
 *  - **Capped like an opportunistic fill, because that is what it is.** Nobody asked the question;
 *    the respondent volunteered something that happens to answer it. `capOpportunisticConfidence`
 *    lands it below the confidence floor (free text) or below "Confident" (typed), so it does not
 *    count toward completion until the interviewer corroborates it — and a `must_ask` question
 *    cannot be closed out by it at all, which `questionSatisfactionFloor` already guarantees.
 */

import { capOpportunisticConfidence } from '@/lib/app/questionnaire/capabilities/opportunistic-fill';
import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import { plannedMembers } from '@/lib/app/questionnaire/scope/resolve';
import type { InterviewPlan, Topic } from '@/lib/app/questionnaire/scope/types';

/** What one widening put in scope that was not in scope before. */
export interface RescanTargets {
  /** The topics to mark as re-read once the pass completes — the ledger's unit. */
  topicKeys: string[];
  /** Question keys to offer the re-read as candidates. */
  questionKeys: string[];
  /** Data-slot keys to offer the re-read as candidates. */
  dataSlotKeys: string[];
}

const EMPTY: RescanTargets = { topicKeys: [], questionKeys: [], dataSlotKeys: [] };

/**
 * Which topics still need re-reading, and what they hold.
 *
 * **Only `conditional` topics can qualify.** The always-run phases (`opening`, `core`, `closing`)
 * were in scope from the first turn, so nothing about them was ever missed — including on a session
 * whose plan never got made.
 *
 * The ledger (`AppQuestionnaireSession.rescannedTopicKeys`) is what makes this work for BOTH
 * triggers without either knowing about the other: at plan time every seated conditional topic is
 * absent from it, and after an amendment only the amended one is. A caller therefore never has to
 * say which widening it is reacting to — it asks what is outstanding.
 *
 * Depth is honoured (`plannedMembers`), so a `light` topic is re-read for the two items it will
 * actually ask about rather than every item it holds. Re-reading more than the interview will ask
 * would write answers to questions this respondent is never shown — the opposite of the "when in
 * doubt, ask" direction every other degradation in this feature takes.
 */
export function selectRescanTargets(input: {
  plan: InterviewPlan | null;
  topics: readonly Topic[];
  /** `AppQuestionnaireSession.rescannedTopicKeys` — topics already re-read this session. */
  scanned: readonly string[];
  weightByQuestionKey?: ReadonlyMap<string, number>;
  weightByDataSlotKey?: ReadonlyMap<string, number>;
}): RescanTargets {
  if (!input.plan) return EMPTY;

  const pending = pendingRescanTopics(input.plan, input.topics, input.scanned);
  if (pending.length === 0) return EMPTY;

  const plannedByKey = new Map(input.plan.topics.map((t) => [t.key, t]));
  const topicKeys: string[] = [];
  const questionKeys = new Set<string>();
  const dataSlotKeys = new Set<string>();

  for (const topic of pending) {
    const planned = plannedByKey.get(topic.key)!;

    topicKeys.push(topic.key);
    for (const key of plannedMembers(
      topic.members.questionKeys,
      planned.members?.questionKeys,
      planned.depth,
      input.weightByQuestionKey
    )) {
      questionKeys.add(key);
    }
    for (const key of plannedMembers(
      topic.members.dataSlotKeys,
      planned.members?.dataSlotKeys,
      planned.depth,
      input.weightByDataSlotKey
    )) {
      dataSlotKeys.add(key);
    }
  }

  return { topicKeys, questionKeys: [...questionKeys], dataSlotKeys: [...dataSlotKeys] };
}

/**
 * The conditional topics this session has in scope but has not yet re-read for.
 *
 * Split out from {@link selectRescanTargets} so the caller can answer "is there anything to do"
 * before paying for the question/data-slot loads a proper target list needs. On the overwhelming
 * majority of turns the answer is no, and this costs a set lookup.
 *
 * Only `conditional` topics can qualify: the always-run phases were in scope from the first turn,
 * so nothing about them was ever out of the extractor's sight. A planned key that resolves to no
 * topic is skipped rather than failing the pass — an author may delete a topic a live plan names,
 * and unresolvable keys are skipped everywhere in this feature.
 */
export function pendingRescanTopics(
  plan: InterviewPlan,
  topics: readonly Topic[],
  scanned: readonly string[]
): Topic[] {
  const done = new Set(scanned);
  const byKey = new Map(topics.map((t) => [t.key, t]));
  const out: Topic[] = [];
  for (const planned of plan.topics) {
    if (done.has(planned.key)) continue;
    const topic = byKey.get(planned.key);
    if (!topic || topic.phase !== 'conditional') continue;
    out.push(topic);
  }
  return out;
}

/**
 * Keep only the intents this pass is allowed to write, then cap them.
 *
 * Two filters and a ceiling, in that order:
 *
 *  1. **A candidate key.** `normalizeAnswerIntents` already drops a key that names no candidate;
 *     this is the belt to that braces, and it is the one that matters when the candidate list was
 *     narrowed after the prompt was built.
 *  2. **Not already answered.** Gap-fill only. A model reading a whole transcript will happily
 *     answer a question the respondent settled ten turns ago, and overwriting a `direct` capture
 *     with an inference is a strict downgrade.
 *  3. **The opportunistic ceilings**, with `provenance: 'inferred'` — nobody asked these questions.
 */
export function filterRescanIntents(
  intents: readonly AnswerSlotIntent[],
  opts: { candidateKeys: ReadonlySet<string>; answeredKeys: ReadonlySet<string> }
): AnswerSlotIntent[] {
  return capOpportunisticConfidence(
    intents.filter(
      (intent) => opts.candidateKeys.has(intent.slotKey) && !opts.answeredKeys.has(intent.slotKey)
    )
  );
}

/**
 * The transcript, oldest → newest, trimmed to a character budget from the END.
 *
 * Deliberately NOT the turn window the live loop uses (`RECENT_TURNS_WINDOW`): the whole point is to
 * look further back than a turn window reaches — the answer this pass is hunting was given in the
 * opening, which is exactly what a recency window drops. Trimming from the end keeps the most
 * recent exchanges when a very long session will not fit, on the reasoning that a topic seated by
 * an amendment was usually prompted by something said recently. Whole lines only, so no line is
 * half-quoted to the model.
 */
export function trimTranscript(lines: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (used + line.length > maxChars && kept.length > 0) break;
    kept.push(line);
    used += line.length;
  }
  return kept.reverse();
}

/** How much transcript one re-read may read. Generous — it runs at most a few times per session. */
export const RESCAN_TRANSCRIPT_MAX_CHARS = 24_000;

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The re-read's own prompt — deliberately NOT the per-turn extractor's.
 *
 * The extractor's framing is "here is the message the respondent just sent; what does it answer",
 * and it is right to lean in: someone has just been ASKED something and has replied. This pass is
 * the inverse situation and needs the inverse bias. Nobody asked these questions. The respondent
 * mentioned something in passing, or did not. The expected result is an empty list, and a prompt
 * that does not say so will produce a confident answer for every candidate, because a whole
 * transcript contains something vaguely adjacent to almost anything.
 *
 * Two rules do the work, and both are stated as instructions rather than hoped for:
 *
 *  - **Only the respondent's own words count.** A transcript carries the interviewer's questions
 *    too, and a question that names a subject is not an answer about it.
 *  - **Silence is the right answer.** Said plainly, with the reason, because a model told only
 *    "be conservative" still ships a hedge for every candidate.
 *
 * The output contract is the extractor's (`answerExtractionSchema`), so `normalizeAnswerIntents`
 * validates each value against its slot's real type and config with no second implementation.
 */
export function buildRescanPrompt(input: {
  transcript: readonly string[];
  candidateSlots: readonly ExtractionSlotView[];
  dataSlotCandidates?: readonly DataSlotCandidateView[];
}): { system: string; user: string } {
  const system = joinSections(
    section(
      'role',
      'You are re-reading a stretch of an interview that has already happened. Some questions have ' +
        'just become relevant that were not being asked at the time. Your job is to find out ' +
        'whether the respondent has ALREADY answered any of them, in their own words, somewhere in ' +
        'this transcript.'
    ),
    section(
      'rules',
      [
        "1. Only the RESPONDENT's own words count. The transcript contains the interviewer's " +
          'questions too; a question that mentions a subject is not an answer about it.',
        '2. Answering nothing is the normal, correct result. Nobody asked these questions, so most ' +
          'of them will simply not have come up. Return an empty list rather than a hedge.',
        "3. Do not infer from plausibility, from the respondent's role, or from what someone in " +
          'their situation usually thinks. Only from what they actually said.',
        '4. Quote the span you took it from in `sourceQuote`. If you cannot quote it, you do not ' +
          'have it.',
        '5. Set `confidence` to how sure you are that this really answers THIS question — not how ' +
          'sure you are that they said something related.',
      ].join('\n')
    ),
    section('transcript', input.transcript.join('\n')),
    section('questions_to_check', renderCandidates(input.candidateSlots)),
    ...(input.dataSlotCandidates && input.dataSlotCandidates.length > 0
      ? [
          section(
            'topics_to_check',
            'These are broader areas rather than single questions. Fill one only when the ' +
              'respondent genuinely covered it.\n' +
              input.dataSlotCandidates
                .map((d) => `- ${d.key} — ${d.name}: ${d.description}`)
                .join('\n')
          ),
        ]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"answers":[{"slotKey":string,"value":any,"confidence":number,' +
        '"provenance":"inferred","rationale":string,"sourceQuote":string,"paraphrase"?:string}]' +
        (input.dataSlotCandidates && input.dataSlotCandidates.length > 0
          ? ',"dataSlotFills":[{"dataSlotKey":string,"value":any,"paraphrase":string,' +
            '"confidence":number,"provenance":"inferred"}]'
          : '') +
        '}. An empty `answers` array is a valid and expected reply. No prose, no markdown fences.'
    )
  );

  return { system, user: 'Re-read the transcript now and reply as JSON.' };
}

/** One candidate rendered for the prompt: the key the model must use, the wording, and its shape. */
function renderCandidates(slots: readonly ExtractionSlotView[]): string {
  return slots
    .map((slot) => {
      const parts = [`- ${slot.key} (${slot.type}): ${slot.prompt}`];
      if (slot.guidelines) parts.push(`  guidance: ${slot.guidelines}`);
      const options = choiceLabels(slot.typeConfig);
      if (options.length > 0) parts.push(`  allowed values: ${options.join(' | ')}`);
      return parts.join('\n');
    })
    .join('\n');
}

/**
 * The permitted values of a choice-shaped slot, when it has any.
 *
 * Rendered because a typed answer the model invents a value for is dropped by
 * `normalizeAnswerIntents` — silently, and after we have paid for the call. Defensive about the
 * shape: `typeConfig` is a Json column, so anything could be in it.
 */
function choiceLabels(typeConfig: unknown): string[] {
  if (typeConfig === null || typeof typeConfig !== 'object') return [];
  const options = (typeConfig as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (typeof o === 'string') return o;
      if (o !== null && typeof o === 'object') {
        const v = (o as { value?: unknown }).value;
        if (typeof v === 'string') return v;
      }
      return null;
    })
    .filter((o): o is string => o !== null);
}
