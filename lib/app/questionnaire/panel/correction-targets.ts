/**
 * Correction targets for the inline "fix this answer" gesture (Variant B) — pure projection.
 *
 * Given the answer-panel view and a set of slot keys (the slots/data-slots the most-recent turn just
 * filled, in display order), resolve each into a {@link CorrectionTarget}: a label, a short read-back
 * of what was captured, and the editable QUESTION(s) the inline editor writes through `PUT …/answers`.
 *
 * - Question mode: each key is a question slot → one editable question (the slot itself).
 * - Data-slot mode: each key is a data slot → its mapped questions (from `coverage.questions`), so a
 *   fix edits the underlying questions and reconciliation recomputes the reading. A data slot with no
 *   mapped questions yields no target (nothing editable), so the gesture is simply absent for it.
 *
 * Pure (no React / Prisma) so it unit-tests in isolation and both the chat strip and the panel can
 * share one resolution.
 */

import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';
import type { AnswerPanelView, EditableSlot } from '@/lib/app/questionnaire/panel/types';

/** One editable question within a correction target, with its current value (seeds the editor). */
export interface EditableQuestion {
  slot: EditableSlot;
  initialValue: unknown;
}

/**
 * The bundle the answer-panel rows need to mount an inline correction editor (Variant B): the
 * session identity, the optional anonymous token, and the post-save refetch. Threaded from
 * SessionWorkspace; `undefined` at the row means the gesture is hidden (toggle off / read-only /
 * blocked session).
 */
export interface PanelCorrection {
  sessionId: string;
  accessToken?: string;
  onCorrected: (view: AnswerPanelView) => void;
}

/** One "thing the turn captured" that the respondent can fix inline. */
export interface CorrectionTarget {
  /** Stable key of the slot/data-slot — the React key and de-dup handle. */
  key: string;
  /** What was recorded — the question prompt (question mode) or data-slot name (data-slot mode). */
  label: string;
  /** A short read-back of the current value/paraphrase for the "→ …" peek; null when none. */
  summary: string | null;
  /** The editable question(s) — one in question mode, the mapped questions in data-slot mode. */
  questions: EditableQuestion[];
}

/**
 * Resolve the given keys (a turn's just-filled slots, in display order) into correction targets,
 * preserving the order of `keys`. Targets with no editable question are dropped. Returns `[]` when the
 * view is null or no key resolves.
 */
export function buildCorrectionTargets(
  view: AnswerPanelView | null,
  keys: readonly string[]
): CorrectionTarget[] {
  if (!view || keys.length === 0) return [];

  const targets: CorrectionTarget[] = [];

  if (view.dataSlotGroups) {
    // Data-slot mode: index the visible data slots by key, then edit each one's mapped questions.
    const slotByKey = new Map(view.dataSlotGroups.flatMap((g) => g.slots).map((s) => [s.key, s]));
    for (const key of keys) {
      const slot = slotByKey.get(key);
      if (!slot) continue;
      const questions: EditableQuestion[] = (slot.coverage?.questions ?? []).map((q) => ({
        slot: { slotKey: q.key, prompt: q.label, type: q.type, typeConfig: q.typeConfig },
        initialValue: q.value,
      }));
      if (questions.length === 0) continue; // no mapped questions → nothing to fix
      targets.push({
        key: slot.key,
        label: slot.name,
        summary: slot.paraphrase,
        questions,
      });
    }
    return targets;
  }

  // Question mode: index the question slots by key, each its own single-question target.
  const slotByKey = new Map(
    view.sections.flatMap((s) => s.slots).map((slot) => [slot.slotKey, slot])
  );
  for (const key of keys) {
    const slot = slotByKey.get(key);
    if (!slot || !slot.answered) continue;
    targets.push({
      key: slot.slotKey,
      label: slot.prompt,
      summary: formatSlotAnswer(slot.type, slot.typeConfig, slot.value),
      questions: [
        {
          slot: {
            slotKey: slot.slotKey,
            prompt: slot.prompt,
            type: slot.type,
            typeConfig: slot.typeConfig,
          },
          initialValue: slot.value,
        },
      ],
    });
  }
  return targets;
}
