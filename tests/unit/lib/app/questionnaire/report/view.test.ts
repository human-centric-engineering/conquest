/**
 * Respondent Report client view — unit tests.
 *
 * @see lib/app/questionnaire/report/view.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appRespondentReport: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  buildAdminReportMethodView,
  buildRespondentReportClientView,
} from '@/lib/app/questionnaire/report/view';
import {
  MethodRecorder,
  REPORT_METHOD_SCHEMA_VERSION,
} from '@/lib/app/questionnaire/report/method-record';

type Mock = ReturnType<typeof vi.fn>;

/**
 * A session row shaped like the report view's `findUnique` select. `overrides` patches the
 * header-source fields (status/publicRef/version/demoClient/events/…) for the header tests;
 * the defaults describe a completed, anonymous-off session with no attributed logo.
 */
function session(
  respondentReport: unknown,
  report?: unknown,
  title = 'Pulse',
  overrides: Record<string, unknown> = {}
) {
  return {
    status: 'completed',
    respondentUserId: null,
    publicRef: 'EEQMC0ES',
    updatedAt: new Date('2026-07-03T10:00:00Z'),
    version: {
      versionNumber: 1,
      goal: 'Help leaders reflect on their time.',
      audience: { description: 'Leaders conducting a self-audit.' },
      config: { respondentReport, anonymousMode: false },
      questionnaire: {
        title,
        demoClient: { ctaColor: null, accentColor: '#2563eb', logoUrl: null, welcomeCopy: null },
      },
    },
    respondentReport: report ?? null,
    events: [{ createdAt: new Date('2026-07-03T10:00:00Z') }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildRespondentReportClientView', () => {
  it('returns null when the session does not exist', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    await expect(buildRespondentReportClientView('s1')).resolves.toBeNull();
  });

  it('carries no insights for raw mode', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw' })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.enabled).toBe(true);
    expect(view?.mode).toBe('raw');
    expect(view?.insights).toBeNull();
    // Default include-data config: the Q&A recap on, the data-slot appendix off.
    expect(view?.includeData).toEqual({ questions: true, dataSlots: false });
  });

  it('surfaces the include-questionnaire-data config (rawIncludes) for the on-screen appendix', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({
        enabled: true,
        mode: 'narrative',
        rawIncludes: { questionsAsPresented: false, dataSlots: true },
      })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.includeData).toEqual({ questions: false, dataSlots: true });
  });

  it('never appends the Q&A recap to a narrative report, even when the stored flag is true', async () => {
    // Guards the no-backfill fix: versions configured as narrative before F10.6 carry the default
    // `questionsAsPresented: true`, which must NOT start surfacing a Q&A recap under the woven prose.
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({
        enabled: true,
        mode: 'narrative',
        rawIncludes: { questionsAsPresented: true, dataSlots: false },
      })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.includeData.questions).toBe(false);
  });

  it('exposes the insights object for narrative mode (an AI mode)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative' },
        {
          status: 'ready',
          content: { summary: 'Your story.', sections: [], actions: ['Do X'] },
          formatted: true,
          completionPct: 45,
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
    // Completion % is surfaced so the renderers can show the partial-report caveat.
    expect(view?.insights?.completionPct).toBe(45);
  });

  it('defaults formatted/completionPct for a row that predates them (null columns)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'raw_plus_insights' },
        {
          status: 'ready',
          content: { summary: 'Legacy.', sections: [], actions: [] },
          formatted: null,
          completionPct: null,
          generatedAt: new Date('2026-06-19T12:00:00Z'),
          error: null,
        }
      )
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.insights?.formatted).toBe(false);
    // Null completion → null (no caveat), never coerced to 0 (which would read as "0% complete").
    expect(view?.insights?.completionPct).toBeNull();
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

  // --- Branded header (drives the on-screen A4 preview's masthead; mirrors the PDF) ---

  it('carries no header for a raw / non-AI mode (no preview to brand)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw' })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.header).toBeNull();
  });

  it('assembles the branded header (version, ref, goal, audience, accent, completed) for an AI mode', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'narrative' }, { status: 'ready', content: null, error: null })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.header).toEqual({
      logoUrl: null,
      accentColor: '#2563eb',
      versionNumber: 1,
      ref: 'EEQMC0ES',
      goal: 'Help leaders reflect on their time.',
      audienceSummary: 'Leaders conducting a self-audit.',
      // No respondent identity (respondentUserId null) → anonymous label.
      respondentLabel: 'Anonymous respondent',
      completedAt: '2026-07-03T10:00:00.000Z',
    });
  });

  it('surfaces the demo-client logo in the header when one is configured', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'narrative' }, { status: 'ready', content: null }, 'Pulse', {
        version: {
          versionNumber: 2,
          goal: null,
          audience: null,
          config: { respondentReport: { enabled: true, mode: 'narrative' }, anonymousMode: false },
          questionnaire: {
            title: 'Pulse',
            demoClient: {
              ctaColor: null,
              accentColor: '#111827',
              logoUrl: 'https://cdn.example.com/logo.png',
              welcomeCopy: null,
            },
          },
        },
      })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.header?.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(view?.header?.accentColor).toBe('#111827');
  });

  it('resolves the respondent name for a non-anonymous session (identity looked up)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'narrative' }, { status: 'ready', content: null }, 'Pulse', {
        respondentUserId: 'u1',
      })
    );
    (prisma.user.findUnique as Mock).mockResolvedValue({ name: 'John Durrant' });
    const view = await buildRespondentReportClientView('s1');
    expect(view?.header?.respondentLabel).toBe('John Durrant');
    expect(prisma.user.findUnique).toHaveBeenCalledOnce();
  });

  it('never queries identity in anonymous mode — labels "Anonymous respondent"', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'narrative' }, { status: 'ready', content: null }, 'Pulse', {
        respondentUserId: 'u1',
        version: {
          versionNumber: 1,
          goal: null,
          audience: null,
          config: { respondentReport: { enabled: true, mode: 'narrative' }, anonymousMode: true },
          questionnaire: {
            title: 'Pulse',
            demoClient: {
              ctaColor: null,
              accentColor: '#2563eb',
              logoUrl: null,
              welcomeCopy: null,
            },
          },
        },
      })
    );
    const view = await buildRespondentReportClientView('s1');
    expect(view?.header?.respondentLabel).toBe('Anonymous respondent');
    // Anonymous mode must not touch the identity table.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

