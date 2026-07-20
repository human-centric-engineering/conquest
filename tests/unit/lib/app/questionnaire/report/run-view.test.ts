/**
 * buildRunReportClientView (F15.4b) — the run report's respondent-facing read view.
 *
 * The focus here is the METHOD PANEL gate. It is the one part of the view that must not simply
 * follow the base (entry-leg) view: a leg has no report row of its own, so anything derived from
 * the base view's method panel is dead. The gate is read from the author's `explainMethod` setting
 * instead — and it must stay exactly as closed as before.
 *
 * @see lib/app/questionnaire/report/run-view.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRun: { findUnique: vi.fn() },
    appQuestionnaireSession: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const viewMock = vi.hoisted(() => ({ buildRespondentReportClientView: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/view', () => viewMock);

const contentMock = vi.hoisted(() => ({ validateRespondentReportContent: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/content', () => contentMock);

const methodViewMock = vi.hoisted(() => ({ buildReportMethodView: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/method-view', () => methodViewMock);

import { buildRunReportClientView } from '@/lib/app/questionnaire/report/run-view';

const RUN_ID = 'run_1';

/** A method record in the shape `narrowMethodRecord` accepts (it is NOT mocked — real narrowing). */
const METHOD_RECORD = {
  schemaVersion: 1,
  mode: 'narrative',
  generatedAt: '2026-07-01T00:00:00.000Z',
};

/**
 * The base (entry-leg) view. `method` is null here on purpose — that is the production reality, and
 * the bug this file guards was gating the run's panel on exactly this value.
 */
function baseView() {
  return {
    enabled: true,
    mode: 'narrative',
    onScreen: true,
    download: true,
    questionnaireTitle: 'Opening',
    includeData: {},
    header: { logoUrl: null, accentColor: '#000', versionNumber: 1 },
    method: null,
    insights: {
      status: 'ready',
      started: true,
      content: null,
      formatted: false,
      completionPct: null,
      generatedAt: null,
      error: null,
      notifyRequested: false,
    },
  };
}

/** Set the entry leg's stored `explainMethod` opt-in. */
function setExplainMethod(explainMethod: boolean) {
  prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    version: {
      config: {
        respondentReport: { enabled: true, mode: 'narrative', delivery: { explainMethod } },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
    legs: [{ sessionId: 'sess_entry' }],
    report: {
      status: 'ready',
      content: { summary: 'journey' },
      formatted: true,
      completionPct: 80,
      methodRecord: METHOD_RECORD,
      generatedAt: new Date('2026-07-02T00:00:00.000Z'),
      error: null,
      notifyEmail: 'you@example.com',
    },
  });
  viewMock.buildRespondentReportClientView.mockResolvedValue(baseView());
  contentMock.validateRespondentReportContent.mockImplementation((c: unknown) => c);
  methodViewMock.buildReportMethodView.mockReturnValue({ panel: 'METHOD' });
  setExplainMethod(true);
});

describe('buildRunReportClientView — the method panel', () => {
  it('renders the RUN’s own method record when the author opted in', async () => {
    const view = await buildRunReportClientView(RUN_ID);

    // Gating on `base.method` made this unreachable: a leg never gets its own report row, so the
    // base view's panel is always null and the run's record was dead code.
    expect(view?.method).toEqual({ panel: 'METHOD' });
    expect(methodViewMock.buildReportMethodView).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 1 }),
      'respondent'
    );
  });

  it('stays null when the author did NOT opt in, even though the record exists', async () => {
    setExplainMethod(false);

    const view = await buildRunReportClientView(RUN_ID);

    // The load-bearing half: a run report must not become a way around an author's opt-out.
    expect(view?.method).toBeNull();
    expect(methodViewMock.buildReportMethodView).not.toHaveBeenCalled();
  });

  it('stays null when `explainMethod` is simply absent from the config', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      version: { config: { respondentReport: { enabled: true, mode: 'narrative' } } },
    });

    const view = await buildRunReportClientView(RUN_ID);
    expect(view?.method).toBeNull();
  });

  it('reads the opt-in from the ENTRY leg — the leg whose config decided the settings', async () => {
    await buildRunReportClientView(RUN_ID);

    expect(prismaMock.prisma.appQuestionnaireSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess_entry' } })
    );
  });

  it('is null when opted in but the run has no method record yet', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
      legs: [{ sessionId: 'sess_entry' }],
      report: { status: 'queued', methodRecord: null },
    });

    const view = await buildRunReportClientView(RUN_ID);
    expect(view?.method).toBeNull();
  });

  it('is null when opted in but the stored record is malformed', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
      legs: [{ sessionId: 'sess_entry' }],
      report: { status: 'ready', methodRecord: { nonsense: true } },
    });

    const view = await buildRunReportClientView(RUN_ID);
    expect(view?.method).toBeNull();
  });
});

describe('buildRunReportClientView — generation state', () => {
  it('swaps in the RUN’s generation state over the entry leg’s chrome', async () => {
    const view = await buildRunReportClientView(RUN_ID);

    expect(view?.questionnaireTitle).toBe('Opening');
    expect(view?.insights).toMatchObject({
      status: 'ready',
      started: true,
      formatted: true,
      completionPct: 80,
      notifyRequested: true,
      generatedAt: '2026-07-02T00:00:00.000Z',
    });
  });

  it('returns null when the run does not exist', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue(null);
    expect(await buildRunReportClientView(RUN_ID)).toBeNull();
  });

  it('returns null when the run has no legs — no chrome to present with', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({ legs: [], report: null });
    expect(await buildRunReportClientView(RUN_ID)).toBeNull();
  });

  it('passes a raw/disabled questionnaire’s chrome through untouched, no settings read', async () => {
    viewMock.buildRespondentReportClientView.mockResolvedValue({
      ...baseView(),
      insights: null,
    });

    const view = await buildRunReportClientView(RUN_ID);

    expect(view?.insights).toBeNull();
    // The entry-leg settings read is skipped entirely — there is no panel to gate.
    expect(prismaMock.prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });
});
