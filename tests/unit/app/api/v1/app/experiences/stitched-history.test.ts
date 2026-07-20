/**
 * loadStitchedHistory (P15.3) — the earlier legs replayed above the live conversation.
 *
 * The ordinal filter is the load-bearing part: it is what makes this a read of the respondent's
 * OWN past rather than a window onto the whole run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRunLeg: { findMany: vi.fn(), findUnique: vi.fn() },
    appExperienceStep: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const transcriptMock = vi.hoisted(() => ({ loadTranscript: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript', () => transcriptMock);

import { loadStitchedHistory } from '@/app/api/v1/app/experiences/_lib/run-read';

const RUN_ID = 'run_1';

const LEGS = [
  { ordinal: 0, stepId: 'step_intro', sessionId: 'sess_0' },
  { ordinal: 1, stepId: 'step_depth', sessionId: 'sess_1' },
  { ordinal: 2, stepId: 'step_final', sessionId: 'sess_2' },
];

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.appExperienceRunLeg.findMany.mockResolvedValue(LEGS);
  prismaMock.prisma.appExperienceStep.findMany.mockResolvedValue([
    { id: 'step_intro', title: 'Getting to know you' },
    { id: 'step_depth', title: 'Team depth' },
  ]);
  transcriptMock.loadTranscript.mockImplementation((sessionId: string) =>
    Promise.resolve([{ role: 'assistant', content: `turn from ${sessionId}` }])
  );
});

describe('loadStitchedHistory', () => {
  it('returns only legs BEFORE the current one, oldest first', async () => {
    const history = await loadStitchedHistory(RUN_ID, 'sess_2');

    expect(history.segments).toHaveLength(2);
    expect(history.segments[0].stepTitle).toBe('Getting to know you');
    expect(history.segments[1].stepTitle).toBe('Team depth');
    // The current leg is rendered live by the workspace; replaying it here would double it.
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalledWith('sess_2');
  });

  it('never returns a LATER leg — the caller only ever sees their own past', async () => {
    const history = await loadStitchedHistory(RUN_ID, 'sess_1');

    expect(history.segments).toHaveLength(1);
    expect(history.segments[0].stepTitle).toBe('Getting to know you');
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalledWith('sess_2');
  });

  it('is empty for the entry leg — nothing precedes it', async () => {
    const history = await loadStitchedHistory(RUN_ID, 'sess_0');

    expect(history.segments).toEqual([]);
    // Not a single transcript read for the common case.
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('is empty for a session that is not part of this run (fails closed)', async () => {
    const history = await loadStitchedHistory(RUN_ID, 'sess_stranger');

    // Returning everything would be the dangerous failure; returning nothing is the safe one.
    expect(history.segments).toEqual([]);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('renders a dangling step pointer as a null title rather than throwing', async () => {
    // `stepId` is unmodelled (UG-1), so a step deleted after the run took it is expected, not
    // exceptional. The divider falls back to generic copy.
    prismaMock.prisma.appExperienceStep.findMany.mockResolvedValue([]);

    const history = await loadStitchedHistory(RUN_ID, 'sess_2');
    expect(history.segments.map((s) => s.stepTitle)).toEqual([null, null]);
    expect(history.segments).toHaveLength(2);
  });

  it('carries each leg’s replayed turns', async () => {
    const history = await loadStitchedHistory(RUN_ID, 'sess_2');
    expect(history.segments[0].turns).toEqual([{ role: 'assistant', content: 'turn from sess_0' }]);
    expect(history.segments[1].turns).toEqual([{ role: 'assistant', content: 'turn from sess_1' }]);
  });

  it('resolves step titles in ONE batched query, never per leg', async () => {
    await loadStitchedHistory(RUN_ID, 'sess_2');
    expect(prismaMock.prisma.appExperienceStep.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.prisma.appExperienceStep.findUnique).not.toHaveBeenCalled();
  });
});
