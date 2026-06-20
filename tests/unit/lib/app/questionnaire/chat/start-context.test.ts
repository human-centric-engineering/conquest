/**
 * loadStartContext — the F8.3 pre-create resolver for the authenticated respondent
 * surface. It decides, without writing anything, whether the `start` page should:
 *   - go straight to chat because a resumable session already exists (`resume`),
 *   - collect a respondent profile first (`needs-profile`), or
 *   - create/resume immediately (`start-now`) — the anonymous / no-profile path.
 *
 * Only Prisma is mocked; the pure helpers (`hashInvitationToken`, `parseProfileFields`)
 * run for real so the test exercises the genuine token-hash → invitation lookup and the
 * real config parsing. The privacy-critical guarantee under test: an anonymous version
 * NEVER reaches `needs-profile`, so no PII is collected for an anonymous questionnaire.
 *
 * @see lib/app/questionnaire/chat/start-context.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — Prisma only; pure helpers run unmocked.
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireInvitation: {
      findUnique: vi.fn(),
    },
    appQuestionnaireSession: {
      findFirst: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { loadStartContext } from '@/lib/app/questionnaire/chat/start-context';
import { prisma } from '@/lib/db/client';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

const mockInvitationFindUnique = vi.mocked(prisma.appQuestionnaireInvitation.findUnique);
const mockSessionFindFirst = vi.mocked(prisma.appQuestionnaireSession.findFirst);

const RESPONDENT_ID = 'user_respondent_1';

/** One required profile field — the minimal "this version collects a profile" config. */
const PROFILE_FIELDS: ProfileFieldConfig[] = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
];

/**
 * Shape the invitation `findUnique` returns (matching the route's `select`): the
 * version id plus the nested config flags the resolver reads.
 */
