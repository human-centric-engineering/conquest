/**
 * generateRunReport (F15.4b) — assembling a whole journey's inputs.
 *
 * The design claim under test: this module assembles INPUTS and reuses the existing generation
 * core untouched. So the assertions are about what reaches `generateReportFromInputs`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRun: { findUnique: vi.fn() },
    appQuestionnaireSession: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const exportMock = vi.hoisted(() => ({ loadSessionExport: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => exportMock);

const panelMock = vi.hoisted(() => ({ buildAnswerPanelView: vi.fn() }));
vi.mock('@/lib/app/questionnaire/panel/answer-panel', () => panelMock);

const contentMock = vi.hoisted(() => ({
  buildAnswerTranscript: vi.fn(),
  buildDataSlotContextBlock: vi.fn(),
  buildUnansweredQuestionsBlock: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/content', () => contentMock);

const generateMock = vi.hoisted(() => ({ generateReportFromInputs: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/generate', () => generateMock);

import { generateRunReport } from '@/lib/app/questionnaire/report/run-report';

const RUN_ID = 'run_1';

/** Two legs, each with its own questionnaire and answers. */
function twoLegRun() {
  return {
    id: RUN_ID,
    experience: { title: 'Onboarding', demoClientId: 'client_1' },
    legs: [
      { sessionId: 'sess_a', ordinal: 0 },
      { sessionId: 'sess_b', ordinal: 1 },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue(twoLegRun());
  prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    version: { config: { respondentReport: { enabled: true, mode: 'narrative' } } },
  });
  exportMock.loadSessionExport.mockImplementation((sessionId: string) =>
    Promise.resolve({
      status: 'completed',
      sections: [],
      answers: [],
      dataSlotGroups: [],
      questionnaireTitle: sessionId === 'sess_a' ? 'Opening' : 'Deep dive',
      goal: sessionId === 'sess_a' ? 'understand the team' : 'go deeper',
      audience: {},
      notAssessed: [],
      assessedTopicLabels: [],
    })
  );
  panelMock.buildAnswerPanelView.mockReturnValue({
    sections: [],
    answeredCount: 3,
    totalCount: 5,
  });
  contentMock.buildAnswerTranscript.mockImplementation(
    (input: { questionnaireTitle: string }) => `TRANSCRIPT:${input.questionnaireTitle}`
  );
  contentMock.buildDataSlotContextBlock.mockReturnValue('SLOTS');
  contentMock.buildUnansweredQuestionsBlock.mockReturnValue('UNANSWERED');
  generateMock.generateReportFromInputs.mockResolvedValue({
    content: {},
    costUsd: 1,
    formatted: true,
    completionPct: 60,
    methodRecord: null,
  });
});

/** The inputs handed to the generation core. */
function inputs() {
  return generateMock.generateReportFromInputs.mock.calls[0][0];
}

