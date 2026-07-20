/**
 * Unit tests: experience-wide synthesis material assembly (P15.8).
 *
 * `buildSynthesisMaterial` is the seam that decides WHAT the synthesiser gets to read. Three things
 * carry real weight and get the most coverage:
 *
 * 1. **The two kinds read genuinely different things.** A `facilitated_meeting` reads gated
 *    `AppExperienceInsight` rows; an `agentic_switcher` reads ready `AppCohortReport` revisions plus
 *    a routing distribution. Getting the branch wrong means reading the wrong table entirely.
 * 2. **The k-anonymity gate is re-applied on read, at the CURRENT `insightMinSupport`.** A finding
 *    that doesn't clear the floor must never reach a block, whatever the settings said when the
 *    insight was written.
 * 3. **Coverage is exhaustive and its ORDER is a real code path, not an artifact.** For the switcher
 *    branch, `no_questionnaire` steps are noted in one loop and every other outcome in a second,
 *    separate loop — so coverage order does not simply mirror step order. A test pins this because
 *    it is exactly the kind of thing that looks like a bug on first read of the array.
 *
 * Prisma and the logger are mocked; everything else (`applySupportGate`, `narrowExperienceSettings`,
 * `narrowToEnum`, `htmlToParagraphs`, `validateCohortReportContent`) is the real implementation, so
 * assertions below are checking genuine transformations — not mock echoes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appExperience: { findUnique: vi.fn() },
    appExperienceStep: { findMany: vi.fn() },
    appExperienceInsight: { findMany: vi.fn() },
    appCohortReport: { findMany: vi.fn() },
    appExperienceRun: { findMany: vi.fn() },
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));

import { buildSynthesisMaterial } from '@/lib/app/questionnaire/experiences/synthesis/material';

type Mock = ReturnType<typeof vi.fn>;
const findExperience = mocks.prisma.appExperience.findUnique as Mock;
const findSteps = mocks.prisma.appExperienceStep.findMany as Mock;
const findInsights = mocks.prisma.appExperienceInsight.findMany as Mock;
const findReports = mocks.prisma.appCohortReport.findMany as Mock;
const findRuns = mocks.prisma.appExperienceRun.findMany as Mock;

function experienceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    title: 'My Journey',
    kind: 'agentic_switcher',
    settings: {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findRuns.mockResolvedValue([]);
});

describe('buildSynthesisMaterial — experience lookup', () => {
  it('throws when the experience does not exist', async () => {
    findExperience.mockResolvedValue(null);
    await expect(buildSynthesisMaterial('missing')).rejects.toThrow('Experience not found');
  });
});

describe('buildSynthesisMaterial — facilitated_meeting', () => {
  const steps = [
    { id: 'step-entry', key: 'intake', title: 'Intake', kind: 'entry', questionnaireId: 'q1' },
    {
      id: 'step-breakout1',
      key: 'housing',
      title: 'Housing breakout',
      kind: 'breakout',
      questionnaireId: 'q2',
    },
    {
      id: 'step-breakout2',
      key: 'finance',
      title: 'Finance breakout',
      kind: 'breakout',
      questionnaireId: 'q3',
    },
    // A `branch` step exists on this experience but is NOT eligible for a meeting — only `entry`
    // and `breakout` are. If this leaked into `eligible`, it would show up in coverage/routing.
    {
      id: 'step-branch',
      key: 'branchy',
      title: 'A branch step',
      kind: 'branch',
      questionnaireId: 'q4',
    },
  ];

  beforeEach(() => {
    findExperience.mockResolvedValue(
      experienceRow({ kind: 'facilitated_meeting', settings: { insightMinSupport: 3 } })
    );
    findSteps.mockResolvedValue(steps);
  });

  it('excludes `branch` steps from eligibility — only entry/breakout can contribute to a meeting', async () => {
    findInsights.mockResolvedValue([]);
    const material = await buildSynthesisMaterial('exp-1');
    // Only 3 coverage entries, never one for step-branch.
    expect(material.coverage).toHaveLength(3);
    expect(material.coverage.map((c) => c.stepKey)).not.toContain('branchy');
  });

  it('gates insights at the CURRENT insightMinSupport, dropping a step whose only insight falls short', async () => {
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'agreement',
        statement: 'Most people like X',
        detail: null,
        supportCount: 4,
      },
      // supportCount 2 < insightMinSupport 3 — must be gated out entirely, not merely truncated.
      {
        stepId: 'step-breakout1',
        kind: 'tension',
        statement: 'Some disagree on Y',
        detail: 'extra detail',
        supportCount: 2,
      },
      {
        stepId: 'step-breakout2',
        kind: 'theme',
        statement: 'Z happened',
        detail: null,
        supportCount: 5,
      },
    ]);

    const material = await buildSynthesisMaterial('exp-1');

    // The gated-out step produced no block at all.
    expect(material.blocks.map((b) => b.stepKey)).toEqual(['intake', 'finance']);
    expect(material.blocks.some((b) => b.stepKey === 'housing')).toBe(false);

    // Coverage still records ALL three eligible steps, including the one with nothing to show —
    // a reader judging the synthesis needs to see what was missing.
    expect(material.coverage).toEqual([
      { stepKey: 'intake', stepTitle: 'Intake', included: true, reason: 'included' },
      { stepKey: 'housing', stepTitle: 'Housing breakout', included: false, reason: 'no_insights' },
      { stepKey: 'finance', stepTitle: 'Finance breakout', included: true, reason: 'included' },
    ]);
  });

  it('formats a body bullet from a real insight, including the supportCount and detail', async () => {
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'agreement',
        statement: 'Most people like X',
        detail: 'because of Y',
        supportCount: 4,
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body).toBe(
      '• [agreement, 4 people] Most people like X — because of Y'
    );
  });

  it('omits the detail suffix when detail is null', async () => {
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'agreement',
        statement: 'Most people like X',
        detail: null,
        supportCount: 4,
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body).toBe('• [agreement, 4 people] Most people like X');
  });

  it('falls back an unrecognised insight kind to `theme` rather than leaking a raw DB value', async () => {
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'some-legacy-value',
        statement: 'Z happened',
        detail: null,
        supportCount: 4,
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body).toBe('• [theme, 4 people] Z happened');
  });

  it('joins multiple gated insights for the same step into one multi-line body, in query order', async () => {
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'agreement',
        statement: 'First',
        detail: null,
        supportCount: 4,
      },
      { stepId: 'step-entry', kind: 'outlier', statement: 'Second', detail: null, supportCount: 3 },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body).toBe(
      '• [agreement, 4 people] First\n• [outlier, 3 people] Second'
    );
  });

  it('clips a body that exceeds the per-step character cap, appending a truncation marker', async () => {
    const longStatement = 'x'.repeat(20_000);
    findInsights.mockResolvedValue([
      {
        stepId: 'step-entry',
        kind: 'theme',
        statement: longStatement,
        detail: null,
        supportCount: 4,
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    const body = material.blocks[0].body;
    expect(body.endsWith('\n[truncated]')).toBe(true);
    expect(body.length).toBe(12_000 + '\n[truncated]'.length);
  });

  it('produces empty routing and zero concludedRuns — a meeting has no per-step routing to report', async () => {
    findInsights.mockResolvedValue([]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.routing).toEqual([]);
    expect(material.concludedRuns).toBe(0);
    // The switcher-only routing/runs queries must not even be issued for a meeting.
    expect(findRuns).not.toHaveBeenCalled();
    expect(findReports).not.toHaveBeenCalled();
  });

  it('queries insights across the whole experience once, not once per step', async () => {
    findInsights.mockResolvedValue([]);
    await buildSynthesisMaterial('exp-1');
    expect(findInsights).toHaveBeenCalledTimes(1);
    expect(findInsights).toHaveBeenCalledWith(
      expect.objectContaining({ where: { meeting: { experienceId: 'exp-1' } } })
    );
  });
});

describe('buildSynthesisMaterial — agentic_switcher', () => {
  beforeEach(() => {
    findExperience.mockResolvedValue(experienceRow({ kind: 'agentic_switcher' }));
  });

  it('records no_questionnaire for a step with no attached questionnaire, and never queries reports for it', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: null },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage).toEqual([
      { stepKey: 'a', stepTitle: 'A', included: false, reason: 'no_questionnaire' },
    ]);
    expect(material.blocks).toEqual([]);
  });

  it('skips the cohort-report query entirely when no eligible step has a questionnaire', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: null },
    ]);
    await buildSynthesisMaterial('exp-1');
    expect(findReports).not.toHaveBeenCalled();
  });

  it('records no_report for a step with a questionnaire but no cohort report row at all', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage).toEqual([
      { stepKey: 'a', stepTitle: 'A', included: false, reason: 'no_report' },
    ]);
  });

  it('records not_ready for a report that exists but has not finished generating', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      { experienceStepOwnerId: 'step-a', status: 'processing', revisions: [] },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage).toEqual([
      { stepKey: 'a', stepTitle: 'A', included: false, reason: 'not_ready' },
    ]);
  });

  it('records empty_report for a ready report whose latest revision flattens to nothing', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      {
        experienceStepOwnerId: 'step-a',
        status: 'ready',
        revisions: [{ content: { summary: '', sections: [], recommendations: [] } }],
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage).toEqual([
      { stepKey: 'a', stepTitle: 'A', included: false, reason: 'empty_report' },
    ]);
    expect(material.blocks).toEqual([]);
  });

  it('flattens a ready report into real prose — HTML stripped, sections headed, recommendations bulleted', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      {
        experienceStepOwnerId: 'step-a',
        status: 'ready',
        revisions: [
          {
            content: {
              summary: '<p>Hello world</p>',
              sections: [{ heading: 'Sec1', body: '<p>Body text</p>', chartIds: [] }],
              recommendations: ['Do X'],
              charts: [],
            },
          },
        ],
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    // Proves real transformation (HTML → paragraphs → assembled prose) — not a mock echo.
    expect(material.blocks[0].body).toBe(
      'Hello world\n\n### Sec1\nBody text\n\n### Recommendations\n• Do X'
    );
    expect(material.coverage[0].reason).toBe('included');
  });

  it('clips a flattened report body that exceeds the per-step character cap', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      {
        experienceStepOwnerId: 'step-a',
        status: 'ready',
        // `validateCohortReportContent` itself caps `summary` at 6,000 chars and a section `body`
        // at 8,000 — neither alone exceeds the synthesis material's 12,000-char per-step cap, so
        // combine a full-length summary with a full-length section to clear it.
        revisions: [
          {
            content: {
              summary: 'x'.repeat(20_000),
              sections: [{ heading: 'S', body: 'y'.repeat(20_000), chartIds: [] }],
              recommendations: [],
            },
          },
        ],
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body.endsWith('\n[truncated]')).toBe(true);
    expect(material.blocks[0].body.length).toBe(12_000 + '\n[truncated]'.length);
  });

  it('skips a section that flattens to nothing (e.g. empty HTML) without emitting a bare heading', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      {
        experienceStepOwnerId: 'step-a',
        status: 'ready',
        revisions: [
          {
            content: {
              summary: 'A real summary.',
              sections: [
                // Strips to nothing — must be dropped, not rendered as "### Empty\n".
                { heading: 'Empty', body: '<p></p>   ', chartIds: [] },
                { heading: 'Real', body: '<p>Has content</p>', chartIds: [] },
              ],
              recommendations: [],
            },
          },
        ],
      },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.blocks[0].body).toBe('A real summary.\n\n### Real\nHas content');
    expect(material.blocks[0].body).not.toContain('Empty');
  });

  it('does not crash on a report row with a null experienceStepOwnerId, and the real step still reads no_report', async () => {
    // Defensive `?? ''` fallback in the step lookup: a malformed row with no owner id must bucket
    // under a key no real step id can match, rather than throwing or silently matching the wrong step.
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([
      { experienceStepOwnerId: null, status: 'ready', revisions: [] },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage).toEqual([
      { stepKey: 'a', stepTitle: 'A', included: false, reason: 'no_report' },
    ]);
  });

  it('takes only the LATEST revision — the query orders by revisionNumber desc, take 1', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
    ]);
    await buildSynthesisMaterial('exp-1');
    expect(findReports).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          revisions: expect.objectContaining({
            orderBy: { revisionNumber: 'desc' },
            take: 1,
          }),
        }),
      })
    );
  });

  it('orders coverage as two separate passes: every no_questionnaire step first, then every withQuestionnaire outcome — not step order', async () => {
    // step-A has no questionnaire, step-B does, step-C has no questionnaire, step-D does.
    // A naive reading would expect coverage in step order (A, B, C, D). The real code notes
    // no_questionnaire in one full loop over `eligible`, then notes every withQuestionnaire
    // outcome in a second, separate loop — so the actual order is A, C, B, D.
    findSteps.mockResolvedValue([
      { id: 'step-A', key: 'a', title: 'A', kind: 'entry', questionnaireId: null },
      { id: 'step-B', key: 'b', title: 'B', kind: 'entry', questionnaireId: 'q1' },
      { id: 'step-C', key: 'c', title: 'C', kind: 'branch', questionnaireId: null },
      { id: 'step-D', key: 'd', title: 'D', kind: 'branch', questionnaireId: 'q2' },
    ]);
    findReports.mockResolvedValue([
      { experienceStepOwnerId: 'step-B', status: 'not_ready_bogus', revisions: [] },
      { experienceStepOwnerId: 'step-D', status: 'not_ready_bogus', revisions: [] },
    ]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.coverage.map((c) => c.stepKey)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('queries reports only for steps that have a questionnaire attached', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: null },
      { id: 'step-b', key: 'b', title: 'B', kind: 'entry', questionnaireId: 'q1' },
    ]);
    findReports.mockResolvedValue([]);
    await buildSynthesisMaterial('exp-1');
    expect(findReports).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopeKind: 'experience_step',
          experienceStepOwnerId: { in: ['step-b'] },
        }),
      })
    );
  });

  describe('routing distribution', () => {
    it('counts each completed run once per step it touched, and reports total concludedRuns', async () => {
      findSteps.mockResolvedValue([
        { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
        { id: 'step-b', key: 'b', title: 'B', kind: 'branch', questionnaireId: 'q2' },
      ]);
      findReports.mockResolvedValue([]);
      findRuns.mockResolvedValue([
        { legs: [{ stepId: 'step-a' }, { stepId: 'step-b' }] },
        { legs: [{ stepId: 'step-a' }] },
      ]);
      const material = await buildSynthesisMaterial('exp-1');
      expect(material.routing).toEqual([
        { stepKey: 'a', stepTitle: 'A', runs: 2 },
        { stepKey: 'b', stepTitle: 'B', runs: 1 },
      ]);
      expect(material.concludedRuns).toBe(2);
    });

    it('counts a step only ONCE per run even if the run revisited it (a leg re-run must not inflate share)', async () => {
      findSteps.mockResolvedValue([
        { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
      ]);
      findReports.mockResolvedValue([]);
      // One run whose legs visit step-a three times (e.g. a loop back).
      findRuns.mockResolvedValue([
        { legs: [{ stepId: 'step-a' }, { stepId: 'step-a' }, { stepId: 'step-a' }] },
      ]);
      const material = await buildSynthesisMaterial('exp-1');
      expect(material.routing).toEqual([{ stepKey: 'a', stepTitle: 'A', runs: 1 }]);
    });

    it('omits a step from routing entirely when zero completed runs touched it', async () => {
      findSteps.mockResolvedValue([
        { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: 'q1' },
        { id: 'step-b', key: 'b', title: 'B', kind: 'branch', questionnaireId: 'q2' },
      ]);
      findReports.mockResolvedValue([]);
      findRuns.mockResolvedValue([{ legs: [{ stepId: 'step-a' }] }]);
      const material = await buildSynthesisMaterial('exp-1');
      expect(material.routing.map((r) => r.stepKey)).toEqual(['a']);
    });

    it('queries only completed runs for this experience', async () => {
      findSteps.mockResolvedValue([]);
      findReports.mockResolvedValue([]);
      findRuns.mockResolvedValue([]);
      await buildSynthesisMaterial('exp-1');
      expect(findRuns).toHaveBeenCalledWith(
        expect.objectContaining({ where: { experienceId: 'exp-1', status: 'completed' } })
      );
    });
  });

  it('logs a summary with the experience id, kind, included count and eligible coverage count', async () => {
    findSteps.mockResolvedValue([
      { id: 'step-a', key: 'a', title: 'A', kind: 'entry', questionnaireId: null },
    ]);
    findReports.mockResolvedValue([]);
    await buildSynthesisMaterial('exp-1');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'experience synthesis: material built',
      expect.objectContaining({
        experienceId: 'exp-1',
        kind: 'agentic_switcher',
        included: 0,
        eligible: 1,
      })
    );
  });

  it('carries the experience title and kind through untouched', async () => {
    findExperience.mockResolvedValue(
      experienceRow({ title: 'Onboarding Journey', kind: 'agentic_switcher' })
    );
    findSteps.mockResolvedValue([]);
    findReports.mockResolvedValue([]);
    const material = await buildSynthesisMaterial('exp-1');
    expect(material.experienceTitle).toBe('Onboarding Journey');
    expect(material.experienceKind).toBe('agentic_switcher');
  });
});
