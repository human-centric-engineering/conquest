/**
 * Prompt builder for the extraction verifier (ingest verify + repair).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. The verifier reads the extracted
 * questions + the source document and FLAGS each one that is not a faithful extraction:
 * a wrong type or config, or a span that is not a question at all (interviewer script, a
 * transition, an instruction). It never rewrites. Its rubric lives here (not the seeded
 * agent's `systemInstructions`), the same load-bearing-prompt convention the extractor
 * uses.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import { VERIFY_ISSUES } from '@/lib/app/questionnaire/ingestion/verify-schema';

/** A question projected for the verifier — only the fields a type/config critic needs. */
export interface VerifyQuestionView {
  key: string;
  prompt: string;
  suggestedType: string;
  suggestedTypeConfig?: unknown;
  sourceQuote?: string;
  extractionConfidence?: number;
}

const SYSTEM_RULES = `You are a meticulous verifier for an automatically-extracted questionnaire. \
You are given the SOURCE document text and the extracted QUESTIONS (each with its chosen answer type \
and config). Your job is to FLAG — never fix — every question that is not a faithful extraction: \
one whose answer type or config does not match what the source shows, or one that is not a question \
at all.

Flag a question "suspect" (with an "issue") when:
- type_mismatch — the chosen type contradicts the source: a rating scale typed as single_choice/\
multi_choice/free_text, a yes/no typed free_text, a "select all that apply" typed single_choice, etc.
- missing_likert_anchors — a "likert" whose source clearly anchors its scale ("1 — Not at all … \
5 — Very much", or named points) but whose config has neither a full "labels" array nor both \
"minLabel"/"maxLabel".
- matrix_flattened — the source shows a RATING GRID (several row items each rated on ONE shared \
scale) that was collapsed into a single non-matrix question (e.g. one likert or one multi_choice) \
instead of one "matrix" question with rows.
- matrix_rows_lost — a grid WAS recognised but fewer row-questions/rows exist than the source lists.
- config_invalid — the config is structurally broken for its type (a choice with <2 options, a \
scale with no range, a matrix with no rows).
- not_a_question — the span is not a question at ALL, so no answer type could rescue it. This is \
the material a questionnaire document carries for whoever RUNS the interview rather than for the \
person answering it: interviewer or chatbot script ("Bot script: That's useful. Based on what \
you've said I want to go deeper on the areas below. I'll ask some short scored statements."), a \
transition ("We'll now move on to the next section"), an instruction about how to answer that \
requests nothing itself ("Quick answers are fine, first instinct is usually right"), or a note \
aimed at the operator ("Score 4 or above triggers a follow-up call", "For office use only"). The \
test: could a respondent ANSWER this span, and would their answer be data the questionnaire wants? \
Put the offending wording in "detail". A question flagged this way is REMOVED from the \
questionnaire rather than re-read, so flag it only when the span genuinely asks for nothing.
- other — an unfaithful extraction not covered above.

NEVER flag these — they are CORRECT extractions, not problems:
- An UNANCHORED rating typed "numeric". When the source gives a bare range and no qualitative \
wording for its points ("Rating 1-5", "score 0-10", "out of 100"), "numeric" is the RIGHT type and \
"likert" is the wrong one — a likert must carry meaning, via named points or both endpoint anchors, \
and the authoring schema REJECTS an unlabelled one. Flagging these as type_mismatch sends the \
repair step to build a likert that cannot validate, so the fix is discarded and the round-trip is \
wasted. Only call a rating mis-typed when the source DOES anchor it and the extractor still \
chose numeric.
- A "numeric" carrying no "labels". Numeric questions never have labels; that is not a missing \
config.
- A STATEMENT the respondent is meant to rate. "My manager gives me useful feedback" asks nothing \
and carries no question mark, yet paired with a scale it is exactly how a scored instrument is \
written. It is a real question, never "not_a_question".
- A terse or fragmentary prompt ("Job title", "Years in role", "Biggest challenge"). Terse is not \
the same as unanswerable: a respondent can answer every one of those.
- A question you simply think is weak, redundant, badly placed, or not worth asking. \
"not_a_question" is about whether a respondent can answer the span at all. It is never a verdict \
on whether the question earns its place. That judgement belongs to an author reviewing the draft, \
not to you, and using this issue for it deletes questions the document really did ask.

Otherwise the verdict is "ok". Be specific but conservative: only flag a real, source-evidenced \
problem — a faithful, well-typed question is "ok". Be most conservative of all with \
"not_a_question", because it is the only verdict that removes something: when you are unsure \
whether a span is script or a genuinely terse question, say "ok" and leave it for an author to \
delete. Cover EVERY question you are given, each exactly once, using its exact "key".

Whenever you detect a rating grid in the source (flattened OR correctly split), also emit a \
"matrixGroups" entry: the grid's heading as "label", the FULL grid block from the source (its rows \
AND the shared scale wording) as "sourceSpanQuote", and the keys of any already-extracted questions \
that belong to it as "memberKeys" (empty if it was flattened into one). This lets the repair step \
re-read the whole grid.

The valid "issue" values are: ${VERIFY_ISSUES.join(', ')}.

## Also check the COUNT, not just each question

Every verdict above can be "ok" while the question SET is still wrong — a compound question split \
into two, a heading promoted to a question, a page of the source missed. Per-question checking \
cannot see any of that, so assess it separately in "coverage".

Count what the SOURCE says it contains — its own numbering ("1." … "22."), an explicit statement \
("this review has 20 questions"), or a complete visible list — and compare that to the number of \
extracted questions you were given.

- "matches" — the counts agree.
- "extra_questions" — more were extracted than the source contains. The usual cause is a compound \
question ("Who is the lead, AND when did they last train?") turned into two, which the extractor \
is instructed NOT to do. Name the extracted keys that look invented in "detail".
- "missing_questions" — the source contains questions that are not in the extracted set. Name what \
is missing in "detail".
- "uncountable" — the source does not state how many questions it has. Set \
"sourceQuestionCount": null. **This is a perfectly good answer and often the right one** — many \
documents simply do not number their questions. Never guess a count to avoid saying this; a \
fabricated number is worse than an honest "uncountable".

Judge the count from the source alone. Do not reason backwards from the number of questions you \
were given to a count that would make it match.

Output ONLY a single JSON object — no prose, no code fences:
{
  "verdicts": [ { "key": "<question key>", "verdict": "ok" | "suspect", "issue": "<one of the issues, only when suspect>", "detail": "<short reason, optional>" } ],
  "matrixGroups": [ { "label": "<grid heading>", "sourceSpanQuote": "<the full grid block from the source>", "memberKeys": ["<key>", ...] } ],
  "coverage": { "sourceQuestionCount": <integer or null>, "assessment": "matches" | "extra_questions" | "missing_questions" | "uncountable", "detail": "<short line, optional>" }
}`;

