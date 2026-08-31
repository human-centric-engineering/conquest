/**
 * Report progress events — label + narrowing unit tests.
 *
 * The labels are what an admin reads for the ~100 seconds a preview takes, so they are the product,
 * not decoration. Two things are pinned here: every phase in {@link REPORT_PROGRESS_PHASES} has a
 * label (a phase added without one would silently fall through to "Working…", i.e. back to the
 * uninformative spinner this replaced), and the `sampling` counter reads correctly at both ends of
 * the fan-out.
 *
 * @see lib/app/questionnaire/report/progress-events.ts
 */

import { describe, it, expect } from 'vitest';

import {
  REPORT_PROGRESS_PHASES,
  isReportProgressEvent,
  reportProgressLabel,
  type ReportPreviewEvent,
} from '@/lib/app/questionnaire/report/progress-events';

describe('reportProgressLabel', () => {
  it('gives every declared phase a real label, never the fallback', () => {
    for (const phase of REPORT_PROGRESS_PHASES) {
      const label = reportProgressLabel({ type: phase });
      expect(label, `phase ${phase}`).not.toBe('Working…');
      expect(label.length, `phase ${phase}`).toBeGreaterThan(0);
    }
  });

  it('names what the sample respondent has to cover on the opening event', () => {
    expect(reportProgressLabel({ type: 'started', questionCount: 69, dataSlotCount: 5 })).toBe(
      'Preparing a sample respondent for 69 questions and 5 data slots…'
    );
  });

  it('singularises the opening counts and drops the empty half', () => {
    expect(reportProgressLabel({ type: 'started', questionCount: 1, dataSlotCount: 0 })).toBe(
      'Preparing a sample respondent for 1 question…'
    );
    expect(reportProgressLabel({ type: 'started', questionCount: 0, dataSlotCount: 1 })).toBe(
      'Preparing a sample respondent for 1 data slot…'
    );
  });

  it('falls back to a neutral opener when the counts are missing', () => {
    expect(reportProgressLabel({ type: 'started' })).toBe('Starting…');
  });

  it('counts completed answer batches, so the wait visibly advances', () => {
    expect(reportProgressLabel({ type: 'sampling', batchesDone: 0, batchesTotal: 4 })).toBe(
      'Answering the questionnaire as them — 0 of 4 parts done…'
    );
    expect(reportProgressLabel({ type: 'sampling', batchesDone: 4, batchesTotal: 4 })).toBe(
      'Answering the questionnaire as them — 4 of 4 parts done…'
    );
  });

  it('drops the counter rather than printing "0 of 0" when there are no batches', () => {
    expect(reportProgressLabel({ type: 'sampling' })).toBe('Answering the questionnaire as them…');
  });
});

describe('isReportProgressEvent', () => {
  it('separates the two terminals from the progress phases', () => {
    const done: ReportPreviewEvent = {
      type: 'done',
      questionnaireTitle: 'Pulse',
      mode: 'narrative',
      content: {},
      formatted: true,
      completionPct: 100,
    };
    const failure: ReportPreviewEvent = { type: 'error', code: 'X', message: 'nope' };

    expect(isReportProgressEvent(done)).toBe(false);
    expect(isReportProgressEvent(failure)).toBe(false);
    for (const phase of REPORT_PROGRESS_PHASES) {
      expect(isReportProgressEvent({ type: phase }), `phase ${phase}`).toBe(true);
    }
  });
});
