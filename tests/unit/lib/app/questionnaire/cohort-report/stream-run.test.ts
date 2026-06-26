/**
 * Unit test: streamReportRun (F14.3 streamed generation driver).
 *
 * Mocks the inner streamGenerateCohortReport generator, appendCohortReportRevision,
 * markCohortReportFailed and logAdminAction. Asserts:
 *  - happy path: progress events forwarded → appendCohortReportRevision called → done event yielded
 *    with the revisionNumber returned by appendCohortReportRevision;
 *  - error path: thrown generation marks the report failed and yields { type:'error', code:'GENERATION_FAILED' }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock before importing streamReportRun so the module picks up the mocked versions.
vi.mock('@/lib/app/questionnaire/cohort-report/generate', () => ({
  streamGenerateCohortReport: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/cohort-report/persist', () => ({
  appendCohortReportRevision: vi.fn(),
  markCohortReportFailed: vi.fn(),
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { streamGenerateCohortReport } from '@/lib/app/questionnaire/cohort-report/generate';
import {
  appendCohortReportRevision,
  markCohortReportFailed,
} from '@/lib/app/questionnaire/cohort-report/persist';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { streamReportRun } from '@/lib/app/questionnaire/cohort-report/stream-run';
import { roundScope, versionScope } from '@/lib/app/questionnaire/cohort-report/scope';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';
import type { ReportGenEvent } from '@/lib/app/questionnaire/cohort-report/report-events';
import type { GeneratedCohortReport } from '@/lib/app/questionnaire/cohort-report/generate';

type Mock = ReturnType<typeof vi.fn>;

/** Collect all yielded events from streamReportRun into an array. Never throws (the SUT doesn't). */
async function drainRun(...args: Parameters<typeof streamReportRun>): Promise<ReportGenEvent[]> {
  const events: ReportGenEvent[] = [];
  for await (const evt of streamReportRun(...args)) {
    events.push(evt);
  }
  return events;
}

/** Build an async generator that yields `progress` events then returns `result`. */
function* fakeGeneratorSync(
  progress: Array<{ type: string; sessionCount?: number; segmentCount?: number }>,
  result: GeneratedCohortReport
): Generator<unknown, GeneratedCohortReport, unknown> {
  for (const evt of progress) yield evt;
  return result;
}

/** Wrap the sync generator in an async wrapper compatible with streamGenerateCohortReport's type. */
async function* asyncWrap<T, R>(gen: Generator<T, R, unknown>): AsyncGenerator<T, R, unknown> {
  let step = gen.next();
  while (!step.done) {
    yield step.value;
    step = gen.next();
  }
  return step.value;
}

const generatedContent = {
  summary: 'Engagement is high.',
  sections: [
    { heading: 'Engagement', body: '<p>Mean 4.1.</p>', chartIds: [], format: 'html' as const },
  ],
  charts: [],
  recommendations: ['Maintain pace'],
  actions: ['Share results'],
};

const PROGRESS_EVENTS = [
  { type: 'started' },
  { type: 'dataset_built', sessionCount: 8, segmentCount: 1 },
  { type: 'material_built' },
  { type: 'context_loaded' },
  { type: 'synthesizing' },
] as const;

const GENERATED: GeneratedCohortReport = { content: generatedContent, costUsd: 0.04 };

const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1 Pulse',
  versionId: 'v1',
  totalSessions: 8,
  completedSessions: 7,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [],
  segmentation: [],
};

const BASE_PARAMS = {
  scope: roundScope('r1', 'v1', 'Q1 Pulse'),
  dataset,
  reportId: 'rep-1',
  adminId: 'admin-user',
  entityName: 'Q1 Pulse',
  clientIp: '127.0.0.1',
};

beforeEach(() => {
  vi.clearAllMocks();
  (appendCohortReportRevision as Mock).mockResolvedValue(3);
  (markCohortReportFailed as Mock).mockResolvedValue(undefined);
});

