/**
 * Unit: chat-transcript export model builder (F7.6).
 *
 * Pins the pure builder's domain rules: speaker labels (Interviewer always; respondent name
 * when named + non-anonymous, else the generic "Respondent"; never the name when anonymous),
 * turn flattening (kickoff/empty lines skipped), reference formatting, and passthrough of
 * the header metadata + audience summary + theme resolution. The React-PDF document and the
 * text serialiser are tested separately.
 *
 * @see lib/app/questionnaire/export/build-transcript-export-model.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildTranscriptExportModel,
  type TranscriptExportInput,
} from '@/lib/app/questionnaire/export/build-transcript-export-model';
import { SUNRISE_THEME_DEFAULTS } from '@/lib/app/questionnaire/theming';

function input(over: Partial<TranscriptExportInput> = {}): TranscriptExportInput {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 2,
    goal: 'Understand new-hire needs',
    audience: { description: 'New engineering hires' },
    refRaw: '7F3K9M2P',
    anonymous: false,
    respondentName: 'Ada Lovelace',
    startedAt: '2026-06-01T09:55:00.000Z',
    completedAt: '2026-06-01T10:05:00.000Z',
    status: 'completed',
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: null,
    turns: [
      // The opening kickoff turn — empty user message, only the agent question.
      {
        userMessage: '',
        agentResponse: 'Welcome! What is your role?',
        at: '2026-06-01T09:55:00.000Z',
      },
      {
        userMessage: 'I am an engineer.',
        agentResponse: 'Great — which team?',
        at: '2026-06-01T10:00:00.000Z',
      },
    ],
    ...over,
  };
}

describe('buildTranscriptExportModel', () => {
  describe('speaker labels', () => {
    it('labels the agent "Interviewer" and the respondent by name when named + not anonymous', () => {
      const model = buildTranscriptExportModel(input());
      expect(model.interviewerLabel).toBe('Interviewer');
      expect(model.respondentLabel).toBe('Ada Lovelace');
    });

    it('falls back to "Respondent" when no name is known', () => {
      expect(buildTranscriptExportModel(input({ respondentName: null })).respondentLabel).toBe(
        'Respondent'
      );
      expect(buildTranscriptExportModel(input({ respondentName: '  ' })).respondentLabel).toBe(
        'Respondent'
      );
    });

    it('never uses the name when anonymous, even if one is supplied', () => {
      const model = buildTranscriptExportModel(input({ anonymous: true }));
      expect(model.anonymous).toBe(true);
      expect(model.respondentLabel).toBe('Respondent');
    });
  });

  describe('turn flattening', () => {
    it('skips the empty-message kickoff line and emits the rest in order', () => {
      const model = buildTranscriptExportModel(input());
      expect(model.turns).toEqual([
        {
          speaker: 'interviewer',
          text: 'Welcome! What is your role?',
          at: '2026-06-01T09:55:00.000Z',
        },
        { speaker: 'respondent', text: 'I am an engineer.', at: '2026-06-01T10:00:00.000Z' },
        { speaker: 'interviewer', text: 'Great — which team?', at: '2026-06-01T10:00:00.000Z' },
      ]);
    });

    it('skips an empty agent reply (never renders a blank line)', () => {
      const model = buildTranscriptExportModel(
        input({ turns: [{ userMessage: 'Just me.', agentResponse: '   ', at: 'x' }] })
      );
      expect(model.turns).toEqual([{ speaker: 'respondent', text: 'Just me.', at: 'x' }]);
    });

    it('yields no turns for an empty conversation', () => {
      expect(buildTranscriptExportModel(input({ turns: [] })).turns).toEqual([]);
    });
  });

  describe('reference', () => {
    it('groups the raw ref for display', () => {
      expect(buildTranscriptExportModel(input()).refDisplay).toBe('7F3K-9M2P');
    });

    it('is null when the session has no ref', () => {
      expect(buildTranscriptExportModel(input({ refRaw: null })).refDisplay).toBeNull();
    });
  });

  describe('header passthrough', () => {
    it('carries title, version, goal, status, and timestamps verbatim', () => {
      const model = buildTranscriptExportModel(input());
      expect(model.questionnaireTitle).toBe('Onboarding survey');
      expect(model.versionNumber).toBe(2);
      expect(model.goal).toBe('Understand new-hire needs');
      expect(model.status).toBe('completed');
      expect(model.startedAt).toBe('2026-06-01T09:55:00.000Z');
      expect(model.completedAt).toBe('2026-06-01T10:05:00.000Z');
      expect(model.generatedAt).toBe('2026-06-07T12:00:00.000Z');
    });

    it('summarises the audience (description preferred, role fallback, null when empty)', () => {
      expect(buildTranscriptExportModel(input()).audienceSummary).toBe('New engineering hires');
      expect(
        buildTranscriptExportModel(input({ audience: { role: 'Manager' } })).audienceSummary
      ).toBe('Manager');
      expect(buildTranscriptExportModel(input({ audience: null })).audienceSummary).toBeNull();
    });
  });

  describe('theme resolution', () => {
    it('fills Sunrise defaults when no demo-client theme is attributed', () => {
      const model = buildTranscriptExportModel(input({ theme: null }));
      expect(model.theme.accentColor).toBe(SUNRISE_THEME_DEFAULTS.accentColor);
      expect(model.theme.logoUrl).toBeNull();
    });

    it('uses the demo-client accent + logo when present', () => {
      const model = buildTranscriptExportModel(
        input({
          theme: {
            ctaColor: '#111111',
            accentColor: '#abcdef',
            logoUrl: 'data:image/png;base64,AAAA',
            welcomeCopy: null,
          },
        })
      );
      expect(model.theme.accentColor).toBe('#abcdef');
      expect(model.theme.logoUrl).toBe('data:image/png;base64,AAAA');
    });
  });
});
