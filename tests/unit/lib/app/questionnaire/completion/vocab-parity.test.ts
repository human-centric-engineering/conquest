import { describe, expect, it } from 'vitest';

import {
  COMPLETION_ACTIONS,
  COMPLETION_KINDS,
  UNMET_CRITERIA,
} from '@/lib/app/questionnaire/completion';

/**
 * Pin the completion vocabulary so any change to a tuple — adding an assessment kind,
 * an unmet criterion, or a respondent action — is a conscious, tested one. The
 * assessment/resolution logic and the routes branch on these exact strings.
 */
describe('completion vocabulary parity', () => {
  it('pins the assessment kinds', () => {
    expect([...COMPLETION_KINDS]).toEqual(['offer', 'not_ready', 'blocked_on_required']);
  });

  it('pins the unmet criteria', () => {
    expect([...UNMET_CRITERIA]).toEqual([
      'coverage_below_threshold',
      'below_min_answered',
      'required_unanswered',
    ]);
  });

  it('pins the respondent actions', () => {
    expect([...COMPLETION_ACTIONS]).toEqual(['accept', 'hold']);
  });
});
