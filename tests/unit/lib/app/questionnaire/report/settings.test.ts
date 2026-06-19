import { describe, it, expect } from 'vitest';

import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
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
        instructions: 'Be concise.',
        structure: 'Summary then actions.',
        backgroundContext: 'Quarterly pulse.',
        useClientKnowledge: true,
      },
      delivery: { onScreen: false, download: true },
    };
    expect(narrowRespondentReportSettings(full)).toEqual(full);
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
      mode: 'narrative', // not in the v1 tuple
      enabled: 'yes', // not a boolean
      rawIncludes: { dataSlots: 1, questionsAsPresented: false },
    });
    expect(result.mode).toBe(DEFAULT_RESPONDENT_REPORT_SETTINGS.mode);
    expect(result.enabled).toBe(false);
    expect(result.rawIncludes.dataSlots).toBe(false); // non-boolean → default (false)
    expect(result.rawIncludes.questionsAsPresented).toBe(false);
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
