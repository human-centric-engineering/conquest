/**
 * Unit tests for the per-version soft-archive writer (`setVersionArchived`).
 *
 * Covers the state machine + side effects against a mocked prisma + audit logger:
 *   - archive a live version → stamps archivedAt, audits `questionnaire_version.archive`;
 *   - restore an archived version → clears archivedAt, audits `questionnaire_version.restore`;
 *   - idempotent no-ops (already in the requested state) → no write, no duplicate audit;
 *   - a missing version → returns null (the route 404s), no write.
 *
 * @see app/api/v1/app/questionnaires/_lib/version-archive.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

import { setVersionArchived } from '@/app/api/v1/app/questionnaires/_lib/version-archive';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const AUDIT = { userId: 'admin-1', clientIp: '203.0.113.7' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setVersionArchived — archive', () => {
  it('stamps archivedAt and audits when a live version is archived', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: null,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });
    const stamped = new Date('2026-07-17T00:00:00.000Z');
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ archivedAt: stamped });

    const result = await setVersionArchived('v1', true, AUDIT);

    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { archivedAt: expect.any(Date) },
      select: { archivedAt: true },
    });
    expect(result).toEqual({ id: 'v1', archivedAt: stamped.toISOString() });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'questionnaire_version.archive',
        entityType: 'questionnaire_version',
        entityId: 'v1',
        metadata: { questionnaireId: 'qn-1', versionNumber: 2 },
        clientIp: '203.0.113.7',
      })
    );
  });

  it('is a no-op when the version is already archived (idempotent)', async () => {
    const already = new Date('2026-07-01T00:00:00.000Z');
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: already,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });

    const result = await setVersionArchived('v1', true, AUDIT);

    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'v1', archivedAt: already.toISOString() });
  });
});

describe('setVersionArchived — restore', () => {
  it('clears archivedAt and audits when an archived version is restored', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: new Date('2026-07-01T00:00:00.000Z'),
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ archivedAt: null });

    const result = await setVersionArchived('v1', false, AUDIT);

    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { archivedAt: null },
      select: { archivedAt: true },
    });
    expect(result).toEqual({ id: 'v1', archivedAt: null });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.restore', entityId: 'v1' })
    );
  });

  it('is a no-op when the version is already active (idempotent)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: null,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });

    const result = await setVersionArchived('v1', false, AUDIT);

    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'v1', archivedAt: null });
  });
});

describe('setVersionArchived — missing version', () => {
  it('returns null without writing when the version does not exist', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(null);

    const result = await setVersionArchived('nope', true, AUDIT);

    expect(result).toBeNull();
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
