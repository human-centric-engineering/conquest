/**
 * Unit test: cohort-report settings projection (F14.1).
 *
 * Asserts `narrowCohortReportSettings` returns a complete, bounded {@link CohortReportSettings} from
 * `{}`/partial/legacy/malformed input — every sub-key present, enums narrowed, text capped.
 */

import { describe, it, expect } from 'vitest';

import { narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report/settings';
import {
  COHORT_REPORT_BACKGROUND_MAX_LENGTH,
  COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_COHORT_REPORT_SETTINGS,
} from '@/lib/app/questionnaire/types';

describe('narrowCohortReportSettings', () => {
  it('returns defaults for empty / null / non-object input', () => {
    expect(narrowCohortReportSettings({})).toEqual(DEFAULT_COHORT_REPORT_SETTINGS);
    expect(narrowCohortReportSettings(null)).toEqual(DEFAULT_COHORT_REPORT_SETTINGS);
    expect(narrowCohortReportSettings('nonsense')).toEqual(DEFAULT_COHORT_REPORT_SETTINGS);
  });

  it('preserves valid values and fills missing keys with defaults', () => {
    const result = narrowCohortReportSettings({
      enabled: true,
      generation: { length: 'detailed', formality: 'informal', useClientKnowledge: true },
    });
    expect(result.enabled).toBe(true);
    expect(result.generation.length).toBe('detailed');
    expect(result.generation.formality).toBe('informal');
    expect(result.generation.useClientKnowledge).toBe(true);
    // Unspecified keys fall back to defaults.
    expect(result.generation.detailLevel).toBe(
      DEFAULT_COHORT_REPORT_SETTINGS.generation.detailLevel
    );
    expect(result.generation.useRoundContext).toBe(
      DEFAULT_COHORT_REPORT_SETTINGS.generation.useRoundContext
    );
  });

  it('narrows unknown enum values to the default', () => {
    const result = narrowCohortReportSettings({
      generation: { length: 'enormous', detailLevel: 'x', formality: 'casual' },
    });
    expect(result.generation.length).toBe(DEFAULT_COHORT_REPORT_SETTINGS.generation.length);
    expect(result.generation.detailLevel).toBe(
      DEFAULT_COHORT_REPORT_SETTINGS.generation.detailLevel
    );
    expect(result.generation.formality).toBe(DEFAULT_COHORT_REPORT_SETTINGS.generation.formality);
  });

  it('trims and length-caps free-text fields', () => {
    const longInstr = 'a'.repeat(COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH + 50);
    const longBg = 'b'.repeat(COHORT_REPORT_BACKGROUND_MAX_LENGTH + 50);
    const result = narrowCohortReportSettings({
      generation: { instructions: `  ${longInstr}  `, backgroundContext: longBg },
    });
    expect(result.generation.instructions).toHaveLength(COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH);
    expect(result.generation.backgroundContext).toHaveLength(COHORT_REPORT_BACKGROUND_MAX_LENGTH);
  });

  it('coerces non-boolean toggles to defaults', () => {
    const result = narrowCohortReportSettings({
      enabled: 'yes',
      generation: { scoringEnabled: 1, useCohortContext: 'no' },
    });
    expect(result.enabled).toBe(DEFAULT_COHORT_REPORT_SETTINGS.enabled);
    expect(result.generation.scoringEnabled).toBe(
      DEFAULT_COHORT_REPORT_SETTINGS.generation.scoringEnabled
    );
    expect(result.generation.useCohortContext).toBe(
      DEFAULT_COHORT_REPORT_SETTINGS.generation.useCohortContext
    );
  });
});
