/**
 * Prompt builder for the Routing Analyst (P17.4).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. Its rubric lives here rather than in the
 * seeded agent's `systemInstructions` — the same load-bearing-prompt convention the extractor, the
 * verifier and the Glossary Analyst use.
 *
 * ## What makes this analyst different from the extractor
 *
 * Structure extraction reads a document for its QUESTIONS and deliberately discards everything
 * else. But real instruments carry material the extractor throws away: routing and skip-logic
 * notes, eligibility rules, guardrails, scoring notes, "how to use this" guidance — wherever the
 * author put them in the file. That material is the author telling you, in their own words, which
 * parts of the instrument apply to whom. This analyst exists to read exactly what the extractor
 * ignored.
 *
 * ## The hard part is grounding, not generation
 *
 * A model asked "what are the topics?" will confidently invent a clean taxonomy from the section
 * headings alone, and that answer is worse than useless: it looks authored, so an admin accepts it,
 * and the instrument now routes on the model's guess rather than the author's rule. So the rubric
 * spends most of its length on the distinction between QUOTING a routing instruction and INFERRING
 * one, and the contract makes the analyst declare which it did (`fromDocument`, and a per-item
 * `sourceQuote` that must be absent when nothing in the document said it).
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type { SourceDocumentRole } from '@/lib/app/questionnaire/constants';

import {
  ROUTING_ANALYSIS_MAX_GAPS,
  ROUTING_ANALYSIS_MAX_RULES,
  ROUTING_ANALYSIS_MAX_TOPICS,
} from '@/lib/app/questionnaire/scope/analysis-schema';
import {
  LIGHT_DEPTH_MEMBER_COUNT,
  MAX_CONDITIONAL_TOPICS_CEILING,
  SCOPE_RULE_OPERATORS,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';

/** One question, projected for the analyst — enough to assign it to a topic and no more. */
export interface RoutingAnalysisQuestion {
  key: string;
  prompt: string;
  sectionTitle?: string;
}

/** One data slot, projected for the analyst — the vocabulary its hard rules may test. */
export interface RoutingAnalysisDataSlot {
  key: string;
  name: string;
  theme?: string;
}

/**
 * One document the analyst reads.
 *
 * An instrument does not always arrive as one file. `primary` is the document the version's
 * questions were extracted from; `supplementary` is a companion an admin attached beside it — the
 * routing memo, the eligibility appendix — which carries no questions of its own and exists purely
 * to say who gets asked what.
 */
export interface RoutingAnalysisDocument {
  role: SourceDocumentRole;
  fileName?: string;
  text: string;
  /** The text was cut to fit the budget. The prompt says so, so nothing is quoted across the seam. */
  truncated?: boolean;
  /** The budget was already spent — the analyst is told the document exists but is not shown it. */
  omitted?: boolean;
}

export interface RoutingAnalysisInput {
  goal?: string | null;
  audience?: unknown;
  questions: RoutingAnalysisQuestion[];
  dataSlots?: RoutingAnalysisDataSlot[];
  /**
   * The instrument's own text and any companions attached to it — where the routing instructions
   * live, when they exist. Primary first, then supplementary in attachment order.
   */
  documents?: RoutingAnalysisDocument[];
  /** The version's current topics, so a re-run proposes a revision rather than a duplicate set. */
  existingTopics?: readonly Topic[];
  /** Admin's free-text steer for this run ("the routing rules are in the notes up front"). */
  instructions?: string;
}

