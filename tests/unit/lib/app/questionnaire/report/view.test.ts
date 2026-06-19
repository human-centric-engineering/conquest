/**
 * Respondent Report client view — unit tests.
 *
 * @see lib/app/questionnaire/report/view.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));

import { isFeatureEnabled } from '@/lib/feature-flags';
import { prisma } from '@/lib/db/client';
import { buildRespondentReportClientView } from '@/lib/app/questionnaire/report/view';

type Mock = ReturnType<typeof vi.fn>;

function session(respondentReport: unknown, report?: unknown) {
  return {
    version: { config: { respondentReport } },
    respondentReport: report ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
});

describe('buildRespondentReportClientView', () => {
  it('returns null when the session does not exist', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    await expect(buildRespondentReportClientView('s1')).resolves.toBeNull();
  });

  it('reports disabled when the platform flag is off, even if config is enabled', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw_plus_insights' })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.enabled).toBe(false);
    expect(view?.insights).toBeNull();
  });

  it('reports disabled when only the respondent-report sub-flag is off (master on)', async () => {
    (isFeatureEnabled as unknown as Mock)
      .mockResolvedValueOnce(true) // master
      .mockResolvedValueOnce(false); // sub-flag
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw_plus_insights' })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.enabled).toBe(false);
    expect(view?.insights).toBeNull();
  });

  it('carries no insights for raw mode', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw' })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.enabled).toBe(true);
    expect(view?.mode).toBe('raw');
    expect(view?.insights).toBeNull();
  });

  it('reports queued insights when enabled in mode 2 with no row yet', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw_plus_insights' }, null)
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.status).toBe('queued');
    expect(view?.insights?.content).toBeNull();
  });

  it('returns the ready content + generatedAt from the report row', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'raw_plus_insights' },
        {
          status: 'ready',
          content: { summary: 'Nice work.', sections: [], actions: ['Do X'] },
          generatedAt: new Date('2026-06-19T12:00:00Z'),
          error: null,
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.status).toBe('ready');
    expect(view?.insights?.content).toEqual({
      summary: 'Nice work.',
      sections: [],
      actions: ['Do X'],
    });
    expect(view?.insights?.generatedAt).toBe('2026-06-19T12:00:00.000Z');
  });

  it('surfaces a failed report with its error and null content', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'raw_plus_insights' },
        {
          status: 'failed',
          content: null,
          generatedAt: null,
          error: 'no provider',
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.status).toBe('failed');
    expect(view?.insights?.error).toBe('no provider');
    expect(view?.insights?.content).toBeNull();
  });

  it('reflects the delivery toggles', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({
        enabled: true,
        mode: 'raw',
        delivery: { onScreen: false, download: true },
      })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.onScreen).toBe(false);
    expect(view?.download).toBe(true);
  });
});
