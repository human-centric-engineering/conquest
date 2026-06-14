/**
 * isAnonymousVersion — unit tests (session ↔ invitation linkage invariant).
 *
 * The function queries Prisma for a version's config `anonymousMode` flag — the trigger for the
 * COMPLETION-TRACKING-ONLY invariant — and returns it, defaulting to false when the version or
 * config row is absent (config is 1:1 and lazy; an absent row means NOT anonymous).
 *
 * Test Coverage:
 * - Returns true when the version's config has anonymousMode: true
 * - Returns false when the version's config has anonymousMode: false
 * - Returns false (default) when the config row is absent (null)
 * - Returns false (default) when the version row is absent (null)
 * - Calls Prisma with the correct versionId and field selectors
 *
 * @see lib/app/questionnaire/invitations/linkage.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma before importing the module under test.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { isAnonymousVersion } from '@/lib/app/questionnaire/invitations/linkage';

describe('isAnonymousVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the config row has anonymousMode: true', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);
    await expect(isAnonymousVersion('v1')).resolves.toBe(true);
  });

  it('returns false when the config row has anonymousMode: false', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: false },
    } as never);
    await expect(isAnonymousVersion('v1')).resolves.toBe(false);
  });

  it('defaults to false when the config row is absent (lazy 1:1 config)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    await expect(isAnonymousVersion('v1')).resolves.toBe(false);
  });

  it('defaults to false when the version row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    await expect(isAnonymousVersion('missing')).resolves.toBe(false);
  });

  it('queries Prisma with the given versionId and selects only the anonymousMode flag', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);
    await isAnonymousVersion('v-123');
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'v-123' },
      select: { config: { select: { anonymousMode: true } } },
    });
  });
});
