import { describe, it, expect } from 'vitest';

import {
  countLaunchBlockers,
  hasLaunchBlockers,
} from '@/lib/app/questionnaire/authoring/launch-blockers';

/**
 * Guards the P3/P4 fork seam (F2.1 / PR2).
 *
 * `countLaunchBlockers` returns zeros until invitations (P3) and sessions (P4)
 * land. These tests pin that contract so the fork trigger can't accidentally fire
 * on phantom blockers before those models exist — the only live fork trigger in
 * PR2 is a version's `launched` status.
 */
describe('countLaunchBlockers', () => {
  it('reports no blockers today (P3/P4 seam)', async () => {
    await expect(countLaunchBlockers('version_abc')).resolves.toEqual({
      sessions: 0,
      invitations: 0,
    });
  });
});

describe('hasLaunchBlockers', () => {
  it('is false for the zero-blocker state', () => {
    expect(hasLaunchBlockers({ sessions: 0, invitations: 0 })).toBe(false);
  });

  it('is true when sessions are live', () => {
    expect(hasLaunchBlockers({ sessions: 1, invitations: 0 })).toBe(true);
  });

  it('is true when invitations are live', () => {
    expect(hasLaunchBlockers({ sessions: 0, invitations: 3 })).toBe(true);
  });
});
