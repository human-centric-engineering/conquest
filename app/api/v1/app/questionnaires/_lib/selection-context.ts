/**
 * Route-local selection-context builder (F4.1 / PR2).
 *
 * Maps a questionnaire version's persisted structure (sections → slots → tags)
 * plus its config into the in-memory {@link SelectionContext} the pure selection
 * strategies read. This is the DB seam — `lib/app/questionnaire/selection/**`
 * stays Prisma-free, so all the I/O lives here.
 *
 * Session/turn/answer tables don't exist yet (F4.6/P6), so the "what's been
 * answered so far" half of the context isn't loaded from the DB — the caller
 * supplies it (a preview request body today, the streaming engine later). The
 * `answered` entries address questions by their stable `key`; unknown keys are
 * dropped (a preview caller passing a stale key shouldn't 500).
 */

import { prisma } from '@/lib/db/client';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  QUESTION_TYPES,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { toConfigView, CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import type {
  AnsweredView,
  QuestionView,
  SelectionContext,
} from '@/lib/app/questionnaire/selection';

/** Caller-supplied session state — the half of the context the DB can't give yet. */
export interface SelectionContextInput {
  /** Already-answered questions, addressed by slot `key`. Unknown keys are ignored. */
  answered: Array<{ key: string; confidence?: number | null }>;
  /** Recent user messages, oldest → newest. Only `adaptive` reads these. */
  recentMessages?: string[];
  /** Selection round; defaults to the answered count when omitted. */
  round?: number;
  /** Stable session id (seeds `random`); defaults to a per-version preview id. */
  sessionId?: string;
}

/** Narrow a stored slot `type` string to the enum, defaulting defensively. */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/**
 * Build the {@link SelectionContext} for one version, scoped to its parent
 * questionnaire (a mismatched id/versionId pair returns `null` → 404 at the
 * route). Also returns an `id → QuestionView` map so the route can enrich its
 * response (resolve the chosen id back to a key/prompt) without re-querying.
 */
export async function buildSelectionContext(
  questionnaireId: string,
  versionId: string,
  input: SelectionContextInput
): Promise<{ context: SelectionContext; byId: Map<string, QuestionView> } | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      id: true,
      // Version goal: framing for the adaptive selector (read only by `adaptive`).
      goal: true,
      config: { select: CONFIG_SELECT },
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          ordinal: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              key: true,
              ordinal: true,
              weight: true,
              required: true,
              type: true,
              prompt: true,
              // Adaptive-selector framing (`adaptive` only): what a good answer looks like + why.
              guidelines: true,
              rationale: true,
              tags: { select: { tagId: true } },
            },
          },
        },
      },
    },
  });
  if (!version) return null;

  const questions: QuestionView[] = [];
  for (const section of version.sections) {
    for (const slot of section.questions) {
      questions.push({
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        sectionOrdinal: section.ordinal,
        ordinal: slot.ordinal,
        weight: slot.weight,
        required: slot.required,
        type: asQuestionType(slot.type),
        tagIds: slot.tags.map((t) => t.tagId),
        prompt: slot.prompt,
        guidelines: slot.guidelines,
        rationale: slot.rationale,
      });
    }
  }

  const byKey = new Map(questions.map((q) => [q.key, q]));

  // Map answered keys → question ids; silently drop keys that don't resolve.
  const answered: AnsweredView[] = [];
  for (const a of input.answered) {
    const q = byKey.get(a.key);
    if (!q) continue;
    answered.push({ questionId: q.id, confidence: a.confidence ?? null });
  }

  // Strip the read-view's `saved` flag to get the pure config shape.
  const { saved: _saved, ...config } = toConfigView(version.config);
  void _saved;

  const context: SelectionContext = {
    questions,
    answered,
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...config },
    ...(version.goal !== null ? { goal: version.goal } : {}),
    // `round` seeds `random`. The answered-count default is a convenience for the
    // STATELESS preview only — it advances in lockstep with the shrinking pool, so
    // the preview never re-asks. The real engine (P6) MUST pass a monotonic
    // per-turn counter so a presented-but-unanswered question isn't re-picked.
    round: input.round ?? answered.length,
    sessionId: input.sessionId ?? `preview-${versionId}`,
    ...(input.recentMessages ? { recentMessages: input.recentMessages } : {}),
  };

  return { context, byId: new Map(questions.map((q) => [q.id, q])) };
}
