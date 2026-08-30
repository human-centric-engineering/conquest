'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * How long a stage label stays on screen before the next one may replace it.
 *
 * The pipeline does not pace itself: `reading` covers three model calls and can be crossed in a
 * few hundred milliseconds, while `choosing` → `composing` is often back-to-back. Streamed
 * straight to the surface, two or three sentences can flash past inside a second — the respondent
 * sees motion and reads none of it, which is worse than the single static label this replaced.
 *
 * 1.1s is a comfortable read of the longest label ("Checking that against what you've told me…")
 * and still fits the whole four-stage sequence inside a measured ~5s turn (F20.1). Longer would
 * start to lie: a turn that finishes before the queue drains simply stops mid-sequence.
 */
export const STAGE_MIN_DWELL_MS = 1_100;

/**
 * Pace a stream of stage labels so each one is readable, without inventing any.
 *
 * Every label that arrives is shown, in order, for at least {@link STAGE_MIN_DWELL_MS}. Labels
 * that arrive during a dwell queue behind it rather than overwriting it. Nothing is ever
 * fabricated, re-ordered, or held back at the START of a turn — the first label of a turn appears
 * the moment it lands, because delaying real news to keep a rhythm would make the indicator less
 * honest than the pipeline it reports on.
 *
 * **Why here and not in the indicator.** Two surfaces read the same label — the transcript's
 * `TurnProgress` and the composer's disabled-field placeholder. Pacing each of them separately
 * would give two clocks started at different moments, and they would drift within a turn: the
 * transcript saying "Reading your answer…" while the composer two inches below says "Writing the
 * next question…". Paced once in `ConversationProvider`, both halves are necessarily in step.
 *
 * A null (or blank) label means the turn is over — the stream cleared it on the first content
 * delta or in teardown. That resets everything immediately: the queue is dropped rather than
 * drained, so a stage from the turn just finished can never appear beside the next turn's wait.
 *
 * @param label the raw label from the stream, or null between turns
 * @param minDwellMs override the dwell (tests, and nothing else so far)
 * @returns the label that should currently be on screen, or null
 *
 * @see components/app/questionnaire/chat/conversation-context.tsx — the single call site
 * @see .context/app/questionnaire/turn-progress.md
 */
export function usePacedStageLabel(
  label: string | null,
  minDwellMs: number = STAGE_MIN_DWELL_MS
): string | null {
  const [shown, setShown] = useState<string | null>(null);
  // When `shown` was promoted. An absolute stamp rather than a "holding" flag so the scheduler
  // below can be re-derived from state at any moment — which is what makes it safe under React
  // 19 StrictMode, where every effect is set up, torn down and set up again.
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [queue, setQueue] = useState<readonly string[]>([]);
  // The last label ENQUEUED. The stream re-sends nothing today, but a repeat here would queue the
  // same sentence twice and read as the surface having stalled and restarted.
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    const next = label && label.trim().length > 0 ? label : null;

    if (next === null) {
      lastSeen.current = null;
      setShown(null);
      setQueue((q) => (q.length === 0 ? q : []));
      return;
    }

    if (next === lastSeen.current) return;
    lastSeen.current = next;
    setQueue((q) => [...q, next]);
  }, [label]);

  useEffect(() => {
    if (queue.length === 0) return;

    // Nothing on screen yet means this is the first label of a turn (or of the session), and it
    // goes up at once: the dwell exists to stop labels overwriting EACH OTHER, not to sit on the
    // neutral opener while the server has already said what it is doing.
    const wait = shown === null ? 0 : Math.max(0, shownAt + minDwellMs - Date.now());
    const timer = setTimeout(() => {
      setShown(queue[0] ?? null);
      setShownAt(Date.now());
      setQueue((q) => q.slice(1));
    }, wait);

    return () => clearTimeout(timer);
  }, [queue, shown, shownAt, minDwellMs]);

  return shown;
}
