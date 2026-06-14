/**
 * resolveAdminPreviewMeta — unit tests.
 *
 * The function looks up the questionnaireId, versionNumber, and status for a
 * version, then builds the admin workspace URL and returns it alongside the
 * version detail the preview banner names. It returns null when the version no
 * longer exists.
 *
 * Test Coverage:
 * - Returns the workspace URL plus versionNumber + status when the version is found
 * - Returns null when the version is not found
 * - Calls Prisma with the correct versionId and field selector
 * - Delegates URL construction to workspaceVersionBase with correct arguments
 *
 * @see lib/app/questionnaire/chat/preview-nav.ts
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

// Mock workspace-nav so we can assert the correct arguments are forwarded and
// keep the test decoupled from URL-building implementation details.
vi.mock('@/lib/app/questionnaire/workspace-nav', () => ({
  workspaceVersionBase: vi.fn(
    (questionnaireId: string, versionId: string) =>
      `/admin/questionnaires/${questionnaireId}/v/${versionId}`
  ),
}));

import { prisma } from '@/lib/db/client';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { resolveAdminPreviewMeta } from '@/lib/app/questionnaire/chat/preview-nav';

describe('resolveAdminPreviewMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the workspace URL plus version number and status when the version exists', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      questionnaireId: 'qn-1',
      versionNumber: 3,
      status: 'launched',
    } as never);

    // Act
    const result = await resolveAdminPreviewMeta('ver-1');

    // Assert: the function computes a URL from the fetched questionnaireId and
    // carries the version detail the banner names — not just the URL.
    expect(result).toEqual({
      exitHref: '/admin/questionnaires/qn-1/v/ver-1',
      versionNumber: 3,
      status: 'launched',
    });
  });

  it('returns null when the version does not exist', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    const result = await resolveAdminPreviewMeta('ver-missing');

    // Assert: early return on null version
    expect(result).toBeNull();
  });

  it('queries Prisma with the correct versionId and selects only the banner fields', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'draft',
    } as never);

    // Act
    await resolveAdminPreviewMeta('ver-1');

    // Assert: minimal projection — not a full-row fetch
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'ver-1' },
      select: { questionnaireId: true, versionNumber: true, status: true },
    });
  });

  it('forwards both questionnaireId and versionId to workspaceVersionBase', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      questionnaireId: 'qn-42',
      versionNumber: 2,
      status: 'draft',
    } as never);

    // Act
    await resolveAdminPreviewMeta('ver-99');

    // Assert: the lookup result (questionnaireId) and the original param (versionId) are
    // both threaded into the URL builder — not hardcoded or swapped
    expect(workspaceVersionBase).toHaveBeenCalledWith('qn-42', 'ver-99');
  });

  it('does not call workspaceVersionBase when the version is missing', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    await resolveAdminPreviewMeta('ver-missing');

    // Assert: early-return prevents the URL build from running
    expect(workspaceVersionBase).not.toHaveBeenCalled();
  });

  it('calls findUnique exactly once per invocation', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'draft',
    } as never);

    // Act
    await resolveAdminPreviewMeta('ver-1');

    // Assert
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledTimes(1);
  });
});
