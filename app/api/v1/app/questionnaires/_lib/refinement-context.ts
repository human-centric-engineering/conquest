/**
 * Route-local answer-refinement context builder (F4.4).
 *
 * Maps a questionnaire version's persisted slots into the in-memory
 * {@link RefinementContext} the refiner capability reads. This is the read-side DB
 * seam: `lib/app/questionnaire/refinement/**` stays Prisma-free, so the slot I/O
 * lives here. (The write-side seam — seeding and persisting answer rows — is
 * `_lib/answer-slots.ts`.)
 *
 * The existing answers to refine are **caller-supplied** (a refine-answer request
 * body today, the engine later): the route seeds them as `AppAnswerSlot` rows before
 * refining. Answers address slots by stable `key`; unknown keys are dropped (a stale
 * key shouldn't 500). At least one answer must resolve to a real slot — nothing to
 * refine otherwise — which maps to a 400. The projected slots carry their `id` so the
 * route can resolve `slotKey → AppQuestionSlot.id` for the write path without a
 * second query.
 */

import { prisma } from '@/lib/db/client';
import {
  QUESTION_TYPES,
  type AnswerProvenance,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import type {
  ExistingAnswerView,
  RefinementContext,
  RefinementHistoryEntry,
  RefinementSlotView,
} from '@/lib/app/questionnaire/refinement/types';

/** One caller-supplied existing answer eligible for refinement. */
export interface RefinementAnswerInput {
  /** Slot key the answer belongs to. Unknown keys are ignored. */
  key: string;
  /** The currently-recorded value. */
  value: unknown;
  /** How the current value was arrived at. */
  provenance: AnswerProvenance;
  /** The current value's justification, if any. */
  rationale?: string;
  /** Capture confidence 0–1, or null. */
  confidence?: number | null;
  /** Which turn captured it (F4.6 seam). */
  turnIndex?: number;
  /** Prior refinements of this slot. */
  refinementHistory?: RefinementHistoryEntry[];
}

/** Caller-supplied session state — the half of the context the DB can't give yet. */
export interface RefinementContextInput {
  /** The already-captured answers eligible for refinement. */
  existingAnswers: RefinementAnswerInput[];
  /** The respondent's new message that may warrant a refinement. */
  userMessage?: string;
  /** The F4.3 finding that triggered this pass (the detection→refinement handoff). */
  triggeringContradiction?: RefinementContext['triggeringContradiction'];
  /** Recent transcript lines, oldest first. */
  recentMessages?: string[];
  /** Stable session id; defaults to a per-version preview id. */
  sessionId?: string;
}

/**
 * Outcome of building a refinement context. `version_not_found` → 404 (the
 * id/versionId pair didn't resolve); `no_resolvable_answers` → 400 (none of the
 * supplied answers resolve to real slots, so there is nothing to refine).
 */
export type RefinementContextResult =
  | { ok: true; context: RefinementContext }
  | { ok: false; reason: 'version_not_found' | 'no_resolvable_answers' };

/** Narrow a stored slot `type` string to the enum, defaulting defensively. */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/**
 * Build the {@link RefinementContext} for one version, scoped to its parent
 * questionnaire. Returns a discriminated result so the route can map the two failure
 * modes to 404 vs 400.
 */
export async function buildRefinementContext(
  questionnaireId: string,
  versionId: string,
  input: RefinementContextInput
): Promise<RefinementContextResult> {
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

  // Project every slot, indexed by key (carrying its id for the write path).
  const slotsByKey = new Map<string, RefinementSlotView>();
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

  // Keep only answers that resolve to a real slot (drop stale keys). Nothing
  // resolvable → nothing to refine.
  const existingAnswers: ExistingAnswerView[] = input.existingAnswers
    .filter((a) => slotsByKey.has(a.key))
    .map((a) => ({
      slotKey: a.key,
      value: a.value,
      provenance: a.provenance,
      ...(a.rationale !== undefined ? { rationale: a.rationale } : {}),
      ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
      ...(a.turnIndex !== undefined ? { turnIndex: a.turnIndex } : {}),
      ...(a.refinementHistory !== undefined ? { refinementHistory: a.refinementHistory } : {}),
    }));
  if (existingAnswers.length === 0) return { ok: false, reason: 'no_resolvable_answers' };

  const context: RefinementContext = {
    slots: [...slotsByKey.values()],
    existingAnswers,
    sessionId: input.sessionId ?? `preview-${versionId}`,
    ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
    ...(input.triggeringContradiction !== undefined
      ? { triggeringContradiction: input.triggeringContradiction }
      : {}),
    ...(input.recentMessages !== undefined ? { recentMessages: input.recentMessages } : {}),
  };

  return { ok: true, context };
}
