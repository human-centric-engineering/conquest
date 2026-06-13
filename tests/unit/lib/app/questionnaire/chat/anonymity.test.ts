/**
 * resolveAnonymousForVersion — unit tests.
 *
 * The function queries Prisma for a version's config anonymousMode flag and returns
 * it, defaulting to false when the version or config row is absent.
 *
 * Test Coverage:
 * - Returns true when the version's config has anonymousMode: true
 * - Returns false when the version's config has anonymousMode: false
 * - Returns false (default) when the config row is absent (null)
 * - Returns false (default) when the version row is absent (null)
 * - Calls Prisma with the correct versionId and field selectors
 *
 * @see lib/app/questionnaire/chat/anonymity.ts
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
import {
  resolveAnonymousForVersion,
  resolvePresentationModeForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';

describe('resolveAnonymousForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the config row has anonymousMode: true', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert: the function unwraps the nested flag, not just echoes the object
    expect(result).toBe(true);
  });

  it('returns false when the config row has anonymousMode: false', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: false },
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert
    expect(result).toBe(false);
  });

  it('returns false (default) when config is null', async () => {
    // Arrange: config row absent but version exists
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert: ?? false default applies when config is null
    expect(result).toBe(false);
  });

  it('returns false (default) when the version itself is null', async () => {
    // Arrange: version not found
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    const result = await resolveAnonymousForVersion('ver-missing');

    // Assert: optional chaining on null returns undefined -> defaults to false
    expect(result).toBe(false);
  });

  it('queries Prisma with the correct versionId and selects only anonymousMode', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);

    // Act
    await resolveAnonymousForVersion('ver-xyz');

    // Assert: verify the shape of the DB call — not just that it was called
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'ver-xyz' },
      select: { config: { select: { anonymousMode: true } } },
    });
  });

  it('calls findUnique exactly once per invocation', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    await resolveAnonymousForVersion('ver-abc');

    // Assert: no redundant queries
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePresentationModeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored presentation mode (form / both)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'both' },
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('both');
  });

  it('defaults to chat when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('chat');
  });

  it('defaults to chat when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolvePresentationModeForVersion('ver-missing')).toBe('chat');
  });

  it('narrows an unrecognised stored value to chat', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'telepathy' },
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('chat');
  });

  it('selects only the presentationMode field for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'form' },
    } as never);
    await resolvePresentationModeForVersion('ver-xyz');
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'ver-xyz' },
      select: { config: { select: { presentationMode: true } } },
    });
  });
});
