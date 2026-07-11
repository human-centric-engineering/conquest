/**
 * Prompt builder for the scales/matrix repair specialist (ingest verify + repair).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. Given ONLY the flagged questions
 * (plus any rating-grid spans the verifier found and the full source), it re-extracts
 * those questions correctly — fixing a mis-typed scale, restoring missing likert anchors,
 * or turning a flattened / mis-split grid into one `matrix` question. It works on a small,
 * focused input, which is why it succeeds where the whole-document pass was fragile.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { MatrixGroupHint } from '@/lib/app/questionnaire/ingestion/verify-schema';

const SYSTEM_RULES = `You are a specialist at extracting RATING SCALES and RATING GRIDS from \
questionnaire source text. You are given a few FLAGGED questions that an earlier pass got wrong, plus \
the source document. Re-extract ONLY those questions, correctly, and return the fixes.

Answer-type rules (the same ones the main extractor follows):
- likert — a scale that carries qualitative meaning. ALWAYS include integer "min" and "max", plus \
EITHER a full "labels" array (one label per point, ordered min→max, length exactly max−min+1) OR both \
endpoint anchors "minLabel"/"maxLabel" copied VERBATIM from the source. Prefer endpoint anchors when \
the source only anchors the ends ("1 — Not at all … 5 — Very much"); never invent middle labels.
- matrix — a RATING GRID: several row items each rated on ONE shared scale. Use a SINGLE "matrix" \
question. Set "suggestedTypeConfig.rows" to an array of {"key":"<snake_case slug>","label":"<row \
text>"} (≥1 row, distinct keys) and "suggestedTypeConfig.scale" to the shared scale as a likert \
config ({"min","max"} + labels OR minLabel/maxLabel). Keep the grid's overall wording as the prompt. \
Do NOT split a grid into one question per row.
- single_choice / multi_choice — a fixed option list → "choices":[{"value","label"}] (≥2, distinct).
- Use "numeric" for a purely numeric rating with no qualitative anchors.

For each flagged question, emit ONE repair:
- action "correct" — replace that ONE question in place. Keep the SAME "key" and "sectionOrdinal". \
You MAY change its "suggestedType" (e.g. multi_choice → matrix, or free_text → likert). Put the \
single corrected question in "questions".
- action "merge" — when several flagged questions are really ROWS of one grid that was mis-split into \
separate likerts, collapse them into ONE "matrix" question. List all their keys in "originalKeys", \
give the merged matrix a fresh stable "key" and the shared "sectionOrdinal", and put that ONE matrix \
question in "questions".

When a "matrixGroups" hint is provided, use its "sourceSpanQuote" (the whole grid block) as the truth \
for the grid's rows and scale. Re-read the SOURCE for anything the flag detail mentions. Every \
corrected question MUST be complete and valid for its type. If you genuinely cannot improve a \
question, omit it (leave it as-is) rather than emitting a worse version.

Output ONLY a single JSON object — no prose, no code fences:
{
  "repairs": [
    { "originalKeys": ["<flagged key>", ...], "action": "correct" | "merge",
      "questions": [ { "sectionOrdinal": <int>, "key": "<slug>", "prompt": "<text>", "suggestedType": "<type>", "suggestedTypeConfig": { ... }, "extractionConfidence": <0..1> } ],
      "rationale": "<short, optional>" }
  ]
}`;

/** Render a flagged question (the full extracted object) for the repair prompt. */
function describeTarget(q: ExtractedQuestion): string {
  return [
    `- key: ${q.key}`,
    `  sectionOrdinal: ${q.sectionOrdinal}`,
    `  type: ${q.suggestedType}`,
    `  prompt: ${q.prompt}`,
    `  config: ${q.suggestedTypeConfig === undefined ? '(none)' : JSON.stringify(q.suggestedTypeConfig)}`,
    ...(q.sourceQuote ? [`  sourceQuote: ${q.sourceQuote}`] : []),
  ].join('\n');
}

/** Render a verifier-detected grid span. */
function describeGroup(g: MatrixGroupHint): string {
  return [
    `- grid: ${g.label}`,
    `  members: ${g.memberKeys.length > 0 ? g.memberKeys.join(', ') : '(flattened into one)'}`,
    `  sourceSpan: ${g.sourceSpanQuote}`,
  ].join('\n');
}

export interface RepairPromptInput {
  targets: ExtractedQuestion[];
  matrixGroups: MatrixGroupHint[];
  /** Per-key flag reasons from the verifier, so the specialist knows what to fix. */
  issueByKey?: Record<string, string>;
  documentText: string;
  fileName?: string;
}

/** Build the repair prompt: system rules + a user turn with the flagged questions, grid hints, and source. */
export function buildRepairPrompt(input: RepairPromptInput): LlmMessage[] {
  const header = input.fileName ? `Source document: ${input.fileName}\n\n` : '';
  const flags = input.issueByKey
    ? Object.entries(input.issueByKey)
        .map(([key, issue]) => `- ${key}: ${issue}`)
        .join('\n')
    : '';
  const targetsBlock = input.targets.map(describeTarget).join('\n');
  const groupsBlock =
    input.matrixGroups.length > 0
      ? `\n\nDETECTED RATING GRIDS:\n${input.matrixGroups.map(describeGroup).join('\n')}`
      : '';
  const flagsBlock = flags ? `\n\nWHY EACH WAS FLAGGED:\n${flags}` : '';
  const user =
    `${header}SOURCE DOCUMENT TEXT:\n${input.documentText}\n\n` +
    `FLAGGED QUESTIONS TO REPAIR:\n${targetsBlock}` +
    groupsBlock +
    flagsBlock;
  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: user },
  ];
}

/** A stricter retry `user` message (content) when the first repair response failed validation. */
export function buildRepairRetryMessage(): string {
  return (
    'Your previous response did not match the required JSON schema. Respond again with ONLY the ' +
    'JSON object: a "repairs" array, each entry with "originalKeys", an "action" of "correct" or ' +
    '"merge", and a "questions" array of complete, valid questions. No prose, no code fences.'
  );
}
