/**
 * Unit tests for the route-local launch-blocker counter (`countLaunchBlockers`).
 *
 * File under test: app/api/v1/app/questionnaires/_lib/launch-blockers.ts
 *
 * This is the DB-touching half of the fork seam. The behaviour that matters (and that these tests
 * pin) is WHICH rows count as blockers: live invitations, and REAL respondent sessions only —
 * admin preview sessions (`isPreview: true`) must be excluded so a preview never forces a fork.
 * Prisma is mocked at the client boundary; we assert the queries issued and the shape returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireInvitation: { count: vi.fn() },
  appQuestionnaireSession: { count: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { countLaunchBlockers } from '@/app/api/v1/app/questionnaires/_lib/launch-blockers';
import { INVITATION_BLOCKER_STATUSES } from '@/lib/app/questionnaire/invitations';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(0);
  prismaMock.appQuestionnaireSession.count.mockResolvedValue(0);
});

describe('countLaunchBlockers', () => {
  it('counts only real respondent sessions (excludes admin preview sessions)', async () => {
    prismaMock.appQuestionnaireSession.count.mockResolvedValue(4);

    const result = await countLaunchBlockers('ver-1');

    expect(result.sessions).toBe(4);
    // The session query filters to the version AND isPreview:false — a preview never pins.
    expect(prismaMock.appQuestionnaireSession.count).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', isPreview: false },
    });
  });

  it('counts live invitations by the blocker-status set', async () => {
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(2);

    const result = await countLaunchBlockers('ver-1');

    expect(result.invitations).toBe(2);
    expect(prismaMock.appQuestionnaireInvitation.count).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', status: { in: [...INVITATION_BLOCKER_STATUSES] } },
    });
  });

  it('returns zero blockers when a version has only preview sessions and no live invitations', async () => {
    // appQuestionnaireSession.count already resolves 0 under the isPreview:false filter — a version
    // whose only session is a preview reports no session blockers, so an edit stays in place.
    const result = await countLaunchBlockers('ver-1');

    expect(result).toEqual({ invitations: 0, sessions: 0 });
  });
});
