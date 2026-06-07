/**
 * Unit: session PDF export model builder (F7.4).
 *
 * Pins the pure builder's domain rules: full coverage (every slot present, unanswered
 * included) regardless of the version's panel scope; anonymous-mode identity redaction;
 * theme resolution (defaults filled); audience summarisation; and that rationale +
 * refinement history are carried through. The React-PDF document + render are tested
 * separately (render-session-pdf.test.tsx).
 *
 * @see lib/app/questionnaire/export/build-session-export-model.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildSessionExportModel,
  type SessionExportInput,
} from '@/lib/app/questionnaire/export/build-session-export-model';
import { SUNRISE_THEME_DEFAULTS } from '@/lib/app/questionnaire/theming';

function input(over: Partial<SessionExportInput> = {}): SessionExportInput {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 2,
    goal: 'Understand new-hire needs',
    audience: { description: 'New engineering hires' },
    anonymous: false,
    respondentName: 'Ada Lovelace',
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
        refinementHistory: [
          {
            previousValue: 'Dev',
            previousProvenance: 'direct',
            newValue: 'Engineer',
            rationale: 'Clarified title.',
            source: 'clarification',
          },
        ],
      },
    ],
    ...over,
  };
}

describe('buildSessionExportModel', () => {
  describe('full coverage', () => {
    it('includes every slot — answered and unanswered alike', () => {
      const model = buildSessionExportModel(input());
      const slots = model.sections[0].slots;
      expect(slots).toHaveLength(2);
      expect(slots.map((s) => [s.slotKey, s.answered])).toEqual([
        ['role', true],
        ['team', false],
      ]);
      expect(model.answeredCount).toBe(1);
      expect(model.totalCount).toBe(2);
    });

    it('carries rationale and refinement history on the answered slot', () => {
      const model = buildSessionExportModel(input());
      const role = model.sections[0].slots[0];
      expect(role.rationale).toBe('Stated directly.');
      expect(role.refinementHistory).toHaveLength(1);
      expect(role.refinementHistory[0].newValue).toBe('Engineer');
    });

    it('leaves the unanswered slot blank (no value/provenance/confidence)', () => {
      const model = buildSessionExportModel(input());
      const team = model.sections[0].slots[1];
      expect(team.answered).toBe(false);
      expect(team.value).toBeNull();
      expect(team.provenance).toBeNull();
      expect(team.confidence).toBeNull();
    });
  });

  describe('anonymous redaction', () => {
    it('drops respondent identity when anonymous, even with a name supplied', () => {
      const model = buildSessionExportModel(input({ anonymous: true }));
      expect(model.anonymous).toBe(true);
      expect(model.respondent).toBeNull();
    });

    it('keeps the respondent name when not anonymous', () => {
      const model = buildSessionExportModel(input());
      expect(model.respondent).toEqual({ name: 'Ada Lovelace' });
    });

    it('is null when not anonymous but no name is known', () => {
      const model = buildSessionExportModel(input({ respondentName: null }));
      expect(model.respondent).toBeNull();
    });
  });

  describe('theme resolution', () => {
    it('fills Sunrise defaults when no demo-client theme is attributed', () => {
      const model = buildSessionExportModel(input({ theme: null }));
      expect(model.theme.accentColor).toBe(SUNRISE_THEME_DEFAULTS.accentColor);
      expect(model.theme.logoUrl).toBeNull();
    });

    it('uses the demo-client accent + logo when present', () => {
      const model = buildSessionExportModel(
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

  describe('audience summary', () => {
    it('prefers the description', () => {
      expect(buildSessionExportModel(input()).audienceSummary).toBe('New engineering hires');
    });

    it('falls back to the role when no description', () => {
      const model = buildSessionExportModel(input({ audience: { role: 'Manager' } }));
      expect(model.audienceSummary).toBe('Manager');
    });

    it('is null when audience is absent or empty', () => {
      expect(buildSessionExportModel(input({ audience: null })).audienceSummary).toBeNull();
      expect(buildSessionExportModel(input({ audience: {} })).audienceSummary).toBeNull();
    });
  });

  describe('header passthrough', () => {
    it('carries title, version, goal, and timestamps verbatim', () => {
      const model = buildSessionExportModel(input());
      expect(model.questionnaireTitle).toBe('Onboarding survey');
      expect(model.versionNumber).toBe(2);
      expect(model.goal).toBe('Understand new-hire needs');
      expect(model.completedAt).toBe('2026-06-01T10:00:00.000Z');
      expect(model.generatedAt).toBe('2026-06-07T12:00:00.000Z');
    });
  });
});
