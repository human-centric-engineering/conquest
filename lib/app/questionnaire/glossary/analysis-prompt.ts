/**
 * Prompt builder for the Glossary Analyst (P16).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. The analyst reads a questionnaire and
 * proposes the terms that genuinely need pinning down, with the readings this questionnaire
 * appears to intend. Its rubric lives here rather than in the seeded agent's `systemInstructions`
 * — the same load-bearing-prompt convention the extractor and verifier use.
 *
 * The hard part of this prompt is RESTRAINT. A model asked "which words are ambiguous?" will
 * happily return forty, because almost any word is ambiguous in some context. What the admin
 * needs is the short list where the ambiguity would actually change an answer, so most of the
 * rubric is about what NOT to propose.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import { GLOSSARY_ANALYSIS_MAX_TERMS } from '@/lib/app/questionnaire/glossary/analysis-schema';
import { GLOSSARY_MAX_DEFINITIONS_PER_TERM } from '@/lib/app/questionnaire/glossary/types';

/** One question, projected for the analyst — only what a reader needs to judge its wording. */
export interface GlossaryAnalysisQuestion {
  key: string;
  prompt: string;
  guidelines?: string;
  sectionTitle?: string;
}

export interface GlossaryAnalysisInput {
  /** What the questionnaire is for — the strongest signal for which sense of a word is meant. */
  goal?: string | null;
  /** Who is answering — a term can be settled for clinicians and contested for the public. */
  audience?: unknown;
  questions: GlossaryAnalysisQuestion[];
  /** Short names of the version's data slots, when it has any (more of the same vocabulary). */
  dataSlotNames?: string[];
  /** The admin's authoritative definitions document, when one is attached. */
  documentText?: string;
  documentFileName?: string;
  /**
   * Terms the admin has ALREADY adjudicated (accepted or rejected), in display form. The analyst
   * is told not to propose these again — re-proposing a rejected term is the fastest way to make
   * a re-runnable feature feel broken.
   */
  existingTerms?: string[];
}

const SYSTEM_RULES = `You are the Glossary Analyst for a conversational questionnaire platform. You \
read a questionnaire and identify the terms whose meaning is NOT settled — words or phrases where \
two reasonable respondents would answer differently because they understood the word differently.

Your output is a proposal an administrator will review. Precision matters far more than recall: a \
short list of genuinely contested terms is useful, a long list of ordinary vocabulary is noise the \
administrator will discard along with your credibility.

PROPOSE a term when at least one of these is true:
- It is contested or tradition-dependent — it means materially different things in different \
schools of thought, professions, faiths, or cultures (e.g. "wellbeing", "engagement", \
"resilience", "trauma", "culture").
- It is an in-house or programme-specific coinage the questionnaire uses as if the respondent \
already shares its meaning.
- It is a scale or threshold word whose bar is undefined and does the load-bearing work of the \
question (e.g. "regularly", "significant", "senior", "engaged") — but ONLY when the question gives \
no scale of its own.
- It is a technical or clinical term being asked of a lay audience, or a lay term being used in a \
narrow technical sense.

Do NOT propose:
- Ordinary vocabulary with one settled everyday meaning ("work", "family", "week", "happy").
- Words the questionnaire ITSELF already defines, or which its answer options make unambiguous.
- Proper nouns, brand names, section headings, or the platform's own furniture.
- A term whose ambiguity would not change any answer. If you cannot say which question would be \
answered differently, leave it out.
- Any term listed under ALREADY ADJUDICATED — the administrator has already ruled on those.

For each proposed term, write its candidate DEFINITIONS:
- Infer them from how THIS questionnaire uses the term — its goal, its audience, the surrounding \
questions — not from a dictionary. Quote the questionnaire span you inferred from in "contextQuote".
- Give MORE THAN ONE definition only when the ambiguity is genuinely live here: when the \
questionnaire could plausibly intend either reading and the administrator must choose. Give exactly \
ONE when the intended sense is clear from context but simply unstated.
- Never exceed ${GLOSSARY_MAX_DEFINITIONS_PER_TERM} definitions for a term.
- Write each definition as prose a respondent could be shown verbatim: one or two plain sentences, \
second person or neutral, no meta-commentary, no "in this questionnaire" preamble.
- In "rationale", say in one sentence why this term is open to interpretation HERE, ideally naming \
what would differ between readings.

When a DEFINITIONS DOCUMENT is supplied, it is AUTHORITATIVE:
- Prefer a definition drawn from it over anything you infer, and put the exact supporting span in \
"sourceQuote".
- Only set "sourceQuote" when the document genuinely contains that wording. Never invent a quote, \
and never attach one to a definition you inferred yourself.
- If the document defines a term the questionnaire uses, propose that term even if you would \
otherwise have judged it settled — the administrator clearly considers it worth defining.

Also list "aliases": other surfaces meaning the same thing (alternative spellings, acronyms, \
irregular plurals). Do NOT list regular plurals or possessives — those are matched automatically.

Propose at most ${GLOSSARY_ANALYSIS_MAX_TERMS} terms. Returning an empty list is a valid and useful \
answer when the questionnaire's vocabulary is genuinely unambiguous.

Output ONLY a single JSON object — no prose, no code fences:
{
  "terms": [
    {
      "term": "<the term as it appears>",
      "aliases": ["<other surface>", ...],
      "rationale": "<one sentence: why this is open to interpretation here>",
      "contextQuote": "<a span from the questionnaire showing it in use>",
      "definitions": [ { "text": "<a definition>", "sourceQuote": "<span from the definitions document, only if drawn from it>" } ]
    }
  ]
}`;

