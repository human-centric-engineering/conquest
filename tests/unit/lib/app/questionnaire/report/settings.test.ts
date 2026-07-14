import { describe, it, expect } from 'vitest';

import {
  narrowRespondentReportSettings,
  resolveReportRawIncludes,
} from '@/lib/app/questionnaire/report/settings';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';

describe('narrowRespondentReportSettings', () => {
  it('returns the defaults for an empty / non-record value', () => {
    expect(narrowRespondentReportSettings({})).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS);
    expect(narrowRespondentReportSettings(null)).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS);
    expect(narrowRespondentReportSettings('nope')).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS);
    expect(narrowRespondentReportSettings([1, 2])).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS);
  });

  it('preserves a complete, well-formed block verbatim', () => {
    const full = {
      enabled: true,
      mode: 'raw_plus_insights' as const,
      rawIncludes: { dataSlots: true, questionsAsPresented: false },
      generation: {
        narrativeStyle: 'structured' as const,
        instructions: 'Be concise.',
        structure: 'Summary then actions.',
        backgroundContext: 'Quarterly pulse.',
        useClientKnowledge: true,
      },
      delivery: { onScreen: false, download: true },
      research: {
        enabled: true,
        timing: 'both' as const,
        rounds: 3,
        maxResults: 8,
        before: { instructions: 'Find benchmarks.' },
        after: { instructions: 'Find sources.' },
        display: 'table' as const,
        informNarrative: false,
        appendix: true,
      },
    };
    expect(narrowRespondentReportSettings(full)).toEqual(full);
  });

  describe('research block', () => {
    it('fills the research defaults when the key is missing', () => {
      expect(narrowRespondentReportSettings({}).research).toEqual(
        DEFAULT_RESPONDENT_REPORT_SETTINGS.research
      );
    });

    it('clamps rounds and maxResults into their bounds and rounds fractions', () => {
      const r = narrowRespondentReportSettings({
        research: { rounds: 99, maxResults: 0 },
      }).research;
      expect(r.rounds).toBe(5); // MAX_REPORT_RESEARCH_ROUNDS
      expect(r.maxResults).toBe(1); // clamped up to the floor
      const r2 = narrowRespondentReportSettings({
        research: { rounds: 2.7, maxResults: 4.2 },
      }).research;
      expect(r2.rounds).toBe(3);
      expect(r2.maxResults).toBe(4);
    });

    it('defaults an invalid timing / display and coerces non-numeric rounds', () => {
      const r = narrowRespondentReportSettings({
        research: { timing: 'sideways', display: 'grid', rounds: 'lots' },
      }).research;
      expect(r.timing).toBe('before');
      expect(r.display).toBe('list');
      expect(r.rounds).toBe(DEFAULT_RESPONDENT_REPORT_SETTINGS.research.rounds);
    });

    it('trims + length-caps the per-phase instructions', () => {
      const long = 'x'.repeat(REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH + 50);
      const r = narrowRespondentReportSettings({
        research: { before: { instructions: `  hello  ` }, after: { instructions: long } },
      }).research;
      expect(r.before.instructions).toBe('hello');
      expect(r.after.instructions).toHaveLength(REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH);
    });

    it('defaults appendix to false when missing and coerces a non-boolean', () => {
      expect(narrowRespondentReportSettings({}).research.appendix).toBe(false);
      expect(
        narrowRespondentReportSettings({ research: { appendix: 'yes' } }).research.appendix
      ).toBe(false);
      expect(
        narrowRespondentReportSettings({ research: { appendix: true } }).research.appendix
      ).toBe(true);
    });
  });

  it('narrows the narrative style: defaults when missing/invalid, preserves valid values', () => {
    // Missing → default (flowing).
    expect(narrowRespondentReportSettings({}).generation.narrativeStyle).toBe('flowing');
    // Unknown string → default.
    expect(
      narrowRespondentReportSettings({ generation: { narrativeStyle: 'poetic' } }).generation
        .narrativeStyle
    ).toBe('flowing');
    // Non-string → default.
    expect(
      narrowRespondentReportSettings({ generation: { narrativeStyle: 7 } }).generation
        .narrativeStyle
    ).toBe('flowing');
    // Each valid value is preserved.
    for (const style of ['flowing', 'concise', 'structured'] as const) {
      expect(
        narrowRespondentReportSettings({ generation: { narrativeStyle: style } }).generation
          .narrativeStyle
      ).toBe(style);
    }
  });

  it('fills missing sub-objects and keys from the defaults', () => {
    const result = narrowRespondentReportSettings({ enabled: true, mode: 'raw_plus_insights' });
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('raw_plus_insights');
    // Missing sub-objects fall back wholesale.
    expect(result.rawIncludes).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS.rawIncludes);
    expect(result.generation).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS.generation);
    expect(result.delivery).toEqual(DEFAULT_RESPONDENT_REPORT_SETTINGS.delivery);
  });

  it('falls back to the default mode for an unknown mode and coerces non-booleans', () => {
    const result = narrowRespondentReportSettings({
      mode: 'full_essay', // not in the tuple
      enabled: 'yes', // not a boolean
      rawIncludes: { dataSlots: 1, questionsAsPresented: false },
    });
    expect(result.mode).toBe(DEFAULT_RESPONDENT_REPORT_SETTINGS.mode);
    expect(result.enabled).toBe(false);
    expect(result.rawIncludes.dataSlots).toBe(false); // non-boolean → default (false)
    expect(result.rawIncludes.questionsAsPresented).toBe(false);
  });

  it('accepts narrative as a valid mode', () => {
    const result = narrowRespondentReportSettings({ enabled: true, mode: 'narrative' });
    expect(result.mode).toBe('narrative');
  });

  it('trims and length-caps the free-text generation fields', () => {
    const result = narrowRespondentReportSettings({
      generation: {
        instructions: `  hi  `,
        structure: 'x'.repeat(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH + 50),
        backgroundContext: 'y'.repeat(RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH + 50),
        useClientKnowledge: true,
      },
    });
    expect(result.generation.instructions).toBe('hi');
    expect(result.generation.structure).toHaveLength(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH);
    expect(result.generation.backgroundContext).toHaveLength(
      RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH
    );
    expect(result.generation.useClientKnowledge).toBe(true);
  });

  it('drops unknown keys', () => {
    const result = narrowRespondentReportSettings({ bogus: 'x', enabled: true });
    expect(result).not.toHaveProperty('bogus');
    expect(result.enabled).toBe(true);
  });
});

