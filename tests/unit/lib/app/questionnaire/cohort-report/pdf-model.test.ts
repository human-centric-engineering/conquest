/**
 * Unit test: cohort-report PDF model (F14.6).
 *
 * Asserts `htmlToParagraphs` flattens HTML to text paragraphs (block tags → breaks, list markers,
 * entities) and `buildCohortReportPdfModel` assembles the flat model + resolves a section's chart to
 * PDF bars.
 */

import { describe, it, expect } from 'vitest';

import {
  htmlToParagraphs,
  buildCohortReportPdfModel,
} from '@/lib/app/questionnaire/cohort-report/pdf-model';
import type { CohortReportContent } from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

describe('htmlToParagraphs', () => {
  it('splits block elements into paragraphs and renders list bullets', () => {
    const paras = htmlToParagraphs('<p>First &amp; foremost</p><ul><li>one</li><li>two</li></ul>');
    expect(paras).toEqual(['First & foremost', '• one', '• two']);
  });

  it('returns an empty array for blank input', () => {
    expect(htmlToParagraphs('')).toEqual([]);
    expect(htmlToParagraphs('<p></p>')).toEqual([]);
  });
});

const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1 Pulse',
  versionId: 'v1',
  totalSessions: 12,
  completedSessions: 10,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [],
  segmentation: [
    {
      dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
      segments: [
        {
          value: 'Eng',
          label: 'Eng',
          totalSessions: 7,
          completedSessions: 6,
          suppressed: false,
          questions: [],
        },
        {
          value: 'Sales',
          label: 'Sales',
          totalSessions: 5,
          completedSessions: 5,
          suppressed: false,
          questions: [],
        },
      ],
    },
  ],
};

const content: CohortReportContent = {
  summary: '<p>Strong engagement overall.</p>',
  sections: [
    {
      heading: 'Participation',
      body: '<p>Most teams responded.</p>',
      format: 'html',
      chartIds: ['c1'],
    },
  ],
  charts: [{ id: 'c1', title: 'Respondents by team', kind: 'segment_sizes', dimensionKey: 'team' }],
  recommendations: ['Keep the cadence'],
  actions: ['Share the results'],
};

describe('buildCohortReportPdfModel', () => {
  it('assembles the flat model and resolves section charts to bars', () => {
    const model = buildCohortReportPdfModel({
      content,
      dataset,
      title: 'Q1 Pulse — cohort report',
      accentColor: '#5469d4',
      logoDataUri: null,
    });

    expect(model.title).toBe('Q1 Pulse — cohort report');
    expect(model.accentColor).toBe('#5469d4');
    expect(model.totalRespondents).toBe(12);
    expect(model.summaryParagraphs).toEqual(['Strong engagement overall.']);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].paragraphs).toEqual(['Most teams responded.']);

    const chart = model.sections[0].charts[0];
    expect(chart.title).toBe('Respondents by team');
    expect(chart.bars).toEqual([
      { label: 'Eng', value: 7 },
      { label: 'Sales', value: 5 },
    ]);
    expect(model.recommendations).toEqual(['Keep the cadence']);
    expect(model.actions).toEqual(['Share the results']);
  });
});
