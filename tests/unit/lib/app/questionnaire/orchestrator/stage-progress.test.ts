/**
 * Unit tests: the turn stage channel (F20.2).
 *
 * This module sits between a pure orchestrator and an async-generator route, which makes its worst
 * failure mode a **hang** rather than a wrong answer: if the drain loop ever waits on a resolver
 * nobody will call, the respondent's stream never closes and the composer stays locked for the rest
 * of the session. So the cases below lean on the shapes that could strand it — a pipeline that
 * emits nothing, one that emits and settles in the same tick, one that rejects.
 *
 * Every test is wrapped in a real timeout, so such a regression fails the suite rather than hanging
 * it. Note what that does NOT buy: the `Promise.race` inside `drain` is defensive, not load-bearing
 * (see its comment), so removing it keeps these green. They pin the observable contract —
 * termination, ordering, de-dup, error propagation — not one implementation detail of the wait.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createStageChannel,
  streamStageStatus,
  TURN_STAGES,
  TURN_STAGE_LABELS,
  type TurnStage,
} from '@/lib/app/questionnaire/orchestrator/stage-progress';

/** Reject rather than hang if the channel deadlocks — a hang would take the whole run with it. */
function withTimeout<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('stage channel deadlocked')), ms)
    ),
  ]);
}

/** Collect every stage the channel yields while `until` runs, plus the pipeline's own result. */
async function collect<T>(
  run: (emit: (s: TurnStage) => void) => Promise<T>
): Promise<{ stages: TurnStage[]; result: T }> {
  const channel = createStageChannel();
  const gen = channel.drain(run(channel.emit));
  const stages: TurnStage[] = [];
  let step = await gen.next();
  while (!step.done) {
    stages.push(step.value);
    step = await gen.next();
  }
  return { stages, result: step.value };
}