describe('resolveReportRawIncludes', () => {
  function settings(over: Partial<typeof DEFAULT_RESPONDENT_REPORT_SETTINGS>) {
    return { ...DEFAULT_RESPONDENT_REPORT_SETTINGS, ...over };
  }

  it('passes rawIncludes through verbatim for the raw + insights mode', () => {
    const result = resolveReportRawIncludes(
      settings({
        mode: 'raw_plus_insights',
        rawIncludes: { questionsAsPresented: true, dataSlots: true },
      })
    );
    expect(result).toEqual({ questions: true, dataSlots: true });
  });

  it('passes rawIncludes through verbatim for the raw mode', () => {
    const result = resolveReportRawIncludes(
      settings({ mode: 'raw', rawIncludes: { questionsAsPresented: true, dataSlots: false } })
    );
    expect(result).toEqual({ questions: true, dataSlots: false });
  });

  it('forces questions off for narrative mode even when the stored flag is true (no-backfill guard)', () => {
    const result = resolveReportRawIncludes(
      settings({ mode: 'narrative', rawIncludes: { questionsAsPresented: true, dataSlots: false } })
    );
    expect(result.questions).toBe(false);
  });

  it('keeps the data-slot appendix config-driven in narrative mode', () => {
    const result = resolveReportRawIncludes(
      settings({ mode: 'narrative', rawIncludes: { questionsAsPresented: true, dataSlots: true } })
    );
    expect(result).toEqual({ questions: false, dataSlots: true });
  });
});
