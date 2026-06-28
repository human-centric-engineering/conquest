/**
 * Prompt builder for the Structure Edit Agent's translation call.
 *
 * Pure (no IO): turns the current structure into a bounded text summary and frames the system
 * instruction that constrains the model to emit a valid edit-op plan. The op vocabulary is described
 * here so the model maps the admin's instruction onto the exact ops `edit-ops.ts` validates; the Zod
 * schema + `validateEditPlan` remain the safety net regardless of the prose.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';

const PROMPT_CAP = 140;

function truncate(text: string): string {
  return text.length > PROMPT_CAP ? `${text.slice(0, PROMPT_CAP - 1)}…` : text;
}

/** A compact, ordinal-anchored view of the structure the model edits. */
export function summarizeStructure(structure: EditableStructure): string {
  return structure.sections
    .map((s) => {
      const head = `Section [ordinal ${s.ordinal}]: ${s.title}`;
      const qs = s.questions
        .map(
          (q) =>
            `  - key="${q.key}" type=${q.type} required=${q.required} weight=${q.weight.toFixed(
              2
            )} prompt="${truncate(q.prompt)}"`
        )
        .join('\n');
      return qs ? `${head}\n${qs}` : `${head}\n  (no questions)`;
    })
    .join('\n');
}

const OP_REFERENCE = `Available operations (emit a JSON array under "operations"; each item is one object):
- {"op":"set_required","target":<qsel>,"value":<bool>} — set the required flag on matched questions.
- {"op":"set_weight","target":<qsel>,"value":<0.1..1.0>} — set weight on matched questions.
- {"op":"transform_prompt","target":<qsel>,"transform":"uppercase|lowercase|titlecase|trim"} — case/whitespace transform on matched prompts.
- {"op":"rename_prompt","key":"<question key>","value":"<new prompt>"} — replace one question's prompt verbatim.
- {"op":"transform_title","target":<ssel>,"transform":"uppercase|lowercase|titlecase|trim"} — transform matched section titles.
- {"op":"set_section_title","sectionOrdinal":<n>,"value":"<new title>"} — replace one section's title verbatim.
- {"op":"renumber_sections","style":"prefix-number|strip-number"} — add/replace ("1. ", "2. ") or remove a numeric prefix on every section title.
- {"op":"reorder_sections","order":[<ordinals in new order>]} — must be a permutation of the existing section ordinals.
- {"op":"move_question","key":"<key>","toSectionOrdinal":<n>,"toIndex":<optional n>} — move a question to another section.

Question selector <qsel> is one of:
  {"scope":"all"} | {"scope":"section","sectionOrdinal":<n>} | {"scope":"type","questionType":"free_text|single_choice|multi_choice|likert|numeric|date|boolean"} | {"scope":"keys","keys":["..."]}
Section selector <ssel> is one of:
  {"scope":"all"} | {"scope":"ordinals","ordinals":[<n>,...]}`;

const SYSTEM = `You translate a single plain-English instruction about a WHOLE questionnaire into a precise list of structural edit operations.

Rules:
- Use ONLY the operations and selectors listed below. Do not invent fields.
- Reference sections by their given "ordinal" (0-based) and questions by their "key".
- Touch ONLY what the instruction names. Never rewrite a prompt's wording unless the instruction explicitly says to (use rename_prompt for an explicit verbatim replacement; transform_prompt only for case/whitespace).
- Prefer the smallest set of operations that fully satisfies the instruction. For "all free-text fields" use {"scope":"type","questionType":"free_text"}; for "every section" use {"scope":"all"}.
- If the instruction cannot be expressed with these operations, return an empty operations array and say so in the summary.
- Always include a one-line "summary" describing the net effect.

${OP_REFERENCE}`;

/** Build the two-message prompt (system rules + the instruction over the structure summary). */
export function buildTranslatePrompt(
  instruction: string,
  structure: EditableStructure
): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Current structure:\n${summarizeStructure(
        structure
      )}\n\nInstruction:\n${instruction}\n\nReturn ONLY a JSON object {"summary": string, "operations": [...]}.`,
    },
  ];
}

/** Retry nudge if the first attempt did not validate against the plan schema. */
export function buildTranslateRetryMessage(): string {
  return 'Your previous reply was not a valid plan. Reply with ONLY a JSON object {"summary": string, "operations": EditOp[]} using exactly the operations and selectors described. Do not include any prose outside the JSON.';
}
