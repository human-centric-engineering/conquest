/**
 * Unit: transcript PDF render helper (F7.6).
 *
 * A real end-to-end render — the {@link TranscriptPdfDocument} through
 * `@react-pdf/renderer`'s `renderToBuffer` — asserting a genuine PDF comes out (the
 * `%PDF` magic header, non-empty body). Exercises the named, anonymous, branded-logo,
 * sparse-header and empty-conversation paths so the document never throws on any shape.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf.tsx
 */

import { describe, it, expect } from 'vitest';

import { renderTranscriptPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf';
import { buildTranscriptExportModel } from '@/lib/app/questionnaire/export/build-transcript-export-model';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

function model(
  over: Partial<Parameters<typeof buildTranscriptExportModel>[0]> = {}
): TranscriptExportModel {
  return buildTranscriptExportModel({
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 1,
    goal: 'Understand new-hire needs',
    audience: { description: 'New hires' },
    refRaw: '7F3K9M2P',
    anonymous: false,
    respondentName: 'Ada Lovelace',
    startedAt: '2026-06-01T09:55:00.000Z',
    completedAt: '2026-06-01T10:05:00.000Z',
    status: 'completed',
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: null,
    turns: [
      {
        userMessage: '',
        agentResponse: 'Welcome! What is your role?',
        at: '2026-06-01T09:55:00.000Z',
      },
      {
        userMessage: 'Engineer.',
        agentResponse: 'Great — which team?',
        at: '2026-06-01T10:00:00.000Z',
      },
    ],
    ...over,
  });
}

/** The PDF magic header: every PDF byte stream starts with "%PDF". */
function startsWithPdfMagic(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

describe('renderTranscriptPdf', () => {
  it('renders a non-empty PDF for a named, completed session', async () => {
    const pdf = await renderTranscriptPdf(model());
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the anonymous variant without throwing', async () => {
    const pdf = await renderTranscriptPdf(model({ anonymous: true }));
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the sparse-header + branded-logo + not-yet-completed paths', async () => {
    // No goal/audience/ref/completion, an unparseable timestamp (→ dash), a brand logo.
    const pdf = await renderTranscriptPdf(
      model({
        goal: null,
        audience: null,
        refRaw: null,
        completedAt: null,
        status: 'active',
        theme: {
          ctaColor: '#111111',
          accentColor: '#abcdef',
          logoUrl: 'data:image/png;base64,iVBORw0KGgo=',
          welcomeCopy: null,
        },
        turns: [{ userMessage: 'Hi', agentResponse: 'Hello', at: 'not-a-date' }],
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders an empty conversation without throwing', async () => {
    const pdf = await renderTranscriptPdf(model({ turns: [] }));
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the full-bleed brand-banner path (surface band + distinct logo backdrop)', async () => {
    // surfaceColor → the full-width banner; a distinct logoBackgroundColor → the inner
    // rounded backdrop. Exercises the bannered branch of the header.
    const pdf = await renderTranscriptPdf(
      model({
        theme: {
          ctaColor: '#111111',
          accentColor: '#abcdef',
          logoUrl: 'data:image/png;base64,iVBORw0KGgo=',
          welcomeCopy: null,
          surfaceColor: '#1c0f2e',
          logoBackgroundColor: '#2d1b4e',
          logoBackgroundEnabled: true,
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);
});
