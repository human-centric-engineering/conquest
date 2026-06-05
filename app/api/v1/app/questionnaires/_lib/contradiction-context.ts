/**
 * Route-local contradiction-detection context builder (F4.3).
 *
 * Maps a questionnaire version's persisted slots — plus its `contradictionMode` /
 * `contradictionWindowN` config — into the in-memory {@link ContradictionContext}
 * the detector capability reads. This is the DB seam:
 * `lib/app/questionnaire/contradiction/**` stays Prisma-free, so all the I/O lives
 * here.
 *
 * Session/turn/answer tables don't exist yet (F4.6/P6), so the answers to compare
 * are **caller-supplied** (a preview request body today, the engine later). The
 * mode/window default from the version's saved config but may be overridden in the
 * request, so an admin can preview what `flag` vs `probe` would surface before
 * committing the config. Answers address slots by stable `key`; unknown keys are
 * dropped (a stale preview key shouldn't 500). At least two answers must resolve to
 * real slots — fewer can't contradict — which maps to a 400.
 */

import { prisma } from '@/lib/db/client';
import {
  CONTRADICTION_MODES,
  QUESTION_TYPES,
  type AnswerProvenance,
  type ContradictionMode,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import type {
  AnsweredSlotView,
  ContradictionContext,
  ContradictionSlotView,
} from '@/lib/app/questionnaire/contradiction/types';

/** One caller-supplied captured answer to compare. */
export interface ContradictionAnswerInput {
  /** Slot key the answer belongs to. Unknown keys are ignored. */
  key: string;
  /** The captured value to compare. */
  value: unknown;
  /** Extraction confidence 0–1, or null. */
  confidence?: number | null;
  /** How the value was arrived at (inbound metadata only). */
  provenance?: AnswerProvenance;
  /** Which turn captured it (for windowing; F4.6 seam). */
  turnIndex?: number;
}

/** Caller-supplied session state — the half of the context the DB can't give yet. */
export interface ContradictionContextInput {
  /** The captured answers to compare. */
  answers: ContradictionAnswerInput[];
  /** Behaviour override; defaults to the version's saved `contradictionMode`. */
  mode?: ContradictionMode;
  /** Window override; defaults to the version's saved `contradictionWindowN`. */
  windowN?: number;
  /** Stable session id; defaults to a per-version preview id. */
  sessionId?: string;
}

/**
 * Outcome of building a contradiction context. `version_not_found` → 404 (the
 * id/versionId pair didn't resolve); `insufficient_answers` → 400 (fewer than two
 * supplied answers resolve to real slots, so no contradiction is possible).
 */
export type ContradictionContextResult =
  | { ok: true; context: ContradictionContext }
  | { ok: false; reason: 'version_not_found' | 'insufficient_answers' };

/** Narrow a stored slot `type` string to the enum, defaulting defensively. */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/** Narrow a stored `contradictionMode` string to the enum, defaulting to `off`. */
function asContradictionMode(value: string | undefined): ContradictionMode {
  return value !== undefined && (CONTRADICTION_MODES as readonly string[]).includes(value)
    ? (value as ContradictionMode)
    : 'off';
}

/**
 * Build the {@link ContradictionContext} for one version, scoped to its parent
 * questionnaire. Returns a discriminated result so the route can map the two
 * failure modes to 404 vs 400.
 */
export async function buildContradictionContext(
  questionnaireId: string,
  versionId: string,
  input: ContradictionContextInput
): Promise<ContradictionContextResult> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      id: true,
      config: { select: { contradictionMode: true, contradictionWindowN: true } },
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
  const slotsByKey = new Map<string, ContradictionSlotView>();
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

  // Keep only answers that resolve to a real slot (drop stale keys). Fewer than two
  // resolvable answers can't contradict.
  const answers: AnsweredSlotView[] = input.answers
    .filter((a) => slotsByKey.has(a.key))
    .map((a) => ({
      slotKey: a.key,
      value: a.value,
      confidence: a.confidence ?? null,
      ...(a.provenance !== undefined ? { provenance: a.provenance } : {}),
      ...(a.turnIndex !== undefined ? { turnIndex: a.turnIndex } : {}),
    }));
  if (answers.length < 2) return { ok: false, reason: 'insufficient_answers' };

  // Mode/window: caller override wins, else the version's saved config, else off/0.
  const mode = input.mode ?? asContradictionMode(version.config?.contradictionMode);
  const windowN = input.windowN ?? version.config?.contradictionWindowN ?? 0;

  const context: ContradictionContext = {
    slots: [...slotsByKey.values()],
    answers,
    mode,
    windowN,
    sessionId: input.sessionId ?? `preview-${versionId}`,
  };

  return { ok: true, context };
}
