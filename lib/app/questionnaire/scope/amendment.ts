/**
 * Respondent amendment (P17.6) — "actually, ask me about talent."
 *
 * The plan is decided once, from an opening. That is the right design — a plan that shifted under a
 * running interview would make a finished report unreproducible — but it means a respondent whose
 * opening under-sold something has no way to correct it. This module is that way.
 *
 * ## Only ever adds
 *
 * An amendment can bring an excluded topic INTO scope. It can never remove one. A respondent
 * declining a topic the instrument requires is a different feature with different consequences
 * (partial scoring, an incomparable cohort), and quietly allowing it here would make every
 * completed assessment mean something slightly different.
 *
 * ## Three tiers, cheapest first — and the first two cost nothing
 *
 * 1. **A cue gate.** Nearly every respondent turn is an answer, not a request. A regex over the
 *    message rules those out before anything else runs, so the overwhelming majority of turns pay
 *    literally nothing for this feature.
 * 2. **A label match.** "Ask me about talent" against a topic called "Talent" needs no judgement,
 *    and resolving it deterministically means the common case is also the free one.
 * 3. **A judgement**, only when the first two leave it open — "can we cover hiring?" against a topic
 *    called "People & capability". That is the case worth paying a model call for.
 *
 * Pure: no Prisma, no Next. The DB seam and the model call live in
 * `app/api/v1/app/questionnaire-sessions/_lib/amend-plan.ts`.
 */

import type {
  InterviewPlan,
  PlanAmendment,
  ScopeDecisionSource,
  Topic,
} from '@/lib/app/questionnaire/scope/types';

/** How much of a respondent message is worth scanning. Requests come early, not in paragraph nine. */
export const AMENDMENT_SCAN_CHARS = 600;

/**
 * The phrasings that mean "add this to the interview".
 *
 * Deliberately narrow. A false NEGATIVE costs a respondent one unasked topic they can ask for again
 * in different words; a false POSITIVE spends a model call on every turn containing the word
 * "about", and — worse — risks widening an interview because someone mentioned a subject in
 * passing. Requests are phrased as requests, so the cues require the asking verb.
 */
const AMENDMENT_CUES: readonly RegExp[] = [
  /\b(?:ask|asking) me\b/i,
  /\bcan (?:we|you) (?:also )?(?:cover|discuss|talk about|ask about|include|look at)\b/i,
  /\bcould (?:we|you) (?:also )?(?:cover|discuss|talk about|ask about|include|look at)\b/i,
  /\bwhat about\b/i,
  // "I want to…", "I'd like to…", "I would like to…" — all one shape.
  /\bi(?:'d| would| really)? ?(?:like|want) to (?:talk about|discuss|cover|go into|hear about)\b/i,
  /\b(?:we|you) (?:should|need to) (?:also )?(?:cover|discuss|ask about|look at)\b/i,
  /\bdon'?t forget\b/i,
  /\bwhat happened to\b/i,
];

/**
 * Does this message look like a request to cover something?
 *
 * The gate that keeps this feature free on ordinary turns. Returns false for an empty message, and
 * only scans the opening {@link AMENDMENT_SCAN_CHARS}.
 *
 * **English only, by construction** — see {@link isEnglishLocale} for what happens elsewhere.
 */
export function looksLikeTopicRequest(message: string): boolean {
  const text = message.trim().slice(0, AMENDMENT_SCAN_CHARS);
  if (text.length === 0) return false;
  return AMENDMENT_CUES.some((cue) => cue.test(text));
}

/**
 * Is this version's respondent-facing language English?
 *
 * {@link AMENDMENT_CUES} is a list of English phrasings, so on a version whose `audience.locale`
 * says the interview is conducted in another language the gate can only ever return false —
 * silently, on every turn, for the whole feature. The interviewer already honours that locale
 * (`question-stream.ts` instructs it to respond in the respondent's language), so this is a
 * configuration the product supports and the gate did not.
 *
 * The answer is NOT a translated cue list. Authoring cue phrasings for every language the product
 * might be run in is work nobody here can check, and a bad cue list fails the same silent way. What
 * is language-neutral is the **topic labels**: they are written in the instrument's own language by
 * the person who wrote the instrument. So a non-English version gates on "does this message name an
 * excluded topic" and hands the request-or-not judgement to the agent tier, which reads meaning
 * rather than wording. It costs one indexed query per turn instead of nothing, and only on versions
 * that are not in English.
 *
 * Unset counts as English: `locale` is optional, most versions have none, and the pre-P17 behaviour
 * of every one of them was the English gate.
 */
export function isEnglishLocale(locale: string | null | undefined): boolean {
  const tag = locale?.trim().toLowerCase();
  if (!tag) return true;
  return tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_');
}

/**
 * Split a label into lowercase content tokens, dropping the joining words that match anything.
 *
 * Splits on non-letter/non-digit rather than on `[^a-z0-9]`, so an accented or non-Latin label
 * tokenises into its own words instead of being shredded into fragments — the label match is the
 * whole gate on a non-English version, and a gate that cannot see the alphabet it is reading is no
 * gate. The dropped joining words stay English-only on purpose: they are a precision tweak for
 * labels this build can read, and guessing another language's stopwords would cost recall.
 */
function labelTokens(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !['and', 'the', 'for', 'with', 'your'].includes(word));
}

