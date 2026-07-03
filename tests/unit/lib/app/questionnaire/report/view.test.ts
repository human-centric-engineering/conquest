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

function session(respondentReport: unknown, report?: unknown, title = 'Pulse') {
  return {
    version: { config: { respondentReport }, questionnaire: { title } },
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

  it('exposes the insights object for narrative mode (an AI mode)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative' },
        {
          status: 'ready',
          content: { summary: 'Your story.', sections: [], actions: ['Do X'] },
          formatted: true,
          generatedAt: new Date('2026-06-19T12:00:00Z'),
          error: null,
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.mode).toBe('narrative');
    expect(view?.insights?.status).toBe('ready');
    expect(view?.insights?.content).toEqual({
      summary: 'Your story.',
      sections: [],
      actions: ['Do X'],
    });
    // The formatter flag is surfaced so the renderers know to trust the laid-out prose.
    expect(view?.insights?.formatted).toBe(true);
  });

  it('defaults formatted to false when the row predates the formatter (null column)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'raw_plus_insights' },
        {
          status: 'ready',
          content: { summary: 'Legacy.', sections: [], actions: [] },
          formatted: null,
          generatedAt: new Date('2026-06-19T12:00:00Z'),
          error: null,
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.formatted).toBe(false);
  });

  it('reports queued insights when enabled in mode 2 with no row yet', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw_plus_insights' }, null)
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.status).toBe('queued');
    expect(view?.insights?.content).toBeNull();
    // No row yet → not started, and no notify requested.
    expect(view?.insights?.started).toBe(false);
    expect(view?.insights?.notifyRequested).toBe(false);
  });

  it('marks started true (and notifyRequested) from an existing row', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'raw_plus_insights' },
        {
          status: 'processing',
          content: null,
          generatedAt: null,
          error: null,
          notifyEmail: 'you@example.com',
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.started).toBe(true);
    expect(view?.insights?.notifyRequested).toBe(true);
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

  it('carries the questionnaire title (so the completion screen can name the download)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw' }, null, 'Merlin5 Alpha Demo')
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.questionnaireTitle).toBe('Merlin5 Alpha Demo');
  });

  it('falls back to a generic title when the questionnaire title is absent', async () => {
    // Defends the `?? 'questionnaire'` fallback so the download name never becomes "null.pdf".
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: {
        config: { respondentReport: { enabled: true, mode: 'raw' } },
        questionnaire: null,
      },
      respondentReport: null,
    });
    const view = await buildRespondentReportClientView('s1');
    expect(view?.questionnaireTitle).toBe('questionnaire');
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