function invitationRow(opts: {
  versionId?: string;
  anonymousMode?: boolean;
  profileFields?: unknown;
  config?: unknown;
  roundId?: string | null;
}) {
  const {
    versionId = 'ver_1',
    anonymousMode = false,
    profileFields = PROFILE_FIELDS,
    roundId = null,
  } = opts;
  // `as never` — the source uses a Prisma `select`, so the real return is a partial of
  // the full model; the project convention for partial-select mocks is to cast (see
  // tests/unit/lib/app/questionnaire/chat/theme.test.ts).
  return {
    versionId,
    roundId,
    version: {
      config: 'config' in opts ? opts.config : { anonymousMode, profileFields },
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadStartContext', () => {
  describe('version-direct (anonymous) surface', () => {
    it('returns start-now without any DB lookup when the request carries no invitationToken', async () => {
      // Arrange: a versionId request is the anonymous "anyone may answer" path.

      // Act
      const result = await loadStartContext({ versionId: 'ver_anon' }, RESPONDENT_ID);

      // Assert: never collects a profile; no invitation/session query is issued
      expect(result).toEqual({ kind: 'start-now' });
      expect(mockInvitationFindUnique).not.toHaveBeenCalled();
      expect(mockSessionFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('invitation surface', () => {
    it('hashes the token and looks up the invitation by tokenHash (never the raw token)', async () => {
      // Arrange
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ anonymousMode: false, profileFields: PROFILE_FIELDS })
      );
      mockSessionFindFirst.mockResolvedValue(null);

      // Act
      await loadStartContext({ invitationToken: 'plain-token-abc' }, RESPONDENT_ID);

      // Assert: the lookup is keyed on a hash, and the raw token is never the key
      expect(mockInvitationFindUnique).toHaveBeenCalledTimes(1);
      const where = mockInvitationFindUnique.mock.calls[0][0].where as { tokenHash: string };
      expect(where.tokenHash).toBeDefined();
      expect(where.tokenHash).not.toBe('plain-token-abc');
    });

    it('returns start-now when the invitation is not found', async () => {
      // Arrange: an unknown / revoked token resolves to null — fall through to create
      // route, which owns the real error reporting.
      mockInvitationFindUnique.mockResolvedValue(null);

      // Act
      const result = await loadStartContext({ invitationToken: 'unknown' }, RESPONDENT_ID);

      // Assert
      expect(result).toEqual({ kind: 'start-now' });
      expect(mockSessionFindFirst).not.toHaveBeenCalled();
    });

    it('returns start-now for an anonymous version even when profile fields are configured', async () => {
      // Arrange: anonymousMode wins — the privacy guarantee is that an anonymous
      // version never collects PII, regardless of stray profileFields config.
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ anonymousMode: true, profileFields: PROFILE_FIELDS })
      );

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert: no profile collection, and no resumable-session lookup either
      expect(result).toEqual({ kind: 'start-now' });
      expect(mockSessionFindFirst).not.toHaveBeenCalled();
    });

    it('returns start-now for a non-anonymous version with no profile fields', async () => {
      // Arrange: nothing to collect
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ anonymousMode: false, profileFields: [] })
      );

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert
      expect(result).toEqual({ kind: 'start-now' });
      expect(mockSessionFindFirst).not.toHaveBeenCalled();
    });

    it('treats a missing config row as "no profile to collect" (start-now)', async () => {
      // Arrange: a version with no config row → config is null
      mockInvitationFindUnique.mockResolvedValue(invitationRow({ config: null }));

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert: null config defaults to anonymous=false, profileFields=[] → start-now
      expect(result).toEqual({ kind: 'start-now' });
    });

    it('resumes an existing non-terminal session instead of collecting the profile again', async () => {
      // Arrange: non-anonymous + profile fields, but the respondent already has a session
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ versionId: 'ver_42', anonymousMode: false, profileFields: PROFILE_FIELDS })
      );
      mockSessionFindFirst.mockResolvedValue({ id: 'sess_existing' } as never);

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert: skip the form, reuse the session
      expect(result).toEqual({ kind: 'resume', sessionId: 'sess_existing' });
      // The resumable lookup is scoped to this version + respondent and non-preview
      const where = mockSessionFindFirst.mock.calls[0][0]!.where as Record<string, unknown>;
      expect(where).toMatchObject({
        versionId: 'ver_42',
        respondentUserId: RESPONDENT_ID,
        isPreview: false,
        status: { in: ['active', 'paused'] },
        // A non-round invitation resumes only non-round (roundId: null) sessions.
        roundId: null,
      });
    });

    it('scopes the resumable lookup to the invitation’s round (round-bound invitation)', async () => {
      // Cohorts & Rounds: a round-bound invitation must resume only the SAME round's session —
      // mirroring createSessionFromInvitation, so the start page and create route agree on
      // resumability (the divergence resumable-session.ts forbids).
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({
          versionId: 'ver_42',
          anonymousMode: false,
          profileFields: PROFILE_FIELDS,
          roundId: 'round_7',
        })
      );
      mockSessionFindFirst.mockResolvedValue({ id: 'sess_round' } as never);

      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      expect(result).toEqual({ kind: 'resume', sessionId: 'sess_round' });
      const where = mockSessionFindFirst.mock.calls[0][0]!.where as Record<string, unknown>;
      expect(where).toMatchObject({ versionId: 'ver_42', roundId: 'round_7' });
    });

    it('returns needs-profile with the parsed fields when collection is required and no session exists', async () => {
      // Arrange: non-anonymous + profile fields + no resumable session
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ anonymousMode: false, profileFields: PROFILE_FIELDS })
      );
      mockSessionFindFirst.mockResolvedValue(null);

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert: the form is requested and carries the real parsed field config
      expect(result).toEqual({ kind: 'needs-profile', profileFields: PROFILE_FIELDS });
    });

    it('drops a malformed profileFields column to "no fields" → start-now', async () => {
      // Arrange: a corrupt config column — parseProfileFields degrades to [] rather
      // than throwing, so the resolver must treat it as nothing to collect.
      mockInvitationFindUnique.mockResolvedValue(
        invitationRow({ anonymousMode: false, profileFields: { not: 'an array' } })
      );

      // Act
      const result = await loadStartContext({ invitationToken: 'tok' }, RESPONDENT_ID);

      // Assert
      expect(result).toEqual({ kind: 'start-now' });
      expect(mockSessionFindFirst).not.toHaveBeenCalled();
    });
  });
});
