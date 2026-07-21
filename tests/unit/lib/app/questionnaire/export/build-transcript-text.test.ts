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
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      hasBrandIdentity: false,
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
});
