/**
 * Unit test: admin "re-run report" read seam (`loadAdminReportRerunPanel`).
 *
 * Prisma is mocked; the real `narrowRespondentReportSettings` runs. Pins the three things the session
 * viewer's re-run panel depends on: it seeds from the version's report config, derives `hasClient` from
 * the questionnaire's `demoClientId`, and stays forgiving when the version/config is absent (narrowing
 * to report defaults rather than throwing).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireVersion: { findUnique: vi.fn() },
  },
  getRespondentReportRevisionsView: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/app/questionnaire/report/revision', () => ({
  getRespondentReportRevisionsView: mocks.getRespondentReportRevisionsView,
}));

import { loadAdminReportRerunPanel } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-report-rerun-view';

type Mock = ReturnType<typeof vi.fn>;
const findVersion = mocks.prisma.appQuestionnaireVersion.findUnique as Mock;
const getView = mocks.getRespondentReportRevisionsView as Mock;

const EMPTY_VIEW = { delivered: null, revisions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getView.mockResolvedValue(EMPTY_VIEW);
});

describe('loadAdminReportRerunPanel', () => {
  it('seeds settings from the version report config and derives hasClient from demoClientId', async () => {
    findVersion.mockResolvedValue({
      config: { respondentReport: { mode: 'narrative' } },
      questionnaire: { demoClientId: 'client-1' },
    });

    const panel = await loadAdminReportRerunPanel('v-1', 'sess-1');

    expect(findVersion).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      select: {
        config: { select: { respondentReport: true } },
        questionnaire: { select: { demoClientId: true } },
      },
    });
    expect(panel.settings.mode).toBe('narrative');
    expect(panel.hasClient).toBe(true);
    expect(panel.initialView).toBe(EMPTY_VIEW);
    expect(getView).toHaveBeenCalledWith('sess-1');
  });

  it('reports hasClient=false when the questionnaire has no attributed client', async () => {
    findVersion.mockResolvedValue({
      config: { respondentReport: { mode: 'raw_plus_insights' } },
      questionnaire: { demoClientId: null },
    });

    const panel = await loadAdminReportRerunPanel('v-1', 'sess-1');

    expect(panel.hasClient).toBe(false);
    expect(panel.settings.mode).toBe('raw_plus_insights');
  });

  it('narrows to report defaults (no throw) when the version does not exist', async () => {
    findVersion.mockResolvedValue(null);

    const panel = await loadAdminReportRerunPanel('missing', 'sess-1');

    // narrowRespondentReportSettings runs for real; the default mode is the narrative report.
    expect(panel.settings.mode).toBe('narrative');
    expect(panel.hasClient).toBe(false);
    expect(panel.initialView).toBe(EMPTY_VIEW);
  });

  it('narrows to report defaults when the version has no report config', async () => {
    findVersion.mockResolvedValue({
      config: { respondentReport: null },
      questionnaire: { demoClientId: 'client-1' },
    });

    const panel = await loadAdminReportRerunPanel('v-1', 'sess-1');

    expect(panel.settings.mode).toBe('narrative');
    expect(panel.hasClient).toBe(true);
  });
});