const SYSTEM_RULES = `You are the Routing Analyst for a conversational questionnaire platform. You \
read a questionnaire instrument — in any subject area, and in whatever shape its author wrote it — \
and work out WHICH PARTS OF IT APPLY TO WHOM.

The platform models this with TOPICS. A topic is a named group of the instrument's questions with:
- a PHASE — one of:
  - "opening": runs first for everyone. Its answers are the signal everything else is decided from.
  - "core": runs for everyone, whatever they say.
  - "conditional": runs ONLY when it fits what the respondent conveyed. The only phase ever chosen \
between.
  - "closing": runs for everyone, at the end.
- CRITERIA — for conditional topics, the author's own account of when to include it.
- a DEPTH — "full" (every question) or "light" (a sample of the most important few).

SIZE IS NOT SIGNIFICANT. A topic may hold thirty questions or one. A ONE-QUESTION conditional topic \
is how a fine-grained dependency is expressed — "ask this single question only when the respondent \
said X" is a topic, not a special case. Do not force everything to section size.

## Read the author's guidance, not just the questions

Documents usually carry material that is not questions: routing or skip-logic notes, eligibility \
or screener rules, guardrails, scoring notes, "how to use this" guidance, facilitator or \
interviewer instructions. THAT MATERIAL IS YOUR PRIMARY SOURCE. It may sit anywhere the author \
chose to put it — a preamble or appendix, a heading part-way through, a sidebar or footnote, a \
separate sheet or section, a note beside the questions themselves. Find it wherever it is, read it \
first, and let it drive your proposal. It is where the author states which sections apply to whom, \
how many areas to cover, and what never to ask certain respondents.

## Quoting versus inferring — the distinction that matters most

- When the document STATES a routing rule, put its exact wording in "sourceQuote" and write \
"criteria" in the author's own language, not a paraphrase of your own.
- When the document says nothing and you are inferring a topic from the questions themselves, \
OMIT "sourceQuote" entirely. Never attach a quote to something you inferred, and never invent one.
- Set "fromDocument" true only when the document genuinely contained routing or eligibility \
instructions. If you built the whole proposal from section headings, set it false and say so in \
"summary". An administrator reviewing your work must be able to tell the difference between "I \
read your rules" and "I guessed from your headings" — getting this wrong is the single worst thing \
you can do here, because a guess that looks authored gets accepted.

## Covering the instrument

- EVERY question key you are given must belong to exactly one topic. A question in no topic can \
never be asked once this feature is on, and nothing else in the system reports it.
- Use the exact question keys supplied. Never invent a key, never alter one.
- Assign data slot keys to the topics whose questions they abstract over, where the mapping is clear.

## Phases

- Mark as "opening" the questions that gather the signal the rest is decided from — context, \
situation, what the respondent came here about. There should be exactly ONE opening topic, and it \
should be short: it is the price of admission, paid before the interview has proved its worth.
- Mark as "core" what every respondent must answer regardless.
- Mark as "conditional" the areas the instrument itself treats as sometimes-relevant.
- Mark as "closing" wrap-up questions worth comparing against the opening.
- If the instrument genuinely has no conditional areas, say so in "summary" and propose them all \
as core. That is a legitimate, useful answer — do not manufacture conditionality that is not there.

## Depth

"light" means the topic asks only its ${LIGHT_DEPTH_MEMBER_COUNT} highest-weighted questions and \
its ${LIGHT_DEPTH_MEMBER_COUNT} highest-weighted data slots. Everything else in that topic is never \
asked.

- NEVER set "light" on an "opening", "core" or "closing" topic. Those run for EVERY respondent, so \
"light" there does not sample — it silently deletes questions from the questionnaire. On the \
opening it is worse still: the opening is the signal every later decision is made from, and \
halving it halves what that decision is made from. Set "full".
- Use "light" ONLY on a "conditional" topic, and only where the document itself says that area is \
worth a quick look rather than a full pass ("touch on X briefly", "a couple of questions on Y").
- If the document says nothing about depth, use "full".

## Criteria

Write the CONDITION, not the instruction. "They said they have done this before" is judgeable; \
"ask this if relevant" is not. Describe what would be true of the respondent, in terms a reader of \
their opening answers could actually check.

## Hard rules

Propose a hard rule ONLY where the document states a CERTAINTY — "never ask X of Y", "always \
include Z when they said W". A rule is checked mechanically against one data slot, before any \
judgement, so it must be something the author is sure about, not a preference. Everything softer \
belongs in a topic's criteria.
- Each rule tests ONE data slot key from the list you are given, with one operator: \
${SCOPE_RULE_OPERATORS.join(', ')}.
- "action" is "include" (always ask this topic) or "exclude" (never ask it). Exclude beats include.
- Propose at most ${ROUTING_ANALYSIS_MAX_RULES} rules. Zero is the common and correct answer.

## Two settings that are not topics

Two settings sit outside the topic list. Until now you had nowhere to put the document's \
instructions about them, so you reported them as gaps. Stop doing that — put them here.

- "fallbackTopicKeys" — the topics to ask when the agent cannot work out a plan at all, either \
because it failed or because it was not confident enough. If the document names a safe default — \
"if in doubt, cover leadership and operations", "everyone should at least get the growth section" \
— list those topic keys. This list is used ONLY when nothing else was chosen; it is not a \
preference ordering.
- "checkTopicPreference" — the interview always adds ONE topic the respondent did NOT raise, asked \
at light depth, so the result can surprise them rather than only confirm what they already \
believed. If the document says which area is worth probing even unprompted — "always sanity-check \
culture", "carry two items from a section they did not pick" — list those topic keys, best first.

Both name keys from YOUR OWN "topics" list, and only conditional ones can be sampled as the check. \
Never name a key you did not propose. If the document says nothing about either, OMIT the field — \
do not supply a default, for the same reason you omit "maxConditionalTopics".

## Gaps — what you recognized but could not formalize

Sometimes the document plainly states a routing or eligibility instruction and you cannot express \
it AT ALL — not as a conditional topic's criteria, and not as a hard rule. It depends on \
information no question captures, it contradicts another instruction in the same document, it \
happens mid-interview rather than at the opening, or it is simply too vague to act on ("use \
judgement for edge cases"). Do not silently drop this. Do not force it into a topic's criteria or a \
rule just to have somewhere to put it, and do not paraphrase around the problem.

**A condition you DID express as a conditional topic's criteria is not a gap.** That is the \
mechanism working, and reporting it as a gap as well says the opposite. In particular, having no \
data slot to test a condition mechanically is NOT on its own a gap: criteria are judged against \
what the respondent conveyed, which is the normal way a conditional topic is decided, and a hard \
rule is the rare exception. When DATA SLOTS is empty EVERY condition is untestable by a rule, so a \
gap for each one says nothing about this document and buries the gaps that do.

**Three exceptions to that, and they matter more than anything else on this page. In each, writing \
the topic is NOT enough, because what you wrote does not mean what the document said.**

**1. TIMING — a block that is added when something COMES UP.** If the document says a block is \
added "at any stage", "at any point", "whenever they surface", "even in passing", "as soon as they \
mention it", or "even while answering something else", then putting that sentence into a \
conditional topic's criteria has quietly changed what it means. Scope here is settled ONCE, when \
the opening finishes, and is never revisited: a disclosure in the fortieth minute cannot add a \
block, however plainly the document says it must. \
STILL PROPOSE THE TOPIC — it is the closest this instrument can get, and a block belonging to no \
topic is worse than an imperfect one, because its questions could then never be asked at all. \
But report ONE GAP PER BLOCK: name that block, quote its own trigger sentence, and say plainly what \
will actually happen — it is decided at the end of the opening, so it is included only if the \
condition is already apparent by then. \
One gap about "the mechanism" is NOT enough. A reader who sees five triggered blocks proposed as \
ordinary conditional topics, and one general note about timing, will believe the five are handled. \
They are not, and on safeguarding, disclosure or eligibility text that belief is the whole risk.

**2. TERMINATION — an instruction that ENDS the interview rather than scoping it.** If the document \
says a condition means the respondent does not take this review at all — "stop the review", "end \
the conversation here", "they take X instead", "refer them and stop" — you cannot express that. The \
only actions available are to include a topic or exclude one; nothing can halt an interview, and \
excluding every topic is not the same thing and would leave the respondent in a session that simply \
asks nothing. \
Turning the screener's checks into ordinary opening questions does NOT express it either: asking \
"how long have you been trading?" captures the fact and discards the consequence, which is the part \
that mattered. Propose the questions if they are worth asking, and report a GAP quoting the stop \
instruction and saying that the review will continue regardless of the answer.

**3. CONTRADICTION — two places that disagree.** If the material states who gets asked what in two \
places and they conflict — a front-sheet table and a note later in the SAME file, a heading and an \
instruction, a summary and a detail — do not resolve it quietly, however reasonable the side you \
would pick. Propose what you judge best, and report the disagreement as a gap quoting BOTH places, \
so the admin knows a choice was made on their behalf. This applies WITHIN a single document, not \
only between two documents.

Report it as a GAP instead:
- "sourceQuote" is REQUIRED and must be the exact span that states the instruction. A gap you cannot \
quote is not a gap — if you cannot point to the words, you have nothing to report here.
- "explanation" says what you recognized and specifically why you could not express it at all \
(no question or answer could ever evidence it, contradicts another instruction, fires mid-interview, \
too vague to act on, references something undefined).

Report at most ${ROUTING_ANALYSIS_MAX_GAPS} gaps. Zero is the common and correct answer — most \
instruments state nothing you cannot formalize. Never invent a gap to seem thorough.

Do NOT report a gap for anything "fallbackTopicKeys" or "checkTopicPreference" can express. Those \
are formalizable — put them in the fields above.

## Breadth

If the document states how many areas one session should cover ("no more than three", "cover two \
to four themes"), report that number as "maxConditionalTopics". If it says nothing about breadth, \
OMIT the field — do not supply a default. Your guess would sit where the author's silence was.

Propose at most ${ROUTING_ANALYSIS_MAX_TOPICS} topics, and never more than \
${MAX_CONDITIONAL_TOPICS_CEILING} for "maxConditionalTopics".

Output ONLY a single JSON object — no prose, no code fences:
{
  "topics": [
    {
      "key": "<lowercase_snake_case>",
      "label": "<short human name>",
      "phase": "opening" | "core" | "conditional" | "closing",
      "criteria": "<when to include it — required for conditional, null otherwise>",
      "depth": "full" | "light",
      "questionKeys": ["<exact key from QUESTIONS>", ...],
      "dataSlotKeys": ["<exact key from DATA SLOTS>", ...],
      "rationale": "<one sentence: why this is a topic, and this phase>",
      "sourceQuote": "<exact span from the document — omit entirely if you inferred this>"
    }
  ],
  "rules": [
    {
      "dataSlotKey": "<exact key from DATA SLOTS>",
      "operator": "equals" | "contains" | "gt" | "lt" | "exists",
      "value": "<operand, or null for exists>",
      "action": "include" | "exclude",
      "topicKey": "<key of one of your proposed topics>",
      "rationale": "<one sentence>",
      "sourceQuote": "<exact span — omit if inferred>"
    }
  ],
  "gaps": [
    {
      "sourceQuote": "<exact span that states an instruction you could not formalize>",
      "explanation": "<what you recognized, and specifically why you could not turn it into a topic or rule>"
    }
  ],
  "maxConditionalTopics": <number — omit unless the document states one>,
  "fallbackTopicKeys": ["<key of one of your topics>", ...],
  "checkTopicPreference": ["<key of one of your conditional topics>", ...],
  "summary": "<one or two sentences: what you found, and whether it came from the document>",
  "fromDocument": true | false
}`;

