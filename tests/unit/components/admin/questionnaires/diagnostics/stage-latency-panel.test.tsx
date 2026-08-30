// @vitest-environment happy-dom

/**
 * Unit tests: `StageLatencyPanel` — where a turn's time goes (F20.1).
 *
 * The panel exists to stop latency work being a guess, so the assertions are mostly about it
 * refusing to mislead: it distinguishes "nothing was measured" from "nothing was slow", it always
 * shows the residual row (the finding that would send the whole plan back), and it renders the
 * per-turn figure rather than the per-call one — the two differ for any stage that does not run
 * every turn, and reading the wrong one points the work at the wrong stage.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { StageLatencyPanel } from '@/components/admin/questionnaires/diagnostics/stage-latency-panel';
import type {
  StageLatencyBreakdown,
  StageLatencyRow,
} from '@/lib/app/questionnaire/analytics/views';

function stage(label: string, overrides: Partial<StageLatencyRow> = {}): StageLatencyRow {
  return {
    label,
    calls: 10,
    avgMs: 900,
    p95Ms: 1400,
    totalMs: 9000,
    perTurnMs: 900,
    ...overrides,
  };
}

function breakdown(overrides: Partial<StageLatencyBreakdown> = {}): StageLatencyBreakdown {
  return {
    turns: 10,
    totalTurnMs: 20_000,
    totalCallMs: 17_000,
    residualMs: 3_000,
    residualShare: 0.15,
    stages: [stage('Interviewer phrasing')],
    ...overrides,
  };
}

/** The panel's one table row whose first cell starts with `label`. */
function rowFor(label: string): HTMLElement {
  const cell = screen.getByText((_, node) => node?.textContent?.startsWith(label) === true, {
    selector: 'td',
  });
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

describe('StageLatencyPanel', () => {
  it('says nothing was measured rather than rendering an empty table', () => {
    render(<StageLatencyPanel data={breakdown({ turns: 0, stages: [] })} />);

    // An empty table would read as "no stage was slow", which is the opposite of the truth.
    expect(screen.getByText(/no turn in this window recorded per-stage timings/i)).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('renders the per-turn cost, not the per-call average, for a stage that skips turns', () => {
    render(
      <StageLatencyPanel
        data={breakdown({
          turns: 10,
          // Ran on 3 of 10 turns at ~1.2s each: 371ms per turn, 1,237ms per call.
          stages: [
            stage('Seriousness judge', {
              calls: 3,
              avgMs: 1237,
              p95Ms: 1568,
              totalMs: 3711,
              perTurnMs: 371.1,
            }),
          ],
        })}
      />
    );

    const row = rowFor('Seriousness judge');
    // Both are shown — the point is that they differ and the panel does not conflate them.
    expect(within(row).getByText('371 ms')).toBeTruthy();
    expect(within(row).getByText('1.2 s')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
  });

  it('always shows the residual row, even when overhead is negligible', () => {
    render(
      <StageLatencyPanel
        data={breakdown({
          turns: 10,
          totalTurnMs: 50_000,
          totalCallMs: 49_000,
          residualMs: 1_000,
          residualShare: 0.02,
        })}
      />
    );

    // A 2% residual is the finding that says "keep going" — omitting the row when it is small
    // would hide exactly the reading the panel was built to produce.
    const row = rowFor('Not in a model call');
    expect(within(row).getByText('100 ms')).toBeTruthy();
    expect(within(row).getByText('2%')).toBeTruthy();
  });

  it('reports a dominant residual so the reader can stop shaving model calls', () => {
    render(
      <StageLatencyPanel
        data={breakdown({
          turns: 4,
          totalTurnMs: 8_000,
          totalCallMs: 2_000,
          residualMs: 6_000,
          residualShare: 0.75,
          stages: [
            stage('Answer extraction', {
              calls: 4,
              avgMs: 500,
              p95Ms: 600,
              totalMs: 2_000,
              perTurnMs: 500,
            }),
          ],
        })}
      />
    );

    const row = rowFor('Not in a model call');
    expect(within(row).getByText('75%')).toBeTruthy();
    expect(within(row).getByText('1.5 s')).toBeTruthy();
  });

  it('summarises the average turn and how much of it waited on a model', () => {
    render(
      <StageLatencyPanel
        data={breakdown({ turns: 10, totalTurnMs: 50_000, totalCallMs: 49_000 })}
      />
    );

    // 50s over 10 turns = 5.0s each, of which 4.9s was model time.
    expect(screen.getByText(/10 turns averaging 5\.0 s end to end/i)).toBeTruthy();
    expect(screen.getByText(/4\.9 s was spent waiting on a model/i)).toBeTruthy();
  });

  it('orders stages as the aggregator handed them over (costliest first)', () => {
    render(
      <StageLatencyPanel
        data={breakdown({
          stages: [
            stage('Interviewer phrasing', { totalMs: 9_000, perTurnMs: 900 }),
            stage('Answer extraction', { totalMs: 6_000, perTurnMs: 600 }),
            stage('Sensitivity detection', { totalMs: 2_000, perTurnMs: 200 }),
          ],
        })}
      />
    );

    const labels = Array.from(document.querySelectorAll('tbody tr td:first-child')).map((c) =>
      (c.textContent ?? '').trim()
    );
    expect(labels.slice(0, 3)).toEqual([
      'Interviewer phrasing',
      'Answer extraction',
      'Sensitivity detection',
    ]);
    // The residual is pinned last, below every stage, because it is not one.
    expect(labels[labels.length - 1]?.startsWith('Not in a model call')).toBe(true);
  });
});