/* ── Method record ("How this report was created") ───────────────────────── */

/** A stored record, JSON round-tripped exactly as the Json column would return it. */
function storedMethodRecord() {
  const rec = new MethodRecorder('narrative', false, () => 0);
  rec.recordAnswers({
    answered: 3,
    total: 4,
    completionPct: 75,
    unansweredListed: 1,
    confidenceWeighted: true,
    usedDataSlots: false,
  });
  rec.recordPass('coverageFence', true);
  rec.recordModel({ provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' });
  return JSON.parse(JSON.stringify(rec.build()));
}

const AI_REPORT = { status: 'ready', content: null, formatted: false, completionPct: 75 };

describe('buildRespondentReportClientView — method panel', () => {
  it('offers the panel when the version opted in and the run recorded a record', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative', delivery: { explainMethod: true } },
        { ...AI_REPORT, methodRecord: storedMethodRecord() }
      )
    );
    const view = await buildRespondentReportClientView('s1');

    expect(view?.method).not.toBeNull();
    expect(view?.method?.facts.find((f) => f.key === 'answers')?.value).toBe('3 of 4');
    // Respondent projection — operational detail is absent, not merely hidden.
    expect(view?.method?.admin).toBeUndefined();
  });

  it('withholds the panel when the version did not opt in, even with a record present', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative', delivery: { explainMethod: false } },
        { ...AI_REPORT, methodRecord: storedMethodRecord() }
      )
    );
    expect((await buildRespondentReportClientView('s1'))?.method).toBeNull();
  });

  it('withholds the panel for a report generated before method capture existed', async () => {
    // No backfill: rather than reconstructing a run nobody observed, the link is simply not offered.
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative', delivery: { explainMethod: true } },
        { ...AI_REPORT, methodRecord: null }
      )
    );
    expect((await buildRespondentReportClientView('s1'))?.method).toBeNull();
  });

  it('withholds the panel when the stored record is from a different schema version', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session(
        { enabled: true, mode: 'narrative', delivery: { explainMethod: true } },
        {
          ...AI_REPORT,
          methodRecord: {
            ...storedMethodRecord(),
            schemaVersion: REPORT_METHOD_SCHEMA_VERSION + 1,
          },
        }
      )
    );
    expect((await buildRespondentReportClientView('s1'))?.method).toBeNull();
  });

  it('carries a null method for a disabled or raw-mode report', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      session({ enabled: true, mode: 'raw', delivery: { explainMethod: true } })
    );
    expect((await buildRespondentReportClientView('s1'))?.method).toBeNull();
  });
});

describe('buildAdminReportMethodView', () => {
  it('returns the admin projection, including operational detail', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      methodRecord: storedMethodRecord(),
    });
    const view = await buildAdminReportMethodView('s1');

    expect(view?.admin?.model).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
      tier: 'reasoning',
    });
    expect(view?.admin?.summarySource).toBe('template');
  });

  it('is NOT gated on the respondent-facing explainMethod setting', async () => {
    // The loader never reads the config: an operator sees how a report was made whether or not the
    // respondent was shown the same panel — indeed it matters most when they were not.
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      methodRecord: storedMethodRecord(),
    });
    expect(await buildAdminReportMethodView('s1')).not.toBeNull();
    expect(prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the report or its record is absent', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue(null);
    expect(await buildAdminReportMethodView('s1')).toBeNull();

    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({ methodRecord: null });
    expect(await buildAdminReportMethodView('s1')).toBeNull();
  });
});