/** Render one question as a compact, model-readable block. */
function describeQuestion(question: RoutingAnalysisQuestion): string {
  const section = question.sectionTitle ? ` [${question.sectionTitle}]` : '';
  return `- ${question.key}${section}: ${question.prompt}`;
}

/** Render one data slot. */
function describeDataSlot(slot: RoutingAnalysisDataSlot): string {
  const theme = slot.theme ? ` [${slot.theme}]` : '';
  return `- ${slot.key}${theme}: ${slot.name}`;
}

/**
 * Render one document with a header that says what it IS.
 *
 * The role is stated rather than implied: an analyst told only "SOURCE DOCUMENT" twice has no way
 * to know that the second file is guidance about the first rather than a second instrument, and
 * will happily propose topics for questions that do not exist.
 */
function describeDocument(document: RoutingAnalysisDocument): string {
  const name = document.fileName ? ` (${document.fileName})` : '';

  if (document.role === 'primary') {
    return document.omitted
      ? `THE INSTRUMENT${name} — not shown here; work from the questions below.`
      : `THE INSTRUMENT${name} — the document its questions were taken from. Read the author's \
guidance in it first:\n${document.text}`;
  }

  if (document.omitted) {
    return `SUPPORTING DOCUMENT${name} — attached to this version but NOT shown to you, because \
the earlier documents used the whole budget. Say so in your summary: your reading of this \
instrument is incomplete.`;
  }

  const truncated = document.truncated
    ? ' It is CUT SHORT where marked — do not quote across that seam, and say in your summary that \
you did not see all of it.'
    : '';

  return `SUPPORTING DOCUMENT${name} — a companion an admin attached beside the instrument, \
usually because the routing rules arrived as their own file. It carries guidance, not questions.\
${truncated}\n${document.text}`;
}