/** Yield to the microtask/macrotask queue so an awaiting drain loop gets a turn to run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createStageChannel', () => {
  it('yields each stage in order and returns the pipeline result', async () => {
    const { stages, result } = await withTimeout(
      collect(async (emit) => {
        emit('reading');
        await tick();
        emit('checking');
        await tick();
        emit('choosing');
        return { ok: true };
      })
    );

    expect(stages).toEqual(['reading', 'checking', 'choosing']);
    expect(result).toEqual({ ok: true });
  });

  it('completes cleanly when the pipeline emits no stage at all', async () => {
    // The deterministic branches (a replayed turn, an abuse abandon) reach no stage boundary at
    // all, so the drain has nothing to wake it but the pipeline settling. This is the case that
    // must terminate on that alone.
    const { stages, result } = await withTimeout(collect(async () => 'done'));

    expect(stages).toEqual([]);
    expect(result).toBe('done');
  });

  it('does not lose a stage emitted in the same tick the pipeline settles', async () => {
    const { stages, result } = await withTimeout(
      collect(async (emit) => {
        await tick();
        emit('choosing');
        return 'settled';
      })
    );

    expect(stages).toEqual(['choosing']);
    expect(result).toBe('settled');
  });

  it('announces a repeated stage once', async () => {
    // Both orchestrators can re-enter a boundary. Saying the same sentence twice reads as the
    // surface having stalled and restarted.
    const { stages } = await withTimeout(
      collect(async (emit) => {
        emit('checking');
        await tick();
        emit('checking');
        await tick();
        emit('choosing');
        return null;
      })
    );

    expect(stages).toEqual(['checking', 'choosing']);
  });

  it('re-announces a stage that recurs after a different one', async () => {
    // De-dup is against the LAST stage only — a genuine return to an earlier stage is real news.
    const { stages } = await withTimeout(
      collect(async (emit) => {
        emit('reading');
        await tick();
        emit('checking');
        await tick();
        emit('reading');
        return null;
      })
    );

    expect(stages).toEqual(['reading', 'checking', 'reading']);
  });

  it('propagates the pipeline rejection unchanged after draining what it emitted', async () => {
    // The route's catch persists the failure and unlocks the surface for a retry; swallowing or
    // re-wrapping the error here would leave a respondent with a dead stream and no record.
    const boom = new Error('pipeline failed');
    const channel = createStageChannel();
    const gen = channel.drain(
      (async () => {
        channel.emit('reading');
        await tick();
        throw boom;
      })()
    );

    const seen: TurnStage[] = [];
    await withTimeout(
      (async () => {
        await expect(
          (async () => {
            let step = await gen.next();
            while (!step.done) {
              seen.push(step.value);
              step = await gen.next();
            }
          })()
        ).rejects.toBe(boom);
      })()
    );

    // The stages reached before the failure still went out — a respondent who saw "Reading your
    // answer…" was not being told a lie just because the turn later broke.
    expect(seen).toEqual(['reading']);
  });

  it('streams stages while the pipeline is still running, not in one batch at the end', async () => {
    // The whole point: a batch at the end would be indistinguishable from the static "Thinking…"
    // this replaced. Proven by observing a stage BEFORE the pipeline is allowed to finish.
    const channel = createStageChannel();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const gen = channel.drain(
      (async () => {
        channel.emit('reading');
        await gate;
        return 'finished';
      })()
    );

    const first = await withTimeout(gen.next());
    expect(first.done).toBe(false);
    expect(first.value).toBe('reading');

    // Only now let the pipeline complete.
    release();
    const last = await withTimeout(gen.next());
    expect(last.done).toBe(true);
    expect(last.value).toBe('finished');
  });

  it('gives each turn its own de-dup memory', async () => {
    // A channel is per-turn. Were one shared, turn two's "reading" would be swallowed as a repeat
    // of turn one's — the respondent would watch a static indicator for the rest of the session.
    const first = await withTimeout(
      collect(async (emit) => {
        emit('reading');
        return 1;
      })
    );
    const second = await withTimeout(
      collect(async (emit) => {
        emit('reading');
        return 2;
      })
    );

    expect(first.stages).toEqual(['reading']);
    expect(second.stages).toEqual(['reading']);
  });
});

describe('streamStageStatus', () => {
  it('turns each stage into a status frame carrying its respondent-facing label', async () => {
    const channel = createStageChannel();
    const frames: Array<{ type: 'status'; message: string }> = [];

    const run = (async () => {
      channel.emit('reading');
      await tick();
      channel.emit('composing');
      return 'result';
    })();

    const result = await withTimeout(
      (async () => {
        const gen = streamStageStatus(channel, run);
        let step = await gen.next();
        while (!step.done) {
          frames.push(step.value);
          step = await gen.next();
        }
        return step.value;
      })()
    );

    expect(frames).toEqual([
      { type: 'status', message: TURN_STAGE_LABELS.reading },
      { type: 'status', message: TURN_STAGE_LABELS.composing },
    ]);
    expect(result).toBe('result');
  });

  it('has a non-empty label for every declared stage', () => {
    // A missing entry would render as `undefined` and the parser would drop the frame, silently
    // stranding the indicator on the previous stage.
    for (const stage of TURN_STAGES) {
      expect(TURN_STAGE_LABELS[stage]?.trim().length).toBeGreaterThan(0);
    }
  });

  it('speaks plain English — no implementation vocabulary reaches the respondent', () => {
    // House rule: a respondent surface never names the machinery. These are the words the
    // pipeline actually uses internally, and none of them belongs on screen.
    const forbidden =
      /extract|orchestrat|invoke|capabilit|slot|pipeline|LLM|agent|token|seriousness|sensitivity/i;
    for (const stage of TURN_STAGES) {
      expect(TURN_STAGE_LABELS[stage]).not.toMatch(forbidden);
    }
  });
});

describe('the channel does not disturb the orchestrator contract', () => {
  it('emitting is synchronous, returns nothing, and never awaits the consumer', () => {
    // `runTurn` is pure and must stay so: the emitter is called inline between awaits, so anything
    // it returned or threw would leak into the pipeline's own control flow.
    const channel = createStageChannel();
    const spy = vi.fn(channel.emit);

    expect(spy('reading')).toBeUndefined();
    // Emitting with nobody draining must not throw or block — a route that never drains (or a
    // caller that passed the emitter and then bailed) must not take the turn down with it.
    expect(() => {
      spy('checking');
      spy('choosing');
    }).not.toThrow();
  });
});
