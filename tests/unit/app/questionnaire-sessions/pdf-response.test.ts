/**
 * Unit: PDF download response helper (F7.4).
 *
 * Pins the download envelope both export routes share: the `application/pdf` content
 * type, the `attachment` disposition with a title+version-derived filename, the
 * `no-store` cache directive, and that the buffer survives into the body. Covers the
 * slug fallback when a title has no alphanumerics.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/pdf-response.ts
 */

import { describe, it, expect } from 'vitest';

import { sessionPdfResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/pdf-response';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/** A minimal model — only the fields the response helper reads matter. */
function model(over: Partial<SessionExportModel> = {}): SessionExportModel {
  return {
    questionnaireTitle: 'Onboarding Survey',
    versionNumber: 3,
    goal: null,
    audienceSummary: null,
    respondent: null,
    anonymous: false,
    profile: null,
    completedAt: null,
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: {
      ctaColor: '#000',
      accentColor: '#000',
      logoUrl: null,
      welcomeCopy: '',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
    },
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    ...over,
  };
}

describe('sessionPdfResponse', () => {
  it('sets the PDF content type and no-store cache directive', () => {
    const res = sessionPdfResponse(Buffer.from('%PDF-1.7'), model());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('derives an attachment filename from the slugified title and version', () => {
    const res = sessionPdfResponse(Buffer.from('%PDF'), model());
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="responses-onboarding-survey-v3.pdf"'
    );
  });

  it('falls back to "questionnaire" when the title has no alphanumerics', () => {
    const res = sessionPdfResponse(Buffer.from('%PDF'), model({ questionnaireTitle: '—!!!—' }));
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="responses-questionnaire-v3.pdf"'
    );
  });

  it('carries the PDF bytes into the response body', async () => {
    const res = sessionPdfResponse(Buffer.from('%PDF-1.7 body'), model());
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).toString('latin1')).toBe('%PDF-1.7 body');
  });
});
