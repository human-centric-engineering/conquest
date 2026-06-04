import { describe, it, expect } from 'vitest';

import { hasLaunchBlockers } from '@/lib/app/questionnaire/authoring/launch-blockers';

/**
 * The PURE half of the fork seam (F2.1 / PR2). `countLaunchBlockers` moved
 * route-local once it needed Prisma (F3.2 — see
 * `app/api/v1/app/questionnaires/_lib/launch-blockers.ts`, covered by the status +
 * fork integration tests); this module now only owns the `hasLaunchBlockers`
 * predicate over the `LaunchBlockers` shape.
 */
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