/** Render one question as a compact, model-readable block. */
function describeQuestion(question: GlossaryAnalysisQuestion): string {
  const lines = [`- ${question.prompt}`];
  if (question.sectionTitle) lines.push(`  section: ${question.sectionTitle}`);
  if (question.guidelines) lines.push(`  guidance: ${question.guidelines}`);
  return lines.join('\n');
}

/**
 * Build the analyst prompt: system rubric + a user turn carrying the questionnaire, the optional
 * definitions document, and the already-adjudicated terms.
 *
 * Sections collapse to nothing when their input is absent, so a bare questionnaire costs no tokens
 * for the document or exclusion blocks.
 */
export function buildGlossaryAnalysisPrompt(input: GlossaryAnalysisInput): LlmMessage[] {
  const parts: string[] = [];

  if (input.goal) parts.push(`QUESTIONNAIRE GOAL:\n${input.goal}`);
  if (input.audience !== undefined && input.audience !== null) {
    parts.push(`AUDIENCE:\n${JSON.stringify(input.audience)}`);
  }

  parts.push(`QUESTIONS:\n${input.questions.map(describeQuestion).join('\n')}`);

  if (input.dataSlotNames && input.dataSlotNames.length > 0) {
    parts.push(`DATA POINTS THIS CONVERSATION CAPTURES:\n${input.dataSlotNames.join(', ')}`);
  }

  if (input.documentText) {
    const header = input.documentFileName
      ? `DEFINITIONS DOCUMENT (${input.documentFileName}) — AUTHORITATIVE:`
      : 'DEFINITIONS DOCUMENT — AUTHORITATIVE:';
    parts.push(`${header}\n${input.documentText}`);
  }

  if (input.existingTerms && input.existingTerms.length > 0) {
    parts.push(
      `ALREADY ADJUDICATED — do not propose any of these again:\n${input.existingTerms.join(', ')}`
    );
  }

  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** A stricter retry `user` message when the first analyst response failed validation. */
export function buildGlossaryAnalysisRetryMessage(): string {
  return (
    'Your previous response did not match the required JSON schema. Respond again with ONLY the ' +
    'JSON object: a "terms" array where every entry has a non-empty "term", a "rationale", and a ' +
    '"definitions" array of at least one entry, each with non-empty "text". No prose, no code fences.'
  );
}
