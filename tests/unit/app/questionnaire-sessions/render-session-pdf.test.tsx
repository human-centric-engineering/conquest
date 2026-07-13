/**
 * Unit: session PDF render helper (F7.4).
 *
 * A real end-to-end render — the {@link SessionPdfDocument} through
 * `@react-pdf/renderer`'s `renderToBuffer` — asserting a genuine PDF comes out (the
 * `%PDF` magic header, non-empty body). Exercises both the answered + unanswered and
 * the anonymous header paths so the document never throws on either shape.
 *
 * These are structural (no-throw / valid-PDF) checks by design: react-pdf emits a binary
 * buffer, and the repo deliberately mocks `pdf-parse` everywhere rather than run the
 * environment-sensitive pdfjs text-extraction engine in unit tests. Content-level behaviour
 * (e.g. paragraph splitting) is asserted at the pure-function layer — see
 * `splitReportParagraphs` in `report/content.test.ts` — not by parsing the rendered PDF.
 * test-review:accept assertion-quality — render tests intentionally assert structure (no-throw + %PDF), not extracted text; content is covered by pure-function tests.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf.tsx
 */

import { describe, it, expect } from 'vitest';

import { renderSessionPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf';
import { buildSessionExportModel } from '@/lib/app/questionnaire/export/build-session-export-model';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

function model(
  over: Partial<Parameters<typeof buildSessionExportModel>[0]> = {}
): SessionExportModel {
  return buildSessionExportModel({
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 1,
    ref: 'GSP289HB',
    goal: 'Understand new-hire needs',
    audience: { description: 'New hires' },
    anonymous: false,
    respondentName: 'Ada Lovelace',
    profile: null,
    completedAt: '2026-06-01T10:00:00.000Z',
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: null,
    status: 'completed',
    sections: [
      {
        sectionId: 's1',
        title: 'About you',
        slots: [
          { slotKey: 'role', prompt: 'Your role?', type: 'free_text', required: true },
          { slotKey: 'team', prompt: 'Team size?', type: 'numeric', required: false },
        ],
      },
    ],
    answers: [
      {
        slotKey: 'role',
        value: 'Engineer',
        provenance: 'direct',
        confidence: 0.9,
        rationale: 'Stated directly.',
        answeredAtTurnIndex: 1,
        refinementHistory: [],
      },
    ],
    ...over,
  });
}

/** The PDF magic header: every PDF byte stream starts with "%PDF". */
function startsWithPdfMagic(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

describe('renderSessionPdf', () => {
  it('renders a non-empty PDF for a completed session', async () => {
    const pdf = await renderSessionPdf(model());
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the anonymous variant without throwing', async () => {
    const pdf = await renderSessionPdf(model({ anonymous: true }));
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the AI insights section (Respondent Report mode 2)', async () => {
    const pdf = await renderSessionPdf(
      model({
        insights: {
          summary: 'You are highly engaged.',
          sections: [{ heading: 'Strengths', body: 'Consistent positivity across the board.' }],
          actions: ['Block weekly focus time', 'Share your approach with the team'],
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the woven narrative deliverable (narrativeOnly) without throwing', async () => {
    const pdf = await renderSessionPdf(
      model({
        narrativeOnly: true,
        insights: {
          summary: 'Your story so far.',
          sections: [{ heading: 'Where you are now', body: 'Woven prose with your answers.' }],
          actions: ['Try this next'],
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a multi-paragraph body + bullet block without throwing', async () => {
    const pdf = await renderSessionPdf(
      model({
        narrativeOnly: true,
        insights: {
          summary: 'Opening framing.\n\nA second paragraph that develops the point.',
          sections: [
            {
              heading: 'What limits growth',
              body: 'First paragraph grounded in an answer.\n\nIn practice:\n- one\n- two\n\nA closing paragraph.',
            },
          ],
          actions: ['Do the first thing'],
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('threads narrativeOnly through the model (default false)', () => {
    expect(model().narrativeOnly).toBe(false);
    expect(model({ narrativeOnly: true }).narrativeOnly).toBe(true);
  });

  it('renders an insights section with no sub-sections or actions', async () => {
    const pdf = await renderSessionPdf(
      model({ insights: { summary: 'Short and sweet.', sections: [], actions: [] } })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a research section (list display) with a note and mixed source/snippet findings', async () => {
    // Exercises the research block's list-mode map: a finding with both a source and a
    // snippet, and a second with neither — covering the per-finding source/snippet
    // conditionals' true and false sides, plus the research note line.
    const pdf = await renderSessionPdf(
      model({
        insights: {
          summary: 'Grounded findings follow.',
          sections: [],
          actions: [],
          research: {
            display: 'list',
            note: 'Synthesised from three independent sources.',
            findings: [
              {
                title: 'Industry benchmark report',
                url: 'https://example.com/benchmark',
                snippet: 'Average completion rates rose 12% year over year.',
                source: 'Example Research Co.',
              },
              {
                title: 'Unsourced, snippet-free finding',
                url: 'https://example.com/other',
                snippet: '',
              },
            ],
          },
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders a research section (table display) with one sourced and one unsourced finding', async () => {
    // Exercises the research block's table-mode map: the display==='table' branch, and
    // the per-row source conditional's true/false sides.
    const pdf = await renderSessionPdf(
      model({
        insights: {
          summary: 'Data laid out for scanning.',
          sections: [],
          actions: [],
          research: {
            display: 'table',
            findings: [
              {
                title: 'Sourced finding',
                url: 'https://example.com/a',
                snippet: 'Detail one.',
                source: 'Source A',
              },
              {
                title: 'Unsourced finding',
                url: 'https://example.com/b',
                snippet: 'Detail two.',
              },
            ],
          },
        },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the partial-report caveat below the completion threshold', async () => {
    const pdf = await renderSessionPdf(
      model({
        insightsCompletionPct: 40,
        insights: { summary: 'Early signal only.', sections: [], actions: [] },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders collected profile fields, a null completed date, and a key that humanises to itself', async () => {
    // Exercises the F8.3 profile-entries map (profile truthy), a completedAt of null
    // (formatDate's "no date" dash), and humaniseKey's empty-after-cleanup edge case
    // (a key of only underscores falls back to the raw key).
    const pdf = await renderSessionPdf(
      model({
        completedAt: null,
        profile: { job_title: 'Engineer', ___: 'value' },
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);

  it('renders the remaining header + slot branches without throwing', async () => {
    // Exercises: a branded logo, no goal/audience header rows, an unscored answer
    // (no confidence meta), a multi-entry refinement history, an unparseable
    // completion date (→ dash), and an unanswered slot.
    const pdf = await renderSessionPdf(
      model({
        goal: null,
        audience: null,
        completedAt: 'not-a-date',
        theme: {
          ctaColor: '#111111',
          accentColor: '#abcdef',
          logoUrl: 'data:image/png;base64,iVBORw0KGgo=',
          welcomeCopy: null,
        },
        answers: [
          {
            slotKey: 'role',
            value: 'Engineer',
            provenance: 'inferred',
            confidence: null, // no confidence meta line
            rationale: null,
            answeredAtTurnIndex: 1,
            refinementHistory: [
              {
                previousValue: 'Dev',
                previousProvenance: 'direct',
                newValue: 'Engineer',
                rationale: 'Clarified.',
                source: 'clarification',
              },
              {
                previousValue: 'Engineer',
                previousProvenance: 'direct',
                newValue: 'Senior Engineer',
                rationale: 'Promotion.',
                source: 'correction',
              },
            ],
          },
          // 'team' slot left unanswered → "Not answered" path.
        ],
      })
    );
    expect(startsWithPdfMagic(pdf)).toBe(true);
  }, 20000);
});
