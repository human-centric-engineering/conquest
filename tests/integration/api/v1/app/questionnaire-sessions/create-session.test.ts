/**
 * Integration test: the session-create seam (F6.1, PR3).
 *
 * Prisma + the `recordSessionCreated` seam are mocked ($transaction invokes its callback
 * against a tx mock). Pins the create logic: invitation ownership + status gates, the
 * anonymousMode gate on the direct path, the launched-version requirement, idempotent
 * resume of a non-terminal session, and the atomic create → created-event → invitation
 * advance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    appQuestionnaireSession: { create: vi.fn(), deleteMany: vi.fn() },
    appQuestionnaireInvitation: { update: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    appQuestionnaireInvitation: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
    appQuestionnaireSession: { findFirst: vi.fn() },
  };
  return { tx, prisma };
});
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

const seamMock = vi.hoisted(() => ({ recordSessionCreated: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => seamMock);

// Preview readiness seam — a launchable draft is previewable; the gate calls this for non-launched.
const launchabilityMock = vi.hoisted(() => ({ loadLaunchReadiness: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/launchability', () => launchabilityMock);

import {
  createAnonymousSession,
  createPreviewSession,
  createSessionForVersion,
  createSessionFromInvitation,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'user-1';
const NEW_SESSION = { id: 'sess-new', status: 'active', versionId: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  (mocks.tx.appQuestionnaireSession.create as Mock).mockResolvedValue(NEW_SESSION);
  (mocks.tx.appQuestionnaireSession.deleteMany as Mock).mockResolvedValue({ count: 0 });
  (mocks.tx.appQuestionnaireInvitation.update as Mock).mockResolvedValue({});
  (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue(null);
  (seamMock.recordSessionCreated as Mock).mockResolvedValue(undefined);
  (launchabilityMock.loadLaunchReadiness as Mock).mockResolvedValue({ ready: true, checks: [] });
});

describe('createSessionFromInvitation', () => {
  const invitation = (overrides = {}) => ({
    id: 'inv-1',
    userId: USER,
    status: 'registered',
    versionId: 'v1',
    version: { status: 'launched' },
    ...overrides,
  });

  it('looks the invitation up by token hash', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());
    await createSessionFromInvitation('plaintext-token', USER);
    expect(mocks.prisma.appQuestionnaireInvitation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashInvitationToken('plaintext-token') } })
    );
  });

  it('creates the session, writes the created event, and advances the invitation to started', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());
    const result = await createSessionFromInvitation('tok', USER);

    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { versionId: 'v1', respondentUserId: USER, isPreview: false, status: 'active' },
      })
    );
    expect(seamMock.recordSessionCreated).toHaveBeenCalledWith('sess-new', { tx: mocks.tx });
    expect(mocks.tx.appQuestionnaireInvitation.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { status: 'started' },
    });
  });

  it('does not re-advance an invitation already in started (idempotent), still creating', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({ status: 'started' })
    );
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('404s an unknown token', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(null);
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'INVITATION_NOT_FOUND' });
  });

  it('403s an invitation bound to another user', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({ userId: 'someone-else' })
    );
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('409s an invitation not past accept (e.g. revoked/pending)', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({ status: 'revoked' })
    );
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toMatchObject({ ok: false, status: 409, code: 'INVITATION_NOT_STARTABLE' });
  });

  it('409s when the version is no longer launched', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({ version: { status: 'archived' } })
    );
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toMatchObject({ ok: false, status: 409, code: 'VERSION_NOT_LAUNCHED' });
  });

  it('resumes an existing non-terminal session instead of creating a second', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());
    (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue({
      id: 'sess-existing',
      status: 'paused',
      versionId: 'v1',
    });
    const result = await createSessionFromInvitation('tok', USER);
    expect(result).toEqual({
      ok: true,
      session: { id: 'sess-existing', status: 'paused', versionId: 'v1' },
      resumed: true,
    });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });
});

describe('createSessionForVersion (authed anonymous-direct)', () => {
  const version = (overrides = {}) => ({
    id: 'v1',
    status: 'launched',
    config: { accessMode: 'public' },
    ...overrides,
  });

  it('creates a session for a launched anonymousMode version + writes the created event', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    const result = await createSessionForVersion('v1', USER);

    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { versionId: 'v1', respondentUserId: USER, isPreview: false, status: 'active' },
      })
    );
    expect(seamMock.recordSessionCreated).toHaveBeenCalledWith('sess-new', { tx: mocks.tx });
  });

  it('404s an unknown or unlaunched version (no draft leak)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ status: 'draft' })
    );
    const result = await createSessionForVersion('v1', USER);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('403s a non-anonymous questionnaire (requires an invitation)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ config: { accessMode: 'invitation_only' } })
    );
    const result = await createSessionForVersion('v1', USER);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'INVITATION_REQUIRED' });
  });

  it('403s when no config row exists (anonymousMode defaults off)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ config: null })
    );
    const result = await createSessionForVersion('v1', USER);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'INVITATION_REQUIRED' });
  });

  it('resumes an existing non-terminal session', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue({
      id: 'sess-existing',
      status: 'active',
      versionId: 'v1',
    });
    const result = await createSessionForVersion('v1', USER);
    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });
});

describe('createAnonymousSession (no-login)', () => {
  const version = (overrides = {}) => ({
    id: 'v1',
    status: 'launched',
    config: { accessMode: 'public' },
    ...overrides,
  });

  it('creates a session with a NULL respondentUserId + the created event', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    const result = await createAnonymousSession('v1');

    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { versionId: 'v1', respondentUserId: null, isPreview: false, status: 'active' },
      })
    );
    expect(seamMock.recordSessionCreated).toHaveBeenCalledWith('sess-new', { tx: mocks.tx });
  });

  it('404s an unknown or unlaunched version', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ status: 'draft' })
    );
    const result = await createAnonymousSession('v1');
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('403s a non-anonymous questionnaire (requires an invitation)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ config: { accessMode: 'invitation_only' } })
    );
    const result = await createAnonymousSession('v1');
    expect(result).toMatchObject({ ok: false, status: 403, code: 'INVITATION_REQUIRED' });
  });
});

describe('createPreviewSession (admin preview)', () => {
  const version = (overrides = {}) => ({ id: 'v1', status: 'launched', ...overrides });

  it('creates a user-less isPreview session + a created event tagged admin_preview', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    const result = await createPreviewSession('v1');

    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { versionId: 'v1', respondentUserId: null, isPreview: true, status: 'active' },
      })
    );
    expect(seamMock.recordSessionCreated).toHaveBeenCalledWith('sess-new', {
      tx: mocks.tx,
      reason: 'admin_preview',
    });
  });

  it('replaces any prior preview for the version (one-preview-per-version index) before creating', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());

    await createPreviewSession('v1');

    // The fresh-walkthrough contract: drop the existing preview session (its turns/answers
    // cascade) so the insert can't collide on the partial unique index, then create anew.
    expect(mocks.tx.appQuestionnaireSession.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v1', isPreview: true },
    });
    const deleteOrder = (mocks.tx.appQuestionnaireSession.deleteMany as Mock).mock
      .invocationCallOrder[0];
    const createOrder = (mocks.tx.appQuestionnaireSession.create as Mock).mock
      .invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('previews a NON-anonymous version (no anonymous-mode gate) — the whole point', async () => {
    // The version has no anonymousMode/config at all; the anonymous + direct paths would 403,
    // preview must not. (Preview never selects config, so none is provided.)
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    const result = await createPreviewSession('v1');
    expect(result).toMatchObject({ ok: true });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown version', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(null);
    const result = await createPreviewSession('v1');
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('404s an archived (retired) version — never previewable', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ status: 'archived' })
    );
    const result = await createPreviewSession('v1');
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    // A retired version short-circuits before the readiness gate is consulted.
    expect(launchabilityMock.loadLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('409s a draft that is NOT launch-ready (complete the checklist first)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ status: 'draft' })
    );
    (launchabilityMock.loadLaunchReadiness as Mock).mockResolvedValue({ ready: false, checks: [] });
    const result = await createPreviewSession('v1');
    expect(result).toMatchObject({ ok: false, status: 409, code: 'NOT_READY_FOR_PREVIEW' });
    expect(launchabilityMock.loadLaunchReadiness).toHaveBeenCalledWith('v1');
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('previews a launch-READY draft (rehearse before going live) without launching', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(
      version({ status: 'draft' })
    );
    (launchabilityMock.loadLaunchReadiness as Mock).mockResolvedValue({ ready: true, checks: [] });
    const result = await createPreviewSession('v1');
    expect(result).toEqual({ ok: true, session: NEW_SESSION, resumed: false });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT consult the readiness gate for a launched version (always previewable)', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(version());
    await createPreviewSession('v1');
    expect(launchabilityMock.loadLaunchReadiness).not.toHaveBeenCalled();
  });
});
