/**
 * Turn stage progress — how the orchestrator tells the respondent what it is doing (P20 Phase 2).
 *
 * A respondent answers, and then waits through four to six sequential model calls before the first
 * token of the reply appears. Until this existed the surface showed one static `Thinking…` for all
 * of them, so a 5-second turn and a stuck turn looked identical.
 *
 * Two constraints shaped the design:
 *
 *   - **`runTurn` is pure.** Its contract is that all I/O belongs to the route and the core only
 *     decides (see `orchestrator.ts`). So the orchestrator is handed a {@link StageEmitter} — a
 *     synchronous, side-effect-only callback it calls as it crosses a stage boundary. It performs
 *     no I/O, returns nothing, and cannot fail the pipeline. Purity relative to the RESULT is
 *     preserved: same state + same invoker outputs still produce the same {@link TurnResult}.
 *   - **The route is an async generator**, so a plain callback cannot `yield`. Hence the channel:
 *     the emitter fills a queue, and {@link StageChannel.drain} lets the route pull from that queue
 *     concurrently with the pipeline promise and turn each stage into an SSE frame. That queue/drain
 *     machinery is generic and now lives in `createProgressChannel`; this module owns the turn's
 *     stage vocabulary and its labels.
 *
 * Passing no emitter is always valid and changes nothing — which is what keeps every existing
 * caller and test of `runTurn` working untouched.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts — the drain + `status` frames
 * @see .context/app/questionnaire/turn-progress.md
 */

import { createProgressChannel } from '@/lib/app/questionnaire/llm/progress-channel';

/**
 * The stages a respondent is told about, in the order a turn crosses them.
 *
 * Deliberately COARSER than the pipeline's real steps. `reading` covers extraction, sensitivity
 * detection and the seriousness judge — three calls, one honest sentence. Announcing each would
 * flicker three labels through in under two seconds and, worse, would tell a respondent that their
 * answer is being judged for sincerity, which is true but is not a thing to say out loud.
 */
export const TURN_STAGES = ['reading', 'checking', 'choosing', 'composing'] as const;
export type TurnStage = (typeof TURN_STAGES)[number];

/**
 * What each stage says on screen.
 *
 * Plain English, per the house rule against implementation vocabulary on a respondent surface —
 * no "extracting", "orchestrating", "invoking", no capability slugs. Each is a claim about work
 * that has genuinely started, so none of them can be a lie.
 */
export const TURN_STAGE_LABELS: Record<TurnStage, string> = {
  reading: 'Reading your answer…',
  checking: "Checking that against what you've told me…",
  choosing: 'Choosing what to ask next…',
  composing: 'Writing the next question…',
};

/** What the orchestrator is handed: fire-and-forget, never awaited, never able to throw upward. */
export type StageEmitter = (stage: TurnStage) => void;

export interface StageChannel {
  /** Hand this to `runTurn` / `runDataSlotTurn`. */
  emit: StageEmitter;
  /**
   * Drive `until` to completion, yielding each stage as it is reached and finally returning the
   * pipeline's own result. Rejections propagate unchanged, so the route's existing try/catch around
   * the pipeline keeps working exactly as it did.
   */
  drain<T>(until: Promise<T>): AsyncGenerator<TurnStage, T, undefined>;
}

/**
 * A one-shot channel for a single turn. Not reusable across turns — the de-dup memory is per-turn
 * state, and a shared channel would swallow the second turn's `reading`.
 *
 * De-dup is on the stage itself: both orchestrators can re-enter a boundary (a probe turn re-runs
 * the contradiction phase), and re-announcing the same sentence reads as the surface having stalled
 * and restarted.
 */
export function createStageChannel(): StageChannel {
  return createProgressChannel<TurnStage>({ dedupeKey: (stage) => stage });
}

/**
 * The route-side adapter: drive `until`, emitting a respondent-safe `status` frame per stage and
 * returning the pipeline result, so a caller can write `yield* streamStageStatus(...)`.
 */
export async function* streamStageStatus<T>(
  channel: StageChannel,
  until: Promise<T>
): AsyncGenerator<{ type: 'status'; message: string }, T, undefined> {
  const stages = channel.drain(until);
  let step = await stages.next();
  while (!step.done) {
    yield { type: 'status', message: TURN_STAGE_LABELS[step.value] };
    step = await stages.next();
  }
  return step.value;
}
