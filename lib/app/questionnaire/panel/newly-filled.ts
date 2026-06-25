/**
 * Newly-filled detection for the data-slot answer panel (F7.x — slot overview minimap).
 *
 * The respondent panel fetches a WHOLE snapshot after each turn (no delta), and the stream hook
 * never tells the client the turn ordinal — so "which data slots did this turn fill?" is answered
 * by diffing the previous snapshot against the new one, in panel display order. The workspace feeds
 * the resulting ordered keys to the panel, which scrolls to the first and steps through the rest.
 *
 * Data-slot mode only: question mode is unchanged. Pure + Prisma/React-free so it unit-tests in
 * isolation, mirroring `confidence.ts` / `answer-panel.ts`'s pure-core convention.
 */

import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

/** Stable DOM id for a panel slot row — shared by the minimap (scroll target) and the stepper. */
export function panelSlotDomId(key: string): string {
  return `panel-slot-${key}`;
}

/**
 * The keys filled/updated by the MOST RECENT fill-turn — i.e. those whose `answeredAtTurnIndex`
 * equals the maximum across all items. Used to keep the "previous-turn" highlight pulsing on both the
 * data-slot and form surfaces: unlike the diff-based `diffNewlyFilled` (which drives the one-shot
 * stepper and clears on a no-fill turn), this stays put until a newer turn actually fills something.
 * Returns an empty set when nothing has been captured yet (all indices null).
 */
export function recentlyFilledByLatestTurn(
  items: ReadonlyArray<{ key: string; answeredAtTurnIndex: number | null }>
): Set<string> {
  let max = 0;
  for (const it of items) {
    if (it.answeredAtTurnIndex != null && it.answeredAtTurnIndex > max)
      max = it.answeredAtTurnIndex;
  }
  const result = new Set<string>();
  if (max === 0) return result;
  for (const it of items) {
    if (it.answeredAtTurnIndex === max) result.add(it.key);
  }
  return result;
}

/**
 * All data-slot keys in panel display order (groups in order, slots within each group in order).
 * The stepper walks this order top-to-bottom, so it must match what the panel renders. Returns an
 * empty array when the view is null or not in data-slot mode.
 */
export function dataSlotKeysInOrder(view: AnswerPanelView | null): string[] {
  if (!view?.dataSlotGroups) return [];
  return view.dataSlotGroups.flatMap((g) => g.slots.map((s) => s.key));
}

/** Index a view's data slots by key for O(1) before/after comparison. */
function dataSlotsByKey(view: AnswerPanelView | null): Map<string, DataSlotPanelSlot> {
  const map = new Map<string, DataSlotPanelSlot>();
  if (!view?.dataSlotGroups) return map;
  for (const group of view.dataSlotGroups) {
    for (const slot of group.slots) map.set(slot.key, slot);
  }
  return map;
}

/**
 * The data-slot keys a turn just filled or updated, in panel display order.
 *
 * A slot counts as "newly filled this turn" when, comparing the previous snapshot to the next:
 *  - it was not `filled` before but is now (a fresh capture), OR
 *  - it was already filled and its `answeredAtTurnIndex` advanced (a refinement, value change, or
 *    provisional→confident this turn — the index moves whenever the latest turn re-touched it).
 *
 * Returns `[]` when `prev` is null (first paint / SSR seed — never auto-scroll on the seeded view)
 * or when nothing changed.
 */
export function diffNewlyFilled(
  prev: AnswerPanelView | null,
  next: AnswerPanelView | null
): string[] {
  if (prev === null) return [];
  // If the previous snapshot wasn't in data-slot mode, there's no comparable baseline — treat this as
  // a fresh seed (never auto-scroll), rather than reporting every already-filled slot as new.
  if (!prev.dataSlotGroups) return [];
  if (!next?.dataSlotGroups) return [];

  const before = dataSlotsByKey(prev);
  const result: string[] = [];
  // Iterate `next` in display order so the stepper walks the panel top-to-bottom.
  for (const group of next.dataSlotGroups) {
    for (const slot of group.slots) {
      const prior = before.get(slot.key);
      const becameFilled = slot.filled && !(prior?.filled ?? false);
      const turnAdvanced =
        slot.filled &&
        slot.answeredAtTurnIndex != null &&
        slot.answeredAtTurnIndex !== (prior?.answeredAtTurnIndex ?? null);
      if (becameFilled || turnAdvanced) result.push(slot.key);
    }
  }
  return result;
}

/** Index a view's question slots by key for O(1) before/after comparison. */
function questionSlotsByKey(view: AnswerPanelView | null): Map<string, PanelSlotView> {
  const map = new Map<string, PanelSlotView>();
  if (!view) return map;
  for (const section of view.sections) {
    for (const slot of section.slots) map.set(slot.slotKey, slot);
  }
  return map;
}

/**
 * The QUESTION-mode equivalent of {@link diffNewlyFilled} — the question slot keys a turn just
 * captured or updated, in panel display order (sections in order, slots within each in order).
 *
 * A slot counts as "newly filled this turn" when, comparing the previous snapshot to the next:
 *  - it was not `answered` before but is now (a fresh capture), OR
 *  - it was already answered and its `answeredAtTurnIndex` advanced (a refinement / value change
 *    this turn — the index moves whenever the latest turn re-touched it).
 *
 * Returns `[]` when `prev` is null (first paint / SSR seed — never auto-surface the seeded view),
 * when either snapshot is in data-slot mode (use {@link diffNewlyFilled} there), or when nothing
 * changed. Drives the chat-side "fix what you just said" correction strip (Variant B), which targets
 * only the slots the most-recent turn filled.
 */
export function diffNewlyFilledQuestions(
  prev: AnswerPanelView | null,
  next: AnswerPanelView | null
): string[] {
  if (prev === null) return [];
  // Question mode only — a data-slot snapshot has no comparable `sections` baseline.
  if (prev.dataSlotGroups || next?.dataSlotGroups) return [];
  if (!next) return [];

  const before = questionSlotsByKey(prev);
  const result: string[] = [];
  for (const section of next.sections) {
    for (const slot of section.slots) {
      const prior = before.get(slot.slotKey);
      const becameAnswered = slot.answered && !(prior?.answered ?? false);
      const turnAdvanced =
        slot.answered &&
        slot.answeredAtTurnIndex != null &&
        slot.answeredAtTurnIndex !== (prior?.answeredAtTurnIndex ?? null);
      if (becameAnswered || turnAdvanced) result.push(slot.slotKey);
    }
  }
  return result;
}
