import { describe, expect, it } from 'vitest';

import {
  CONTRADICTION_MODES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  resolveContradictionMode,
} from '@/lib/app/questionnaire/types';
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
    // `flag` is retired and unselectable, but it stays in the STORED vocabulary so existing rows and
    // older API/import payloads still parse. Removing it is what would break them — see the resolver
    // tests below. Only `off` and `probe` are offered in the admin picker.
    expect([...CONTRADICTION_MODES].sort()).toEqual(['flag', 'off', 'probe']);
  });

  it('pins the severity vocabulary (low/medium/high)', () => {
    expect([...CONTRADICTION_SEVERITIES]).toEqual(['low', 'medium', 'high']);
  });
});

/**
 * The single funnel every read of `contradictionMode` goes through. Its job is to make the retired
 * `flag` unreachable by the engine WITHOUT a data migration — so the two things worth pinning are
 * that it becomes `probe`, and that an unrecognised value can never quietly disable checking for a
 * questionnaire that asked for it.
 */
describe('resolveContradictionMode', () => {
  it('reads the retired `flag` as `probe`', () => {
    expect(resolveContradictionMode('flag')).toBe('probe');
  });

  it('passes the live values through unchanged', () => {
    expect(resolveContradictionMode('off')).toBe('off');
    expect(resolveContradictionMode('probe')).toBe('probe');
  });

  it('falls back to the shipped default for anything unrecognised', () => {
    // Including the shapes a JSON column can actually hand back.
    for (const value of ['sweep_only', '', undefined, null, 3, {}]) {
      expect(resolveContradictionMode(value)).toBe(DEFAULT_QUESTIONNAIRE_CONFIG.contradictionMode);
    }
  });

  it('maps `flag` BEFORE the enum check, so retiring it never turns checking off', () => {
    // The failure this guards: drop `flag` from CONTRADICTION_MODES and every stored `flag` row
    // falls through to the unknown-value default — silently disabling checking on exactly the
    // questionnaires that had it on. `flag` must resolve to a mode that still checks.
    expect(resolveContradictionMode('flag')).not.toBe('off');
  });
});