describe('generateRunReport', () => {
  it('reuses the existing generation core rather than forking a pipeline', async () => {
    await generateRunReport(RUN_ID);
    expect(generateMock.generateReportFromInputs).toHaveBeenCalledTimes(1);
  });

  it('joins every leg into one transcript, under headed parts', async () => {
    await generateRunReport(RUN_ID);

    const { transcript } = inputs();
    expect(transcript).toContain('TRANSCRIPT:Opening');
    expect(transcript).toContain('TRANSCRIPT:Deep dive');
    // The headings are what let the writer see the respondent was asked about a topic TWICE, in
    // two questionnaires — a progression a flat wall of Q&A hides.
    expect(transcript).toContain('## Part 1 — Opening');
    expect(transcript).toContain('## Part 2 — Deep dive');
  });

  it('orders parts by leg ordinal', async () => {
    await generateRunReport(RUN_ID);
    const { transcript } = inputs();
    expect(transcript.indexOf('## Part 1')).toBeLessThan(transcript.indexOf('## Part 2'));
  });

  it('sums coverage across the WHOLE journey', async () => {
    await generateRunReport(RUN_ID);

    // 3 of 5 per leg, two legs → 6 of 10. Reporting the final leg's completion alone would
    // overstate how much of the journey was answered.
    const { coverage, completionPct } = inputs();
    expect(coverage).toMatchObject({ answered: 6, total: 10 });
    expect(completionPct).toBe(60);
  });

  it('takes the KB scope from the EXPERIENCE, not an arbitrary leg', async () => {
    await generateRunReport(RUN_ID);
    expect(inputs().demoClientId).toBe('client_1');
  });

  it('frames the report with the entry leg’s goal', async () => {
    await generateRunReport(RUN_ID);
    expect(inputs().goal).toBe('understand the team');
  });

  it('passes a run sentinel, never a real session id', async () => {
    await generateRunReport(RUN_ID);
    // Used only for research logging and KB warnings — never as a lookup key. Passing a leg's id
    // would attribute the run's research to one arbitrary session.
    expect(inputs().sessionId).toBe(`run:${RUN_ID}`);
  });

  it('reads settings from the entry leg’s version config', async () => {
    await generateRunReport(RUN_ID);
    expect(prismaMock.prisma.appQuestionnaireSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess_a' } })
    );
  });

  it('skips a leg whose export cannot be loaded rather than failing the report', async () => {
    exportMock.loadSessionExport.mockImplementation((sessionId: string) =>
      sessionId === 'sess_b'
        ? Promise.resolve(null)
        : Promise.resolve({
            status: 'completed',
            sections: [],
            answers: [],
            dataSlotGroups: [],
            questionnaireTitle: 'Opening',
            goal: 'g',
            audience: {},
          })
    );

    await generateRunReport(RUN_ID);

    const { transcript, coverage } = inputs();
    expect(transcript).toContain('## Part 1 — Opening');
    expect(transcript).not.toContain('Part 2');
    // Coverage reflects only what was actually readable.
    expect(coverage).toMatchObject({ answered: 3, total: 5 });
  });

  /**
   * Conditional Topics (P17) across a journey. The per-leg transcripts are already narrowed to the
   * questions each leg actually asked, so this block adds no material — it tells the writer WHY an
   * area is absent, which is what stops the report reading a deliberately-skipped area as a
   * respondent who declined, or telling them to go and "complete" something they were told did not
   * apply to them.
   */
  describe('not-assessed topics', () => {
    /** Give each leg its own Conditional Topics record. */
    function legScopes(
      byLeg: Record<string, { notAssessed?: unknown[]; assessedTopicLabels?: string[] }>
    ) {
      exportMock.loadSessionExport.mockImplementation((sessionId: string) =>
        Promise.resolve({
          status: 'completed',
          sections: [],
          answers: [],
          dataSlotGroups: [],
          questionnaireTitle: sessionId === 'sess_a' ? 'Opening' : 'Deep dive',
          goal: 'g',
          audience: {},
          notAssessed: byLeg[sessionId]?.notAssessed ?? [],
          assessedTopicLabels: byLeg[sessionId]?.assessedTopicLabels ?? [],
        })
      );
    }

    const PRICING = { key: 'pricing', label: 'Pricing', questionCount: 4, partial: false };

    it('carries a leg’s skipped topics through to the generation core', async () => {
      legScopes({ sess_b: { notAssessed: [PRICING] } });
      await generateRunReport(RUN_ID);
      expect(inputs().notAssessed).toEqual([PRICING]);
    });

    it('omits the key entirely when no leg skipped anything', async () => {
      await generateRunReport(RUN_ID);
      // Absent, not an empty array: `generateReportFromInputs` gates the whole prompt section on
      // presence, and a non-adaptive journey must produce exactly the prompt it did before P17.
      expect(inputs()).not.toHaveProperty('notAssessed');
    });

    it('sums the question count when both legs skipped the same area', async () => {
      legScopes({
        sess_a: { notAssessed: [PRICING] },
        sess_b: { notAssessed: [{ ...PRICING, key: 'price', questionCount: 3 }] },
      });
      await generateRunReport(RUN_ID);
      // Matched by LABEL — keys are version-scoped, so two legs describing the same area rarely
      // share one.
      expect(inputs().notAssessed).toEqual([{ ...PRICING, questionCount: 7 }]);
    });

    it('matches labels regardless of case and surrounding space', async () => {
      legScopes({
        sess_a: { notAssessed: [PRICING] },
        sess_b: { notAssessed: [{ ...PRICING, label: '  pricing ', questionCount: 1 }] },
      });
      await generateRunReport(RUN_ID);
      expect(inputs().notAssessed).toEqual([{ ...PRICING, questionCount: 5 }]);
    });

    it('drops a topic another leg assessed in full', async () => {
      legScopes({
        sess_a: { assessedTopicLabels: ['Pricing'] },
        sess_b: { notAssessed: [PRICING] },
      });
      await generateRunReport(RUN_ID);
      // The prompt's fence reads "you know nothing whatsoever about this respondent in these areas
      // — do not write about them". Applying that to an area Part 1 measured properly would
      // suppress the journey's best material and contradict its own transcript.
      expect(inputs()).not.toHaveProperty('notAssessed');
    });

    it('drops it whichever leg assessed it — order must not decide', async () => {
      legScopes({
        sess_a: { notAssessed: [PRICING] },
        sess_b: { assessedTopicLabels: ['Pricing'] },
      });
      await generateRunReport(RUN_ID);
      expect(inputs()).not.toHaveProperty('notAssessed');
    });

    it('treats an area as sampled when any leg sampled it', async () => {
      legScopes({
        sess_a: { notAssessed: [{ ...PRICING, partial: true, questionCount: 2 }] },
        sess_b: { notAssessed: [PRICING] },
      });
      await generateRunReport(RUN_ID);
      // Part 1 DID put some pricing questions to them and their answers are in the transcript.
      // Calling the area never-asked would be false; sampled is the honest description.
      expect(inputs().notAssessed).toEqual([{ ...PRICING, partial: true, questionCount: 6 }]);
    });

    it('keeps distinct areas apart, in journey order', async () => {
      legScopes({
        sess_a: { notAssessed: [{ ...PRICING, label: 'Talent', key: 'talent' }] },
        sess_b: { notAssessed: [PRICING] },
      });
      await generateRunReport(RUN_ID);
      expect(inputs().notAssessed.map((t: { label: string }) => t.label)).toEqual([
        'Talent',
        'Pricing',
      ]);
    });

    it('ignores a leg whose export could not be read', async () => {
      exportMock.loadSessionExport.mockImplementation((sessionId: string) =>
        sessionId === 'sess_b'
          ? Promise.resolve(null)
          : Promise.resolve({
              status: 'completed',
              sections: [],
              answers: [],
              dataSlotGroups: [],
              questionnaireTitle: 'Opening',
              goal: 'g',
              audience: {},
              notAssessed: [PRICING],
              assessedTopicLabels: [],
            })
      );
      await generateRunReport(RUN_ID);
      expect(inputs().notAssessed).toEqual([PRICING]);
    });
  });

  it('throws when the run is unknown', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue(null);
    await expect(generateRunReport(RUN_ID)).rejects.toThrow(/not found/i);
  });

  it('throws when the run has no legs', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
      ...twoLegRun(),
      legs: [],
    });
    await expect(generateRunReport(RUN_ID)).rejects.toThrow(/no legs/i);
  });

  it('throws when no leg has loadable answers — the worker marks it failed', async () => {
    exportMock.loadSessionExport.mockResolvedValue(null);
    await expect(generateRunReport(RUN_ID)).rejects.toThrow(/no legs with loadable answers/i);
  });
});
