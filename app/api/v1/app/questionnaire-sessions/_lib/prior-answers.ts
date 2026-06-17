/**
 * "What the respondent has already shared this session" — a short digest the live turn
 * loop hands the conversational interviewer so it can keep continuity (and avoid re-asking
 * what it already knows) when phrasing the next question.
 *
 * Pure: derived entirely from the loaded turn context. Prefers data-slot fills (each carries
 * a natural-language `paraphrase`, the cleanest signal); falls back to captured question
 * answers when the version doesn't run on data slots. The slot/question currently being
 * asked is excluded so the interviewer never "reminds" them of the very thing it's asking.
 */

import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator/data-slot-orchestrator';
import type {
  DataSlotAnsweredView,
  DataSlotTarget,
  ExistingAnswerView,
} from '@/lib/app/questionnaire/orchestrator';

/** Keep the digest lean — at most this many lines reach the interviewer prompt. */
const DEFAULT_LIMIT = 8;
/** Cap each summary so one verbose answer can't bloat the prompt. */
const MAX_SUMMARY_CHARS = 140;
/** Cap a question label (its prompt) so the digest stays scannable. */
const MAX_LABEL_CHARS = 80;

/** Best-effort one-line rendering of an opaque captured value. Empty string → skip the entry. */
function summariseValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim().slice(0, MAX_SUMMARY_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => summariseValue(v))
      .filter(Boolean)
      .join(', ')
      .slice(0, MAX_SUMMARY_CHARS);
  }
  try {
    return JSON.stringify(value).slice(0, MAX_SUMMARY_CHARS);
  } catch {
    return '';
  }
}

function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface PriorAnswersInput {
  /** The version's data slots (only `id` + `name` are read). */
  dataSlots: Pick<DataSlotTarget, 'id' | 'name'>[];
  /** This session's data-slot fills. */
  dataSlotAnswered: DataSlotAnsweredView[];
  /** This session's captured question answers (the question-mode fallback). */
  existingAnswers: ExistingAnswerView[];
  /** `question key → prompt`, so a question answer reads with a human label. */
  questionPromptByKey: Map<string, string>;
  /** The data slot being asked this turn (excluded from the digest). */
  excludeDataSlotId?: string | null;
  /** The question being asked this turn (excluded from the digest). */
  excludeQuestionKey?: string | null;
  /** Max lines (default {@link DEFAULT_LIMIT}). */
  limit?: number;
}

/**
 * Build the prior-answers digest as a list of `"<label>: <summary>"` lines. Returns `[]`
 * when nothing has been confidently captured yet (the prompt then omits the block entirely).
 */
export function buildPriorAnswersDigest(input: PriorAnswersInput): string[] {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const nameById = new Map(input.dataSlots.map((s) => [s.id, s.name]));

  // Prefer data-slot fills: each has a natural paraphrase. A fill counts as "shared" on the
  // same rule targeting uses (confident OR plainly stated), but never a parked best-effort
  // inference (`provisional`) — the interviewer shouldn't echo back something they didn't say.
  const fromSlots: string[] = [];
  for (const fill of input.dataSlotAnswered) {
    if (fill.dataSlotId === input.excludeDataSlotId) continue;
    if (fill.provisional) continue;
    const covered =
      (fill.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD || fill.provenance === 'direct';
    if (!covered) continue;
    const name = nameById.get(fill.dataSlotId);
    if (!name) continue;
    const summary = (fill.paraphrase ?? '').trim() || summariseValue(fill.value);
    if (!summary) continue;
    fromSlots.push(`${name}: ${shorten(summary, MAX_SUMMARY_CHARS)}`);
    if (fromSlots.length >= limit) break;
  }
  if (fromSlots.length > 0) return fromSlots;

  // Question mode: fall back to captured question answers (raw values, best-effort summarised).
  const fromQuestions: string[] = [];
  for (const ans of input.existingAnswers) {
    if (ans.slotKey === input.excludeQuestionKey) continue;
    const summary = summariseValue(ans.value);
    if (!summary) continue;
    const label = shorten(
      input.questionPromptByKey.get(ans.slotKey) ?? ans.slotKey,
      MAX_LABEL_CHARS
    );
    fromQuestions.push(`${label}: ${summary}`);
    if (fromQuestions.length >= limit) break;
  }
  return fromQuestions;
}
