/**
 * Unit: chat-transcript plain-text serialiser (F7.6).
 *
 * Pins the `.txt` output: the intro lists the run details (reference, version, goal,
 * audience, respondent, timing, status), the conversation renders each turn labelled +
 * UTC-timestamped, anonymous mode shows "Anonymous" instead of a name, and an empty
 * conversation degrades to a clear note. Timestamps are deterministic (UTC).
 *
 * @see lib/app/questionnaire/export/build-transcript-text.ts
 */

import { describe, it, expect } from 'vitest';

import { buildTranscriptText } from '@/lib/app/questionnaire/export/build-transcript-text';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

/** A fixed UTC stamp — the serialiser formats it, so the tests stay deterministic. */
const STAMP = '2026-06-01T10:00:00.000Z';

function model(over: Partial<TranscriptExportModel> = {}): TranscriptExportModel {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 2,
    goal: 'Understand new-hire needs',
    audienceSummary: 'New engineering hires',
    refDisplay: '7F3K-9M2P',
    anonymous: false,
    respondentLabel: 'Ada Lovelace',
    interviewerLabel: 'Interviewer',
    startedAt: '2026-06-01T09:55:00.000Z',
    completedAt: '2026-06-01T10:05:00.000Z',
    status: 'completed',
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: {
      ctaColor: '#000',
      accentColor: '#000',
      logoUrl: null,
      bannerUrl: null,
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      hasBrandIdentity: false,
      canvasColor: null,
      onCanvas: null,
      canvasIsDark: false,
      canvasColorDark: null,
      onCanvasDark: null,
      accentColorEnd: null,
      logoMarkUrl: null,
      logoDarkUrl: null,
      bandLogoUrl: null,
      bandLogoDarkUrl: null,
      fontPairing: 'neutral',
      customFontDisplay: null,
      customFontBody: null,
      fontFaceCss: null,
    },
    turns: [
      {
        speaker: 'interviewer',
        text: 'Welcome! What is your role?',
        at: '2026-06-01T09:55:00.000Z',
      },
      { speaker: 'respondent', text: 'I am an engineer.', at: '2026-06-01T10:00:00.000Z' },
    ],
    ...over,
  };
}

describe('buildTranscriptText', () => {
  it('opens with the title and a transcript heading', () => {
    const text = buildTranscriptText(model());
    expect(text.startsWith('Onboarding survey\nConversation transcript\n')).toBe(true);
  });

  it('lists the run details in the intro', () => {
    const text = buildTranscriptText(model());
    expect(text).toContain('Reference: 7F3K-9M2P');
    expect(text).toContain('Version: 2');
    expect(text).toContain('Goal: Understand new-hire needs');
    expect(text).toContain('Audience: New engineering hires');
    expect(text).toContain('Respondent: Ada Lovelace');
    expect(text).toContain('Status: Completed');
  });

  it('renders each turn labelled and UTC-timestamped', () => {
    const text = buildTranscriptText(model());
    expect(text).toContain('[1 Jun 2026, 09:55] Interviewer:\nWelcome! What is your role?');
    expect(text).toContain('[1 Jun 2026, 10:00] Ada Lovelace:\nI am an engineer.');
  });

  it('explains the labels in the intro using the resolved respondent label', () => {
    const text = buildTranscriptText(model());
    expect(text).toContain('"Interviewer" is the questionnaire assistant; "Ada Lovelace" is you');
    expect(text).toContain('times are shown in UTC');
  });

  it('shows "Anonymous" and the generic label when anonymous', () => {
    const text = buildTranscriptText(model({ anonymous: true, respondentLabel: 'Respondent' }));
    expect(text).toContain('Respondent: Anonymous');
    expect(text).toContain('] Respondent:');
    expect(text).not.toContain('Ada Lovelace');
  });

  it('omits a missing goal/audience/completion row entirely', () => {
    const text = buildTranscriptText(
      model({ goal: null, audienceSummary: null, completedAt: null })
    );
    expect(text).not.toContain('Goal:');
    expect(text).not.toContain('Audience:');
    expect(text).not.toContain('Completed:');
  });

  it('degrades to a clear note for an empty conversation', () => {
    const text = buildTranscriptText(model({ turns: [] }));
    expect(text).toContain('No conversation was recorded for this session.');
  });

  it('ends with exactly one trailing newline', () => {
    const text = buildTranscriptText(model());
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  // ── Sectioned interviews (P21) ─────────────────────────────────────────────────────────────────

  it('divides a sectioned conversation under upper-cased section headings', () => {
    const text = buildTranscriptText(
      model({
        turns: [
          {
            speaker: 'interviewer',
            text: 'Tell me about your context.',
            at: STAMP,
            sectionLabel: 'Context',
          },
          {
            speaker: 'respondent',
            text: 'We are twelve people.',
            at: STAMP,
            sectionLabel: 'Context',
          },
          { speaker: 'interviewer', text: 'And the problem?', at: STAMP, sectionLabel: 'Problem' },
        ],
      })
    );
    expect(text).toContain('CONTEXT');
    expect(text).toContain('PROBLEM');
    // The heading is announced once per visit, not once per line.
    expect(text.match(/CONTEXT/g)).toHaveLength(1);
  });

  it('announces a section again when the respondent comes back to it', () => {
    const text = buildTranscriptText(
      model({
        turns: [
          { speaker: 'respondent', text: 'a', at: STAMP, sectionLabel: 'Context' },
          { speaker: 'respondent', text: 'b', at: STAMP, sectionLabel: 'Problem' },
          { speaker: 'respondent', text: 'c', at: STAMP, sectionLabel: 'Context' },
        ],
      })
    );
    expect(text.match(/CONTEXT/g)).toHaveLength(2);
  });

  it('renders an unsectioned conversation with no headings at all', () => {
    const text = buildTranscriptText(model());
    expect(text).not.toContain('CONTEXT');
    // The only rules are the intro's; the conversation itself is undivided.
    expect(text.match(/─{60}/g)).toHaveLength(1);
  });
});