/**
 * Resolve a request to one of the candidate topics by its label alone, or null.
 *
 * Returns null on an AMBIGUOUS match as well as no match — two topics whose labels both appear in
 * the message is precisely the case that needs judgement, and picking the first would be a coin
 * toss dressed as a decision.
 */
export function matchTopicByLabel(message: string, candidates: readonly Topic[]): Topic | null {
  const hits = candidateLabelHits(message, candidates);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Every candidate whose label appears in the message — including the ambiguous case
 * {@link matchTopicByLabel} refuses to resolve.
 *
 * This is the non-English gate: a message that names none of the excluded topics is not a request
 * to cover one, in any language. A message that names one still might not be ("we sorted talent
 * last year"), which is why a hit here leads to the agent tier rather than straight to an
 * amendment — the difference between naming a subject and asking for it is exactly the judgement
 * the English cue list encodes and a label match does not.
 */
export function candidateLabelHits(message: string, candidates: readonly Topic[]): Topic[] {
  const text = message.toLowerCase().slice(0, AMENDMENT_SCAN_CHARS);
  return candidates.filter((topic) => {
    const label = topic.label.toLowerCase().trim();
    if (label.length >= 4 && text.includes(label)) return true;
    const tokens = labelTokens(topic.label);
    // Every content token has to appear — "People & capability" must not match a bare "people",
    // which is a word an interview about staffing will contain constantly.
    return tokens.length > 0 && tokens.every((token) => text.includes(token));
  });
}

/**
 * The conditional topics an amendment may add: excluded by the plan, still present on the version.
 *
 * A topic already in scope is not a candidate — a respondent asking for something the interview is
 * about to cover anyway needs no amendment, and recording one would report a planner correction
 * that never happened.
 */
export function amendableTopics(plan: InterviewPlan, topics: readonly Topic[]): Topic[] {
  const inScope = new Set(plan.topics.map((t) => t.key));
  const excluded = new Set(plan.excluded.map((t) => t.key));
  return topics.filter(
    (topic) => topic.phase === 'conditional' && excluded.has(topic.key) && !inScope.has(topic.key)
  );
}

/** What {@link applyAmendment} produced. */
export interface AmendedPlan {
  plan: InterviewPlan;
  amendment: PlanAmendment;
}

/**
 * Add a topic to a plan at the respondent's request. Pure — returns a new plan.
 *
 * The added topic runs at `full` depth regardless of anything else: a respondent who asks to be
 * asked about something is asking to be assessed on it, and answering with a two-question sample
 * would be a worse response than the exclusion they objected to.
 *
 * The topic is removed from `excluded` rather than left in both lists, so the plan stays a single
 * coherent statement of what the interview covered. The amendment record preserves the fact that it
 * was once excluded.
 */
export function applyAmendment(
  plan: InterviewPlan,
  topic: Topic,
  input: { request: string; atTurn: number; at: string }
): AmendedPlan {
  const amendment: PlanAmendment = {
    key: topic.key,
    label: topic.label,
    request: input.request.trim().slice(0, 1_000),
    atTurn: input.atTurn,
    at: input.at,
  };

  return {
    amendment,
    plan: {
      ...plan,
      topics: [
        ...plan.topics,
        {
          key: topic.key,
          depth: 'full',
          source: 'respondent',
          rationale: `The respondent asked for this: "${amendment.request.slice(0, 200)}"`,
        },
      ],
      excluded: plan.excluded.filter((t) => t.key !== topic.key),
      amendments: [...(plan.amendments ?? []), amendment],
    },
  };
}

/**
 * How much of a newly-added area there is, in words a respondent would use (F17.33).
 *
 * The count is the number of items the interview will ACTUALLY ask about — `plannedMembers` after
 * depth and any explicit subset — not everything the topic holds. A `light` topic really is two
 * items, so "just a couple of questions" is a true statement rather than a softener; a respondent
 * told that and then asked nine would rightly stop believing the next thing the interviewer says
 * about how long this will take.
 *
 * Deliberately vague at the top end. "About fourteen questions" is a number nobody asked for and a
 * commitment the run budget may not keep; "a fair bit of ground" sets the same expectation without
 * promising an amount.
 */
export function topicSizeWording(itemCount: number): string {
  if (itemCount <= 0) return 'not much';
  if (itemCount <= 2) return 'just a couple of questions';
  if (itemCount <= 5) return 'a handful of questions';
  return 'a fair bit of ground';
}

/**
 * The reason a respondent may be told for an area being added — or `null` when there is none that
 * can honestly be given.
 *
 * **The blind-spot check must never carry a reason.** Its honest reason is "you did not raise this",
 * and `chooseCheckTopic` has an ABSENCE of signal, not evidence about the respondent: saying it out
 * loud converts a sampling decision into a claim about what they left out. The whole three-way
 * naming split in `conditional-topics.md` exists to stop that claim being made on any surface, and
 * this is the surface where it would be made to the person themselves.
 *
 * A respondent-requested area is the opposite case, and the easiest reason in the product: they
 * said it, in their own words, and those words are already on the record.
 */
export function respondentReasonFor(input: {
  source: ScopeDecisionSource;
  /** The respondent's own words, for an area they asked for. */
  request?: string;
}): string | null {
  if (input.source === 'check') return null;
  const request = input.request?.trim();
  return request ? request : null;
}

/**
 * The line the interviewer is asked to weave in on the turn after an amendment.
 *
 * A briefing instruction rather than a fixed sentence, for the same reason the original
 * announcement is: an acknowledgement in the interviewer's own voice reads as the same person still
 * listening, where a canned "Topic added." reads as a form that took an input.
 *
 * It carries three things (F17.33), because an area appearing mid-conversation with no explanation
 * is the moment a respondent starts wondering what else is being decided about them:
 *
 *  - **What** — the area's own label, in the instrument's own language.
 *  - **How much** — {@link topicSizeWording}, so several new questions arriving is something they
 *    were told about rather than something that happened to them.
 *  - **Why** — their own words. This is the one case where the reason needs no model call and no new
 *    field: `PlanAmendment.request` is already on the record. The earlier version of this line
 *    forbade explaining at all, which read as the interview quietly reorganising itself.
 *
 * The vocabulary ban stays, and it is what makes giving a reason safe: the interviewer may say what
 * it will now cover and why, and may not say anything about how the interview decides.
 */
export function amendmentBriefingLine(input: {
  amendment: PlanAmendment;
  /** How many items the added area will actually contribute. Omitted ⇒ no size claim is made. */
  itemCount?: number;
}): string {
  const { amendment } = input;
  const reason = respondentReasonFor({ source: 'respondent', request: amendment.request });
  const size = input.itemCount === undefined ? null : topicSizeWording(input.itemCount);

  return [
    'On the previous turn the respondent asked you to cover something you had not been going to, ' +
      'and you have agreed.',
    'Before your next question, acknowledge that briefly and warmly in your own words: say that ' +
      `you will now cover ${amendment.label}` +
      (size ? `, that there is ${size} on it` : '') +
      (reason ? `, and tie it to what they actually asked for — they said: "${reason}"` : '') +
      '.',
    'Refer to it the way a person would, not by quoting a label back at them.',
    'Do not apologise, do not explain how the interview decides what to ask, and do not use the ' +
      'words topic, section, plan, scope or depth.',
  ].join(' ');
}
