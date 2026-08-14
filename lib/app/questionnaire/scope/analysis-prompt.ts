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
 * else. But real instruments — the ones consultancies actually hand over — carry pages the
 * extractor throws away: "Routing", "Guardrails", "How to use this assessment", "Scoring notes".
 * Those pages are the author telling you, in their own words, which parts of the instrument apply
 * to whom. This analyst exists to read exactly the pages the extractor ignored.
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

import {
  ROUTING_ANALYSIS_MAX_RULES,
  ROUTING_ANALYSIS_MAX_TOPICS,
} from '@/lib/app/questionnaire/scope/analysis-schema';
import {
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

export interface RoutingAnalysisInput {
  goal?: string | null;
  audience?: unknown;
  questions: RoutingAnalysisQuestion[];
  dataSlots?: RoutingAnalysisDataSlot[];
  /** The uploaded instrument's own text — where the routing instructions live, when they exist. */
  documentText?: string;
  documentFileName?: string;
  /** The version's current topics, so a re-run proposes a revision rather than a duplicate set. */
  existingTopics?: readonly Topic[];
  /** Admin's free-text steer for this run ("the routing rules are on the Guardrails tab"). */
  instructions?: string;
}

const SYSTEM_RULES = `You are the Routing Analyst for a conversational questionnaire platform. You \
read an assessment instrument and work out WHICH PARTS OF IT APPLY TO WHOM.

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
is how a fine-grained dependency is expressed — "only ask about channel conflict if they sell \
through partners" is a topic, not a special case. Do not force everything to section size.

## Read the instruction pages, not just the questions

Real instruments carry pages that are not questions: "Routing", "Guardrails", "Scoring notes", \
"How to use this", facilitator instructions, eligibility notes. THOSE PAGES ARE YOUR PRIMARY \
SOURCE. They are where the author states which sections apply to whom, how many areas to cover, \
and what never to ask certain respondents. Read them first and let them drive your proposal.

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

## Criteria

Write the CONDITION, not the instruction. "They sell through partners or resellers" is judgeable; \
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
  "maxConditionalTopics": <number — omit unless the document states one>,
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

  if (input.documentText) {
    const header = input.documentFileName
      ? `SOURCE DOCUMENT (${input.documentFileName}) — read its instruction pages first:`
      : 'SOURCE DOCUMENT — read its instruction pages first:';
    parts.push(`${header}\n${input.documentText}`);
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
    '"criteria". Topic keys must be unique. Also include "rules" (may be empty), a "summary", and ' +
    'the boolean "fromDocument". No prose, no code fences.'
  );
}
