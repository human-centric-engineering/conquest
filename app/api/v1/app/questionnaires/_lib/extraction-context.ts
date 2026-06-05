/**
 * Route-local answer-extraction context builder (F4.2).
 *
 * Maps a questionnaire version's persisted slots into the in-memory
 * {@link ExtractionContext} the extractor capability reads. This is the DB seam —
 * `lib/app/questionnaire/extraction/**` stays Prisma-free, so all the I/O lives
 * here.
 *
 * Session/turn/answer tables don't exist yet (F4.6/P6), so the "what's been
 * answered so far" half is caller-supplied (a preview request body today, the
 * engine later). The candidate pool is the version's UNANSWERED slots plus the
 * active slot (re-answering an answered slot is F4.4's `refined` job). Answered
 * entries address slots by stable `key`; unknown keys are dropped (a stale
 * preview key shouldn't 500). The `activeQuestionKey`, by contrast, is
 * load-bearing — an unknown one is a 400, distinct from a missing version (404).
 */

import { prisma } from '@/lib/db/client';
import { QUESTION_TYPES, type QuestionType } from '@/lib/app/questionnaire/types';
import type {
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

/** Caller-supplied session state — the half of the context the DB can't give yet. */
export interface ExtractionContextInput {
  /** Key of the question being asked. Must resolve to a slot in the version. */
  activeQuestionKey: string;
  /** The respondent's message to extract from. */
  userMessage: string;
  /** Already-answered slots, addressed by `key`. Unknown keys are ignored. */
  answered: Array<{ key: string; confidence?: number | null }>;
  /** Recent transcript, oldest → newest. */
  recentMessages?: string[];
  /** Stable session id; defaults to a per-version preview id. */
  sessionId?: string;
}

/**
 * Outcome of building an extraction context. `version_not_found` maps to a 404
 * (the id/versionId pair didn't resolve); `unknown_active_question` maps to a 400
 * (the version exists but the supplied active key isn't one of its slots).
 */
export type ExtractionContextResult =
  | { ok: true; context: ExtractionContext }
  | { ok: false; reason: 'version_not_found' | 'unknown_active_question' };

/** Narrow a stored slot `type` string to the enum, defaulting defensively. */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/**
 * Build the {@link ExtractionContext} for one version, scoped to its parent
 * questionnaire. Returns a discriminated result so the route can map the two
 * failure modes to 404 vs 400.
 */
export async function buildExtractionContext(
  questionnaireId: string,
  versionId: string,
  input: ExtractionContextInput
): Promise<ExtractionContextResult> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      id: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              key: true,
              type: true,
              typeConfig: true,
              prompt: true,
              guidelines: true,
              required: true,
            },
          },
        },
      },
    },
  });
  if (!version) return { ok: false, reason: 'version_not_found' };

  // Project every slot, indexed by key.
  const slotsByKey = new Map<string, ExtractionSlotView>();
  for (const section of version.sections) {
    for (const slot of section.questions) {
      slotsByKey.set(slot.key, {
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        type: asQuestionType(slot.type),
        typeConfig: slot.typeConfig ?? null,
        prompt: slot.prompt,
        required: slot.required,
        ...(slot.guidelines != null ? { guidelines: slot.guidelines } : {}),
      });
    }
  }

  const activeSlot = slotsByKey.get(input.activeQuestionKey);
  if (!activeSlot) return { ok: false, reason: 'unknown_active_question' };

  // Candidate pool: unanswered slots + the active slot (which the message replies
  // to even if it already has an answer). Dedupe so the active slot appears once.
  const answeredKeys = new Set(input.answered.map((a) => a.key));
  const candidateSlots: ExtractionSlotView[] = [];
  for (const slot of slotsByKey.values()) {
    if (slot.key === activeSlot.key || !answeredKeys.has(slot.key)) {
      candidateSlots.push(slot);
    }
  }

  // Keep only answered entries that resolve to a real slot (drop stale keys).
  const answered = input.answered
    .filter((a) => slotsByKey.has(a.key))
    .map((a) => ({ slotKey: a.key, confidence: a.confidence ?? null }));

  const context: ExtractionContext = {
    activeQuestionKey: activeSlot.key,
    candidateSlots,
    answered,
    userMessage: input.userMessage,
    sessionId: input.sessionId ?? `preview-${versionId}`,
    ...(input.recentMessages ? { recentMessages: input.recentMessages } : {}),
  };

  return { ok: true, context };
}
