import { describe, it, expect } from 'vitest';

import {
  profileFieldSchema,
  updateConfigSchema,
} from '@/lib/app/questionnaire/authoring/config-schema';
import { TONE_PERSONA_MAX_LENGTH } from '@/lib/app/questionnaire/types';

/**
 * Request-body contract for the version configuration endpoint (F3.1).
 *
 * `updateConfigSchema` is a partial save (every field optional, at least one
 * required) with two cross-field rules enforced by `superRefine`: contradiction
 * mode/N coherence and unique profile-field keys. `profileFieldSchema` pins the
 * select/options relationship per field. These tests document the boundary the
 * route relies on so a malformed config never reaches the upsert.
 */

/** A minimal valid full config body (mirrors the schema defaults). */
const fullConfig = {
  selectionStrategy: 'weighted' as const,
  minQuestionsAnswered: 3,
  coverageThreshold: 0.8,
  costBudgetUsd: 2.5,
  maxQuestionsPerSession: 20,
  voiceEnabled: true,
  contradictionMode: 'flag' as const,
  contradictionWindowN: 5,
  anonymousMode: false,
  answerSlotPanelScope: 'answered_only' as const,
  profileFields: [{ key: 'role', label: 'Role', type: 'text' as const, required: true }],
};

describe('updateConfigSchema', () => {
  it('accepts a well-formed full config', () => {
    expect(updateConfigSchema.safeParse(fullConfig).success).toBe(true);
  });

  it('accepts a single-field partial save', () => {
    expect(updateConfigSchema.safeParse({ voiceEnabled: true }).success).toBe(true);
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(updateConfigSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the random selection strategy (F4.1)', () => {
    expect(updateConfigSchema.safeParse({ selectionStrategy: 'random' }).success).toBe(true);
  });

  it('rejects an unknown selection strategy', () => {
    const res = updateConfigSchema.safeParse({ selectionStrategy: 'telepathic' });
    expect(res.success).toBe(false);
  });

  it('accepts the answer-panel scope enum (F7.2)', () => {
    expect(updateConfigSchema.safeParse({ answerSlotPanelScope: 'full_progress' }).success).toBe(
      true
    );
    expect(updateConfigSchema.safeParse({ answerSlotPanelScope: 'answered_only' }).success).toBe(
      true
    );
  });

  it('rejects an unknown answer-panel scope', () => {
    expect(updateConfigSchema.safeParse({ answerSlotPanelScope: 'everything' }).success).toBe(
      false
    );
  });

  it('accepts each presentation mode (P-presentation)', () => {
    for (const mode of ['chat', 'form', 'both'] as const) {
      expect(updateConfigSchema.safeParse({ presentationMode: mode }).success).toBe(true);
    }
  });

  it('rejects an unknown presentation mode', () => {
    expect(updateConfigSchema.safeParse({ presentationMode: 'telepathy' }).success).toBe(false);
  });

  it('accepts the inline-correction toggle (Variant B), and rejects a non-boolean', () => {
    expect(updateConfigSchema.safeParse({ inlineCorrectionEnabled: false }).success).toBe(true);
    expect(updateConfigSchema.safeParse({ inlineCorrectionEnabled: 'yes' }).success).toBe(false);
  });

  it('accepts null budget / cap as "no cap"', () => {
    const res = updateConfigSchema.safeParse({ costBudgetUsd: null, maxQuestionsPerSession: null });
    expect(res.success).toBe(true);
  });

  it('rejects a coverage threshold above 1', () => {
    expect(updateConfigSchema.safeParse({ coverageThreshold: 1.5 }).success).toBe(false);
  });

  it('rejects a negative coverage threshold', () => {
    expect(updateConfigSchema.safeParse({ coverageThreshold: -0.1 }).success).toBe(false);
  });

  it('rejects a non-positive cost budget', () => {
    expect(updateConfigSchema.safeParse({ costBudgetUsd: 0 }).success).toBe(false);
  });

  describe('early finish', () => {
    it('accepts the toggle and bounded minimums', () => {
      expect(
        updateConfigSchema.safeParse({
          allowEarlyFinish: true,
          earlyFinishMinCoverage: 0.5,
          earlyFinishMinQuestions: 3,
        }).success
      ).toBe(true);
    });

    it('rejects a coverage minimum outside 0–1', () => {
      expect(updateConfigSchema.safeParse({ earlyFinishMinCoverage: 1.5 }).success).toBe(false);
      expect(updateConfigSchema.safeParse({ earlyFinishMinCoverage: -0.1 }).success).toBe(false);
    });

    it('rejects a negative or non-integer questions minimum', () => {
      expect(updateConfigSchema.safeParse({ earlyFinishMinQuestions: -1 }).success).toBe(false);
      expect(updateConfigSchema.safeParse({ earlyFinishMinQuestions: 2.5 }).success).toBe(false);
    });

    it('rejects a non-boolean toggle', () => {
      expect(updateConfigSchema.safeParse({ allowEarlyFinish: 'yes' }).success).toBe(false);
    });
  });

  describe('contradiction mode / N coherence', () => {
    it('rejects a non-off mode with N = 0', () => {
      const res = updateConfigSchema.safeParse({
        contradictionMode: 'flag',
        contradictionWindowN: 0,
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.includes('contradictionWindowN'))).toBe(true);
      }
    });

    it('rejects a non-off mode with N missing', () => {
      expect(updateConfigSchema.safeParse({ contradictionMode: 'probe' }).success).toBe(false);
    });

    it('accepts a non-off mode with N >= 1', () => {
      expect(
        updateConfigSchema.safeParse({ contradictionMode: 'flag', contradictionWindowN: 1 }).success
      ).toBe(true);
    });

    it('rejects mode off with a non-zero N', () => {
      expect(
        updateConfigSchema.safeParse({ contradictionMode: 'off', contradictionWindowN: 3 }).success
      ).toBe(false);
    });

    it('accepts mode off with N = 0', () => {
      expect(
        updateConfigSchema.safeParse({ contradictionMode: 'off', contradictionWindowN: 0 }).success
      ).toBe(true);
    });
  });

  describe('profile fields', () => {
    it('rejects duplicate keys across fields', () => {
      const res = updateConfigSchema.safeParse({
        profileFields: [
          { key: 'role', label: 'Role', type: 'text', required: false },
          { key: 'role', label: 'Role 2', type: 'text', required: false },
        ],
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.includes('profileFields'))).toBe(true);
      }
    });

    it('accepts distinct keys', () => {
      const res = updateConfigSchema.safeParse({
        profileFields: [
          { key: 'role', label: 'Role', type: 'text', required: false },
          { key: 'org', label: 'Organisation', type: 'text', required: true },
        ],
      });
      expect(res.success).toBe(true);
    });
  });
});