/** Render an existing topic compactly — enough for the analyst to revise rather than duplicate. */
function describeExistingTopic(topic: Topic): string {
  const criteria = topic.criteria ? ` — include when: ${topic.criteria}` : '';
  return `- ${topic.key} (${topic.phase}, ${topic.source}): ${topic.label}${criteria}`;
}

/**
 * Build the analyst prompt: system rubric + a user turn carrying the instrument, the source
 * document, the key inventory and any existing topics.
 *
 * Sections collapse to nothing when their input is absent, so a version with no uploaded document
 * costs no tokens for the document block — and the analyst is told plainly that it is working
 * without one, rather than being left to notice the absence.
 */
export function buildRoutingAnalysisPrompt(input: RoutingAnalysisInput): LlmMessage[] {
  const parts: string[] = [];

  if (input.goal) parts.push(`QUESTIONNAIRE GOAL:\n${input.goal}`);
  if (input.audience !== undefined && input.audience !== null) {
    parts.push(`AUDIENCE:\n${JSON.stringify(input.audience)}`);
  }

  const documents = input.documents ?? [];
  if (documents.length > 0) {
    for (const document of documents) parts.push(describeDocument(document));
    if (documents.some((document) => document.role === 'supplementary')) {
      parts.push(
        'The documents above describe ONE instrument between them. Where a supporting document ' +
          'and the instrument disagree about who gets asked what, do not pick a side quietly: ' +
          'propose what the instrument supports and report the disagreement in "gaps", quoting ' +
          'both. A supporting document carries no questions of its own — never invent a question ' +
          'key from it; every key you use must come from the QUESTIONS list below.'
      );
    }
  } else {
    parts.push(
      'SOURCE DOCUMENT: none is attached to this version. You are working from the questions ' +
        'alone, so set "fromDocument" false and say so in your summary.'
    );
  }

  parts.push(
    `QUESTIONS (use these keys exactly):\n${input.questions.map(describeQuestion).join('\n')}`
  );

  if (input.dataSlots && input.dataSlots.length > 0) {
    parts.push(
      `DATA SLOTS (the only keys a rule may test):\n${input.dataSlots.map(describeDataSlot).join('\n')}`
    );
  } else {
    parts.push('DATA SLOTS: none. Propose no hard rules — there is nothing for one to test.');
  }

  if (input.existingTopics && input.existingTopics.length > 0) {
    parts.push(
      'TOPICS ALREADY ON THIS VERSION — revise these rather than duplicating them. Reuse a key ' +
        'when you mean the same topic, so the administrator sees a change rather than a second ' +
        `copy:\n${input.existingTopics.map(describeExistingTopic).join('\n')}`
    );
  }

  if (input.instructions && input.instructions.trim().length > 0) {
    parts.push(`ADMINISTRATOR'S NOTE FOR THIS RUN:\n${input.instructions.trim()}`);
  }

  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** A stricter retry `user` message when the first analyst response failed validation. */
export function buildRoutingAnalysisRetryMessage(): string {
  return (
    'Your previous response did not match the required JSON schema. Respond again with ONLY the ' +
    'JSON object: a "topics" array where every entry has a lowercase_snake_case "key", a "label", ' +
    'a "phase", a "rationale", and — for every entry whose phase is "conditional" — a non-empty ' +
    '"criteria". Topic keys must be unique. Also include "rules" (may be empty), "gaps" (may be ' +
    'empty, but every entry needs a non-empty "sourceQuote" and "explanation"), a "summary", and ' +
    'the boolean "fromDocument". No prose, no code fences.'
  );
}
