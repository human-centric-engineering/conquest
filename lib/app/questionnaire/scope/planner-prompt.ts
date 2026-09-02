/**
 * What the two planner prompts SHOW the model (P17, F17.36) — pure rendering, no I/O.
 *
 * Extracted from `planner.ts` when early topic seating gained a second pass over the same evidence.
 * One rendering, deliberately: the full planner and the early pass ask different questions, but
 * they read the same conversation, and a respondent's words formatted one way for one decision and
 * another way for the other would make the two impossible to compare when they disagreed.
 *
 * Every bound here exists because this is the part of the prompt that grows with the instrument.
 */

import {
  MAX_ANSWERS_IN_PLANNER_PROMPT,
  MAX_FILLS_IN_PLANNER_PROMPT,
  MAX_PLANNER_ITEM_CHARS,
  MAX_PLANNER_ITEMS_PER_TOPIC,
  MAX_PLANNER_RENDERED_ITEMS,
  PLANNER_ANSWER_CHARS,
  PLANNER_FILL_CHARS,
} from '@/lib/app/questionnaire/scope/constants';
import type { ScopeFill, Topic } from '@/lib/app/questionnaire/scope/types';

export interface ScopeAnswer {
  /** The question's key. */
  key: string;
  /** What the question asked. */
  prompt: string;
  /** The stored answer — a mapped form value (a choice slug, a scale point) for typed questions. */
  value: unknown;
  /** The living natural-language account of what they conveyed, when the answer has one. */
  paraphrase: string | null;
}

/** A readable rendering of a stored answer value, or null when there is nothing worth printing. */
export function answerText(answer: ScopeAnswer): string | null {
  // Paraphrase first, always. It is the natural-language account of what they conveyed; `value`
  // holds the MAPPED form value for a typed question — a choice slug like `gt3` — and feeding form
  // codes to a model that is reading for meaning is noise at best.
  if (answer.paraphrase && answer.paraphrase.trim() !== '') return answer.paraphrase.trim();
  if (typeof answer.value === 'string' && answer.value.trim() !== '') return answer.value.trim();
  if (typeof answer.value === 'number' || typeof answer.value === 'boolean') {
    return String(answer.value);
  }
  if (Array.isArray(answer.value) && answer.value.length > 0) {
    return answer.value.map((v) => String(v)).join(', ');
  }
  return null;
}

export function renderAnswers(answers: readonly ScopeAnswer[]): string[] {
  const lines: string[] = [];
  for (const answer of answers) {
    if (lines.length >= MAX_ANSWERS_IN_PLANNER_PROMPT) break;
    const text = answerText(answer);
    if (!text) continue;
    lines.push(`- Asked: ${answer.prompt}\n  Answered: ${text.slice(0, PLANNER_ANSWER_CHARS)}`);
  }
  return lines;
}

/**
 * The evidence block: what they said, then what was captured from it.
 *
 * Their own words come first because that is what they are — the primary record. A fill is an
 * extraction from those words, so it can be thin, stale, or simply absent, and a planner that reads
 * only fills is reading a summary of a conversation it was never shown.
 */
export function renderConveyed(
  fills: readonly ScopeFill[],
  answers: readonly ScopeAnswer[],
  briefing: string | null | undefined
): string {
  const answerLines = renderAnswers(answers);
  const fillLines = fills.slice(0, MAX_FILLS_IN_PLANNER_PROMPT).map((f) => {
    const text =
      typeof f.value === 'string' && f.value.trim() !== ''
        ? f.value
        : (f.paraphrase ?? '(no answer captured)');
    return `- [${f.key}] ${text.slice(0, PLANNER_FILL_CHARS)}`;
  });

  const parts: string[] = [];
  if (answerLines.length > 0) parts.push(`In their own words:\n${answerLines.join('\n')}`);
  if (fillLines.length > 0) parts.push(`Captured from what they said:\n${fillLines.join('\n')}`);
  if (parts.length === 0) parts.push('(nothing was captured in the opening)');
  if (briefing) parts.push(`Summary of the conversation so far:\n${briefing}`);
  return parts.join('\n\n');
}

/**
 * Render the candidates, with each topic's questions when the caller supplied their wording.
 *
 * Bounded three ways, because this is the part of the prompt that grows with the instrument: a
 * per-question character cap, a per-topic item cap, and a whole-prompt item budget spent in
 * candidate order (best first, which is the order the planner reads them in anyway). A topic whose
 * items were not rendered simply cannot be partially selected — which is why the line saying so is
 * printed rather than the items being dropped in silence.
 */
export function renderCandidates(
  candidates: readonly Topic[],
  itemPrompts: ReadonlyMap<string, string> | undefined
): string {
  let budget = MAX_PLANNER_RENDERED_ITEMS;

  return candidates
    .map((t) => {
      const lines = [`- key: ${t.key}`, `  name: ${t.label}`];
      if (t.criteria) lines.push(`  choose when: ${t.criteria}`);

      if (itemPrompts && t.members.questionKeys.length > 0) {
        const known = t.members.questionKeys.filter((key) => itemPrompts.has(key));
        const room = Math.min(known.length, MAX_PLANNER_ITEMS_PER_TOPIC, Math.max(0, budget));
        if (room < known.length) {
          lines.push('  questions: not listed — choose this topic whole or not at all');
        } else if (room > 0) {
          budget -= room;
          lines.push('  questions:');
          for (const key of known.slice(0, room)) {
            const prompt = (itemPrompts.get(key) ?? '').replace(/\s+/g, ' ').trim();
            const text =
              prompt.length > MAX_PLANNER_ITEM_CHARS
                ? `${prompt.slice(0, MAX_PLANNER_ITEM_CHARS)}…`
                : prompt;
            lines.push(`    - ${key}: ${text}`);
          }
        }
      }

      return lines.join('\n');
    })
    .join('\n\n');
}
