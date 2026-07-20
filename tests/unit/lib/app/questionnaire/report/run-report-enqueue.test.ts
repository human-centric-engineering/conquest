/**
 * Run-report enqueue + leg detection (F15.4b).
 *
 * Two behaviours that together decide how many reports a journey produces: a leg produces none,
 * and a concluded run produces exactly one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRunLeg: { findFirst: vi.fn(), findUnique: vi.fn() },
    appQuestionnaireSession: { findUnique: vi.fn() },
    appRespondentReport: { upsert: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

import { enqueueRunReport, isExperienceLeg } from '@/lib/app/questionnaire/report/enqueue';

const RUN_ID = 'run_1';
const ENTRY_SESSION = 'sess_entry';

/** A version config with the report enabled in an AI mode. */
function enabledConfig() {
  return {
    version: { config: { respondentReport: { enabled: true, mode: 'narrative' } } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.appExperienceRunLeg.findFirst.mockResolvedValue({ sessionId: ENTRY_SESSION });
  prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(enabledConfig());
  prismaMock.prisma.appRespondentReport.upsert.mockResolvedValue({});
});

describe('enqueueRunReport', () => {
  it('queues a run-scoped report keyed on the run', async () => {
    expect(await enqueueRunReport(RUN_ID)).toBe(true);

    expect(prismaMock.prisma.appRespondentReport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: RUN_ID },
        create: expect.objectContaining({
          runId: RUN_ID,
          subjectKind: 'experience_run',
          status: 'queued',
        }),
      })
    );
  });

  it('is idempotent — a concurrent advance must not reset an existing report', async () => {
    await enqueueRunReport(RUN_ID);
    // An empty `update` is what makes the upsert a no-op on the second call. Resetting status here
    // would discard a report that had already generated.
    const call = prismaMock.prisma.appRespondentReport.upsert.mock.calls[0][0];
    expect(call.update).toEqual({});
  });

  it('reads settings from the ENTRY leg, not the last', async () => {
    await enqueueRunReport(RUN_ID);

    // Anchoring on the last leg would give two respondents on the same experience differently
    // styled reports purely because the selector routed them differently.
    expect(prismaMock.prisma.appExperienceRunLeg.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: RUN_ID }, orderBy: { ordinal: 'asc' } })
    );
    expect(prismaMock.prisma.appQuestionnaireSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ENTRY_SESSION } })
    );
  });

  it('does not queue when the entry version has reports disabled', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      version: { config: { respondentReport: { enabled: false, mode: 'narrative' } } },
    });
    expect(await enqueueRunReport(RUN_ID)).toBe(false);
    expect(prismaMock.prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('does not queue for a raw-only mode — it renders on demand and needs no row', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      version: { config: { respondentReport: { enabled: true, mode: 'raw' } } },
    });
    expect(await enqueueRunReport(RUN_ID)).toBe(false);
    expect(prismaMock.prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('does not queue for a run with no legs', async () => {
    prismaMock.prisma.appExperienceRunLeg.findFirst.mockResolvedValue(null);
    expect(await enqueueRunReport(RUN_ID)).toBe(false);
    expect(prismaMock.prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });
});

describe('isExperienceLeg', () => {
  it('is true for a session that is a leg of a run', async () => {
    prismaMock.prisma.appExperienceRunLeg.findUnique.mockResolvedValue({ id: 'leg_1' });
    expect(await isExperienceLeg('sess_1')).toBe(true);
  });

  it('is false for an ordinary standalone session', async () => {
    prismaMock.prisma.appExperienceRunLeg.findUnique.mockResolvedValue(null);
    expect(await isExperienceLeg('sess_1')).toBe(false);
  });

  it('looks the leg up by the unique sessionId', async () => {
    prismaMock.prisma.appExperienceRunLeg.findUnique.mockResolvedValue(null);
    await isExperienceLeg('sess_1');
    expect(prismaMock.prisma.appExperienceRunLeg.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 'sess_1' } })
    );
  });
});