describe('profileFieldSchema', () => {
  it('accepts a plain text field', () => {
    expect(
      profileFieldSchema.safeParse({ key: 'name', label: 'Name', type: 'text', required: true })
        .success
    ).toBe(true);
  });

  it('rejects a non-slug key', () => {
    expect(
      profileFieldSchema.safeParse({
        key: 'Full Name',
        label: 'Name',
        type: 'text',
        required: true,
      }).success
    ).toBe(false);
  });

  it('requires options for a select field', () => {
    const res = profileFieldSchema.safeParse({
      key: 'team',
      label: 'Team',
      type: 'select',
      required: false,
    });
    expect(res.success).toBe(false);
  });

  it('rejects empty options for a select field', () => {
    const res = profileFieldSchema.safeParse({
      key: 'team',
      label: 'Team',
      type: 'select',
      required: false,
      options: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects duplicate options for a select field', () => {
    const res = profileFieldSchema.safeParse({
      key: 'team',
      label: 'Team',
      type: 'select',
      required: false,
      options: ['Eng', 'Eng'],
    });
    expect(res.success).toBe(false);
  });

  it('accepts a select field with distinct options', () => {
    const res = profileFieldSchema.safeParse({
      key: 'team',
      label: 'Team',
      type: 'select',
      required: false,
      options: ['Eng', 'Sales'],
    });
    expect(res.success).toBe(true);
  });

  it('forbids options on a non-select field', () => {
    const res = profileFieldSchema.safeParse({
      key: 'age',
      label: 'Age',
      type: 'number',
      required: false,
      options: ['x'],
    });
    expect(res.success).toBe(false);
  });
});

describe('updateConfigSchema — abuseThreshold (seriousness gate)', () => {
  it('accepts 0 (off) and a positive value within the cap', () => {
    expect(updateConfigSchema.safeParse({ abuseThreshold: 0 }).success).toBe(true);
    expect(updateConfigSchema.safeParse({ abuseThreshold: 4 }).success).toBe(true);
    expect(updateConfigSchema.safeParse({ abuseThreshold: 50 }).success).toBe(true);
  });

  it('rejects negative, over-cap, or non-integer values', () => {
    expect(updateConfigSchema.safeParse({ abuseThreshold: -1 }).success).toBe(false);
    expect(updateConfigSchema.safeParse({ abuseThreshold: 51 }).success).toBe(false);
    expect(updateConfigSchema.safeParse({ abuseThreshold: 2.5 }).success).toBe(false);
  });
});

describe('updateConfigSchema — tone (F-tone)', () => {
  /** A complete tone block (all nine dimensions + persona) — the editor always sends the whole thing. */
  const fullTone = {
    empathy: { enabled: true, level: 4 },
    mirroring: { enabled: false, level: 3 },
    formality: { enabled: true, level: 5 },
    mimicry: { enabled: false, level: 3 },
    verbosity: { enabled: true, level: 2 },
    warmth: { enabled: false, level: 3 },
    curiosity: { enabled: true, level: 5 },
    readingComplexity: { enabled: false, level: 3 },
    humour: { enabled: false, level: 3 },
    persona: { enabled: true, text: 'You are a supportive coach.' },
  };

  it('accepts a well-formed full tone block', () => {
    expect(updateConfigSchema.safeParse({ tone: fullTone }).success).toBe(true);
  });

  it('rejects a level outside 1–5 or a non-integer level', () => {
    expect(
      updateConfigSchema.safeParse({ tone: { ...fullTone, empathy: { enabled: true, level: 6 } } })
        .success
    ).toBe(false);
    expect(
      updateConfigSchema.safeParse({ tone: { ...fullTone, empathy: { enabled: true, level: 0 } } })
        .success
    ).toBe(false);
    expect(
      updateConfigSchema.safeParse({
        tone: { ...fullTone, empathy: { enabled: true, level: 2.5 } },
      }).success
    ).toBe(false);
  });

  it('rejects a partial tone block (a missing dimension) — the block is sent whole', () => {
    const { humour: _omit, ...partial } = fullTone;
    void _omit;
    expect(updateConfigSchema.safeParse({ tone: partial }).success).toBe(false);
  });

  it('rejects unknown keys and an over-long persona', () => {
    expect(
      updateConfigSchema.safeParse({ tone: { ...fullTone, bogus: { enabled: true, level: 3 } } })
        .success
    ).toBe(false);
    expect(
      updateConfigSchema.safeParse({
        tone: {
          ...fullTone,
          persona: { enabled: true, text: 'x'.repeat(TONE_PERSONA_MAX_LENGTH + 1) },
        },
      }).success
    ).toBe(false);
  });
});

describe('updateConfigSchema — persona selection (F-persona)', () => {
  // The persona library is fixed (BUILT_IN_PERSONAS) — no custom library is accepted; only the
  // on/off toggle and a built-in default key are stored.
  it('accepts a personaSelection whose default is a built-in persona key', () => {
    expect(
      updateConfigSchema.safeParse({
        personaSelection: {
          enabled: true,
          defaultPersonaKey: 'neutral-coach',
          allowRespondentSwitch: false,
          switcher: 'page',
        },
      }).success
    ).toBe(true);
  });

  it('rejects a default persona key that is not a built-in persona', () => {
    expect(
      updateConfigSchema.safeParse({
        personaSelection: {
          enabled: true,
          defaultPersonaKey: 'not-a-builtin',
          allowRespondentSwitch: false,
          switcher: 'page',
        },
      }).success
    ).toBe(false);
  });

  it('defaults a missing allowRespondentSwitch to false (tolerates hand-authored / older imports)', () => {
    const res = updateConfigSchema.safeParse({
      personaSelection: { enabled: true, defaultPersonaKey: 'director', switcher: 'page' },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.personaSelection?.allowRespondentSwitch).toBe(false);
    }
    // A non-boolean is still rejected — the default only fills an omitted field.
    expect(
      updateConfigSchema.safeParse({
        personaSelection: {
          enabled: true,
          defaultPersonaKey: 'director',
          allowRespondentSwitch: 'yes',
          switcher: 'page',
        },
      }).success
    ).toBe(false);
  });

  it('accepts each valid switcher style and rejects an unknown one', () => {
    for (const switcher of ['page', 'indicator', 'both']) {
      expect(
        updateConfigSchema.safeParse({
          personaSelection: {
            enabled: true,
            defaultPersonaKey: 'director',
            allowRespondentSwitch: true,
            switcher,
          },
        }).success
      ).toBe(true);
    }
    expect(
      updateConfigSchema.safeParse({
        personaSelection: {
          enabled: true,
          defaultPersonaKey: 'director',
          allowRespondentSwitch: true,
          switcher: 'modal',
        },
      }).success
    ).toBe(false);
  });

  it('ignores a custom persona library — a stray `personas` field is not stored', () => {
    const custom = [{ key: 'a', label: 'A', description: 'A voice.' }];
    // Sent alongside a valid selection: parses, but `personas` is stripped (not a known field).
    const res = updateConfigSchema.safeParse({
      personas: custom,
      personaSelection: {
        enabled: true,
        defaultPersonaKey: 'director',
        allowRespondentSwitch: true,
        switcher: 'both',
      },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).not.toHaveProperty('personas');
    }
  });

  it('rejects a payload whose only field is a (now-ignored) persona library', () => {
    // `personas` is stripped, leaving no field to update.
    expect(updateConfigSchema.safeParse({ personas: [{ key: 'a' }] }).success).toBe(false);
  });
});

describe('updateConfigSchema — respondentReport (Respondent Report)', () => {
  /** A complete report block — the editor always sends the whole thing. */
  const fullReport = {
    enabled: true,
    mode: 'raw_plus_insights' as const,
    rawIncludes: { dataSlots: true, questionsAsPresented: true },
    generation: {
      narrativeStyle: 'flowing' as const,
      instructions: 'Warm, concise, second person.',
      structure: 'Summary, then three themes, then next steps.',
      backgroundContext: 'This client runs quarterly engagement pulses.',
      useClientKnowledge: true,
    },
    delivery: { onScreen: true, download: true },
  };

  it('accepts a well-formed full report block', () => {
    expect(updateConfigSchema.safeParse({ respondentReport: fullReport }).success).toBe(true);
  });

  it('accepts each valid narrative style and rejects an unknown one', () => {
    for (const narrativeStyle of ['flowing', 'concise', 'structured'] as const) {
      expect(
        updateConfigSchema.safeParse({
          respondentReport: {
            ...fullReport,
            generation: { ...fullReport.generation, narrativeStyle },
          },
        }).success
      ).toBe(true);
    }
    expect(
      updateConfigSchema.safeParse({
        respondentReport: {
          ...fullReport,
          generation: { ...fullReport.generation, narrativeStyle: 'poetic' },
        },
      }).success
    ).toBe(false);
  });

  it('accepts the narrative mode', () => {
    expect(
      updateConfigSchema.safeParse({ respondentReport: { ...fullReport, mode: 'narrative' } })
        .success
    ).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(
      updateConfigSchema.safeParse({ respondentReport: { ...fullReport, mode: 'full_essay' } })
        .success
    ).toBe(false);
  });

  it('rejects a partial block (a missing sub-object) — the block is sent whole', () => {
    const { delivery: _omit, ...partial } = fullReport;
    void _omit;
    expect(updateConfigSchema.safeParse({ respondentReport: partial }).success).toBe(false);
  });

  it('rejects unknown keys at any level', () => {
    expect(
      updateConfigSchema.safeParse({ respondentReport: { ...fullReport, bogus: true } }).success
    ).toBe(false);
    expect(
      updateConfigSchema.safeParse({
        respondentReport: {
          ...fullReport,
          rawIncludes: { ...fullReport.rawIncludes, extra: true },
        },
      }).success
    ).toBe(false);
  });

  it('rejects over-long free-text fields', () => {
    expect(
      updateConfigSchema.safeParse({
        respondentReport: {
          ...fullReport,
          generation: { ...fullReport.generation, instructions: 'x'.repeat(4001) },
        },
      }).success
    ).toBe(false);
    expect(
      updateConfigSchema.safeParse({
        respondentReport: {
          ...fullReport,
          generation: { ...fullReport.generation, backgroundContext: 'x'.repeat(8001) },
        },
      }).success
    ).toBe(false);
  });
});

describe('updateConfigSchema — intro video link', () => {
  const baseIntro = { enabled: true, background: '', buttonLabel: '' };

  it('accepts a recognised YouTube or Vimeo link', () => {
    for (const videoUrl of ['https://youtu.be/dQw4w9WgXcQ', 'https://vimeo.com/123456789']) {
      expect(updateConfigSchema.safeParse({ intro: { ...baseIntro, videoUrl } }).success).toBe(
        true
      );
    }
  });

  it('accepts an empty or omitted video link (no video)', () => {
    expect(updateConfigSchema.safeParse({ intro: { ...baseIntro, videoUrl: '' } }).success).toBe(
      true
    );
    expect(updateConfigSchema.safeParse({ intro: baseIntro }).success).toBe(true);
  });

  it('rejects an unrecognised / non-video URL, flagged on intro.videoUrl', () => {
    const result = updateConfigSchema.safeParse({
      intro: { ...baseIntro, videoUrl: 'https://example.com/not-a-video' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['intro', 'videoUrl']);
    }
  });

  it('rejects an over-long video link', () => {
    expect(
      updateConfigSchema.safeParse({
        intro: { ...baseIntro, videoUrl: `https://youtu.be/${'x'.repeat(600)}` },
      }).success
    ).toBe(false);
  });
});
