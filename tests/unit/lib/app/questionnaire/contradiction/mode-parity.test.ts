import { describe, expect, it } from 'vitest';

import { CONTRADICTION_MODES } from '@/lib/app/questionnaire/types';
import {
  CONTRADICTION_MODES as REEXPORTED_MODES,
  CONTRADICTION_SEVERITIES,
} from '@/lib/app/questionnaire/contradiction';

/**
 * The detector's vocabulary must stay in lock-step with the shared config enum and
 * its own contract enum, so a change to either (e.g. adding a `sweep_only` mode, or
 * a new severity band) is a conscious, tested one — the analogue of the
 * answer-provenance parity test.
 */
describe('contradiction vocabulary parity', () => {
  it('re-exports the shared CONTRADICTION_MODES tuple unchanged', () => {
    expect([...REEXPORTED_MODES]).toEqual([...CONTRADICTION_MODES]);
  });

  it('pins the committed mode vocabulary (off/flag/probe)', () => {
    expect([...CONTRADICTION_MODES].sort()).toEqual(['flag', 'off', 'probe']);
  });

  it('pins the severity vocabulary (low/medium/high)', () => {
    expect([...CONTRADICTION_SEVERITIES]).toEqual(['low', 'medium', 'high']);
  });
});
