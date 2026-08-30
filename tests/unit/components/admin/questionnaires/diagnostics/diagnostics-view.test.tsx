// @vitest-environment happy-dom

/**
 * Unit tests: `DiagnosticsView` — the version rollup an operator reads (F8.5, extended by F20.1).
 *
 * This is the page an operator opens when a respondent reports something went wrong, so the cases
 * worth pinning are the ones where a wrong render is *plausible and quiet*: a load failure that
 * looks like an empty window, an identity leaked in anonymous mode, a walk-up group linked as if it
 * were an invitation, or an error count that reads as zero because the badge never rendered.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { DiagnosticsView } from '@/components/admin/questionnaires/diagnostics/diagnostics-view';
import type {
  InvitationDiagnosticsRow,
  VersionDiagnosticsResult,
} from '@/lib/app/questionnaire/analytics/views';

const QUESTIONNAIRE_ID = 'q_abc';
const VERSION_ID = 'v_def';
const FILTERS = { from: '2026-08-01', to: '2026-08-30' };

function invitation(overrides: Partial<InvitationDiagnosticsRow> = {}): InvitationDiagnosticsRow {
  return {
    invitationId: 'inv_11112222333344445555',
    email: 'rowan@example.com',
    name: 'Rowan',
    status: 'completed',
    sentAt: '2026-08-02T09:00:00.000Z',
    openedAt: '2026-08-02T09:05:00.000Z',
    registeredAt: '2026-08-02T09:06:00.000Z',
    sessionCount: 1,
    sessionStatuses: ['completed'],
    turns: 12,
    promptTokens: 8_000,
    completionTokens: 2_000,
    costUsd: 0.42,
    avgTurnMs: 3_400,
    errorCount: 0,
    lastActivityAt: '2026-08-02T09:40:00.000Z',
    ...overrides,
  };
}

function result(overrides: Partial<VersionDiagnosticsResult> = {}): VersionDiagnosticsResult {
  return {
    versionId: VERSION_ID,
    range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' },
    totals: {
      sessions: 3,
      turns: 30,
      promptTokens: 20_000,
      completionTokens: 5_000,
      totalTokens: 25_000,
      costUsd: 1.25,
      avgTurnMs: 3_400,
      p95TurnMs: 7_100,
      errorCount: 2,
      errorsBySeverity: { error: 1, warning: 1, info: 0 },
    },
    invitations: [invitation()],
    stageLatency: {
      turns: 30,
      totalTurnMs: 102_000,
      totalCallMs: 81_000,
      residualMs: 21_000,
      residualShare: 0.2,
      stages: [
        {
          label: 'Interviewer phrasing',
          calls: 30,
          avgMs: 1_800,
          p95Ms: 2_400,
          totalMs: 54_000,
          perTurnMs: 1_800,
        },
      ],
    },
    identitySuppressed: false,
    ...overrides,
  };
}

/** The one table row whose Invitee cell starts with `label`. */
function rowFor(label: string): HTMLElement {
  const cell = screen.getByText((_, node) => node?.textContent?.startsWith(label) === true, {
    selector: 'td',
  });
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

describe('DiagnosticsView', () => {
  it('says diagnostics could not be loaded rather than rendering an empty window', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={null}
        filters={FILTERS}
      />
    );

    // A null result and a quiet window are different facts. Rendering the empty-state table for a
    // failed query would tell the operator "nothing happened" when the truth is "we did not look".
    expect(screen.getByText(/diagnostics couldn’t be loaded/i)).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('renders the rollup tiles from the totals, not from the row list', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result()}
        filters={FILTERS}
      />
    );

    expect(screen.getByText('25,000')).toBeTruthy(); // tokens
    expect(screen.getByText('20,000 in / 5,000 out')).toBeTruthy();
    expect(screen.getByText('p95 7.1 s')).toBeTruthy();
    expect(screen.getByText('1 error · 1 warn · 0 info')).toBeTruthy();
  });

  it('shows the stage-latency split alongside the tiles', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result()}
        filters={FILTERS}
      />
    );

    // F20.1 wired this panel in; the rollup is where "which stage is the wait?" gets answered.
    expect(screen.getByText(/where the time goes/i)).toBeTruthy();
    expect(screen.getByText('Interviewer phrasing')).toBeTruthy();
  });

  it('links an invitation row to its drill-down, keyed on the version being viewed', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result()}
        filters={FILTERS}
      />
    );

    const link = screen.getByRole('link', { name: /Rowan · rowan@example\.com/ });
    expect(link.getAttribute('href')).toBe(
      `/admin/questionnaires/${QUESTIONNAIRE_ID}/v/${VERSION_ID}/diagnostics/inv_11112222333344445555`
    );
  });

  it('leaves the walk-up group unlinked and labels it as having no invitation', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result({
          invitations: [
            invitation({
              invitationId: null,
              email: null,
              name: null,
              status: null,
              sessionStatuses: ['active'],
            }),
          ],
        })}
        filters={FILTERS}
      />
    );

    const row = rowFor('(no invitation)');
    // There is no drill-down to link to — public/walk-up sessions have no invitation record.
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('—')).toBeTruthy(); // no lifecycle status to badge
  });

  it('withholds identity in anonymous mode and says so', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result({
          identitySuppressed: true,
          invitations: [invitation({ email: null, name: null })],
        })}
        filters={FILTERS}
      />
    );

    // The aggregator withholds email/name; the view must not reconstruct an identity from the id,
    // and the operator has to be told the column is suppressed rather than empty.
    expect(screen.getByText(/identities are hidden \(anonymous mode\)/i)).toBeTruthy();
    expect(screen.queryByText(/rowan@example\.com/)).toBeNull();
    expect(screen.getByText(/^Invitation inv_1111$/)).toBeTruthy();
  });

  it('badges a row that recorded errors and renders a plain zero when it did not', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result({
          invitations: [
            invitation({
              invitationId: 'inv_aaaa1111',
              email: 'clean@example.com',
              name: null,
              errorCount: 0,
            }),
            invitation({
              invitationId: 'inv_bbbb2222',
              email: 'broken@example.com',
              name: null,
              errorCount: 3,
            }),
          ],
        })}
        filters={FILTERS}
      />
    );

    expect(within(rowFor('clean@example.com')).getByText('0')).toBeTruthy();
    // The row worth clicking has to be findable at a glance, which is the badge's whole job.
    expect(within(rowFor('broken@example.com')).getByText('3')).toBeTruthy();
  });

  it('says the window is empty rather than rendering a headed table with no rows', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result({ invitations: [] })}
        filters={FILTERS}
      />
    );

    expect(screen.getByText(/no invitations or sessions in this window yet/i)).toBeTruthy();
    // The stage panel keeps its own table; what must not appear is the per-invitation one.
    expect(screen.queryByRole('columnheader', { name: 'Invitee' })).toBeNull();
  });

  it('seeds the date filter form with the window currently applied', () => {
    render(
      <DiagnosticsView
        questionnaireId={QUESTIONNAIRE_ID}
        versionId={VERSION_ID}
        data={result()}
        filters={FILTERS}
      />
    );

    // A GET form that forgets the active window silently widens it on every Apply.
    expect(document.querySelector<HTMLInputElement>('input[name="from"]')?.value).toBe(
      '2026-08-01'
    );
    expect(document.querySelector<HTMLInputElement>('input[name="to"]')?.value).toBe('2026-08-30');
  });
});
