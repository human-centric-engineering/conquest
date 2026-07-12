/**
 * Prompt builder for the extraction verifier (ingest verify + repair).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. The verifier reads the extracted
 * questions + the source document and FLAGS each question whose type/config isn't
 * faithful to the source — it never rewrites. Its rubric lives here (not the seeded
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
and config). Your job is to FLAG — never fix — every question whose answer type or config does not \
FAITHFULLY match what the source shows.

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
- other — an unfaithful extraction not covered above.

Otherwise the verdict is "ok". Be specific but conservative: only flag a real, source-evidenced \
problem — a faithful, well-typed question is "ok". Cover EVERY question you are given, each exactly \
once, using its exact "key".

Whenever you detect a rating grid in the source (flattened OR correctly split), also emit a \
"matrixGroups" entry: the grid's heading as "label", the FULL grid block from the source (its rows \
AND the shared scale wording) as "sourceSpanQuote", and the keys of any already-extracted questions \
that belong to it as "memberKeys" (empty if it was flattened into one). This lets the repair step \
re-read the whole grid.

The valid "issue" values are: ${VERIFY_ISSUES.join(', ')}.

Output ONLY a single JSON object — no prose, no code fences:
{
  "verdicts": [ { "key": "<question key>", "verdict": "ok" | "suspect", "issue": "<one of the issues, only when suspect>", "detail": "<short reason, optional>" } ],
  "matrixGroups": [ { "label": "<grid heading>", "sourceSpanQuote": "<the full grid block from the source>", "memberKeys": ["<key>", ...] } ]
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