describe('streamReportRun — happy path', () => {
  it('forwards every progress event then emits done with the persisted revisionNumber', async () => {
    (streamGenerateCohortReport as Mock).mockImplementation(() =>
      asyncWrap(fakeGeneratorSync([...PROGRESS_EVENTS], GENERATED))
    );

    const events = await drainRun(BASE_PARAMS);

    // The first 5 events are forwarded progress events from the inner generator.
    expect(events.slice(0, 5).map((e) => e.type)).toEqual([
      'started',
      'dataset_built',
      'material_built',
      'context_loaded',
      'synthesizing',
    ]);

    // The terminal event is done, carrying the revision number from appendCohortReportRevision.
    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    if (done.type === 'done') {
      // revisionNumber is what appendCohortReportRevision returned (3), NOT the mock setup value —
      // streamReportRun is responsible for threading it through from the persist call.
      expect(done.revisionNumber).toBe(3);
      expect(done.costUsd).toBe(0.04);
      expect(typeof done.generatedAt).toBe('string');
    }
  });

  it('calls appendCohortReportRevision with the generated content and marks authoredBy=ai', async () => {
    (streamGenerateCohortReport as Mock).mockImplementation(() =>
      asyncWrap(fakeGeneratorSync([...PROGRESS_EVENTS], GENERATED))
    );

    await drainRun(BASE_PARAMS);

    expect(appendCohortReportRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'rep-1',
        authoredBy: 'ai',
        content: generatedContent,
        costUsd: 0.04,
        userId: 'admin-user',
      })
    );
  });

  it('calls logAdminAction with the right scope metadata', async () => {
    (streamGenerateCohortReport as Mock).mockImplementation(() =>
      asyncWrap(fakeGeneratorSync([...PROGRESS_EVENTS], GENERATED))
    );

    await drainRun(BASE_PARAMS);

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-user',
        action: 'app_cohort_report.generate',
        entityId: 'rep-1',
        metadata: expect.objectContaining({ scopeKind: 'round', versionId: 'v1' }),
      })
    );
  });

  it('works for a versionScope — scopeKind=version is threaded into the audit entry', async () => {
    (streamGenerateCohortReport as Mock).mockImplementation(() =>
      asyncWrap(fakeGeneratorSync([...PROGRESS_EVENTS], GENERATED))
    );

    const versionDataset: CohortDataset = { ...dataset, roundId: null, roundName: 'Version-wide' };
    const events = await drainRun({
      ...BASE_PARAMS,
      scope: versionScope('v1', 'Version-wide'),
      dataset: versionDataset,
    });

    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ scopeKind: 'version' }),
      })
    );
  });
});

describe('streamReportRun — error path', () => {
  it('marks the report failed and yields an error event when generation throws', async () => {
    // Make the generator throw at the synthesizing phase.
    async function* failingGen(): AsyncGenerator<
      Record<string, unknown>,
      GeneratedCohortReport,
      unknown
    > {
      yield { type: 'started' };
      yield { type: 'dataset_built', sessionCount: 8, segmentCount: 0 };
      throw new Error('LLM call timed out');
      // Satisfies return type signature; never reached.
      return undefined as unknown as GeneratedCohortReport;
    }
    (streamGenerateCohortReport as Mock).mockImplementation(() => failingGen());

    const events = await drainRun(BASE_PARAMS);

    // streamReportRun must NOT throw — it surfaces the failure as an event instead.
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('error');
    if (lastEvent.type === 'error') {
      expect(lastEvent.code).toBe('GENERATION_FAILED');
      expect(typeof lastEvent.message).toBe('string');
    }

    // The report header must be marked failed so the UI can surface it.
    expect(markCohortReportFailed).toHaveBeenCalledWith('rep-1', expect.any(Error));
    // No revision should have been appended on failure.
    expect(appendCohortReportRevision).not.toHaveBeenCalled();
  });

  it('does not re-throw when markCohortReportFailed itself rejects', async () => {
    // An immediately-throwing generator: use asyncWrap over an empty sync generator that throws.
    async function* throwImmediately(): AsyncGenerator<never, GeneratedCohortReport, unknown> {
      yield* (async function* () {})(); // satisfy require-yield; yields nothing before throw
      throw new Error('timeout');
      return undefined as unknown as GeneratedCohortReport;
    }
    (streamGenerateCohortReport as Mock).mockImplementation(() => throwImmediately());
    (markCohortReportFailed as Mock).mockRejectedValue(new Error('DB unavailable'));

    // streamReportRun swallows the secondary failure — the caller (SSE route) must always get the
    // error event rather than an unhandled exception crashing the response stream.
    const events = await drainRun(BASE_PARAMS);
    expect(events[events.length - 1].type).toBe('error');
  });
});