/** Render one extracted question as a compact, model-readable block. */
function describeQuestion(q: VerifyQuestionView): string {
  const lines = [
    `- key: ${q.key}`,
    `  type: ${q.suggestedType}`,
    `  prompt: ${q.prompt}`,
    `  config: ${q.suggestedTypeConfig === undefined ? '(none)' : JSON.stringify(q.suggestedTypeConfig)}`,
  ];
  if (typeof q.extractionConfidence === 'number') {
    lines.push(`  extractionConfidence: ${q.extractionConfidence.toFixed(2)}`);
  }
  if (q.sourceQuote) lines.push(`  sourceQuote: ${q.sourceQuote}`);
  return lines.join('\n');
}

export interface VerifyPromptInput {
  questions: VerifyQuestionView[];
  documentText: string;
  fileName?: string;
}

/** Build the verifier prompt: system rubric + a user turn with the source and the extracted questions. */
export function buildVerifyPrompt(input: VerifyPromptInput): LlmMessage[] {
  const header = input.fileName ? `Source document: ${input.fileName}\n\n` : '';
  const questionsBlock = input.questions.map(describeQuestion).join('\n');
  const user =
    `${header}SOURCE DOCUMENT TEXT:\n${input.documentText}\n\n` +
    `EXTRACTED QUESTIONS TO VERIFY:\n${questionsBlock}`;
  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: user },
  ];
}

/** A stricter retry `user` message (content) when the first verifier response failed validation. */
export function buildVerifyRetryMessage(): string {
  return (
    'Your previous response did not match the required JSON schema. Respond again with ONLY the ' +
    'JSON object: a "verdicts" array (one entry per question, each with a valid "key" and a ' +
    '"verdict" of "ok" or "suspect") and a "matrixGroups" array. No prose, no code fences.'
  );
}
