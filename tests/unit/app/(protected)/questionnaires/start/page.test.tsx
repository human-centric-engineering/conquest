/**
 * StartQuestionnairePage Tests
 *
 * Tests the authenticated respondent entry point (F7.1) Server Component.
 *
 * Test Coverage:
 * - Feature flag off → notFound()
 * - No invitationToken and no versionId in searchParams → renders StartError "This link is incomplete"
 * - Token present but no session → clearInvalidSession called with returnUrl containing the token
 * - versionId present but no session → clearInvalidSession called with returnUrl containing versionId
 * - Bootstrap returns ok:true → redirect to /questionnaires/<sessionId>
 * - Bootstrap returns ok:false → renders StartError with the failure message
 * - Page metadata title
 *
 * @see app/(protected)/questionnaires/start/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Mock next/navigation — both notFound() and redirect() throw sentinels so page
 * execution halts, matching Next.js runtime behaviour.
 */
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

/**
 * Mock getServerSession — the page's auth check.
 */
vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

/**
 * Mock clearInvalidSession — throws a redirect sentinel when called so
 * callers can assert both that it was called and that execution stopped.
 */
vi.mock('@/lib/auth/clear-session', () => ({
  clearInvalidSession: vi.fn((returnUrl: string) => {
    throw new Error(
      `NEXT_REDIRECT:/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
    );
  }),
}));

/**
 * Mock feature flag — defaulted to true (happy path); individual tests override.
 */
vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isLiveSessionsEnabled: vi.fn(),
}));

/**
 * Mock session bootstrap — the page's create/resume call. Profile capture now rides the workspace
 * carousel (F-capture), so the page no longer resolves a pre-create profile context — it just
 * creates (or idempotently resumes) the session and redirects.
 */
vi.mock('@/lib/app/questionnaire/chat/session-bootstrap', () => ({
  createOrResumeAuthedSession: vi.fn(),
}));

/**
 * Mock the session-resume readers (F7.11). The versionId start path now checks for a resumable
 * session before creating; these resolvers are mocked so the default happy path (resume enabled,
 * nothing resumable) falls through to the create/redirect the existing tests assert.
 */
vi.mock('@/lib/app/questionnaire/chat/anonymity', () => ({
  resolveSessionResumeEnabledForVersion: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/chat/resumable-session', () => ({
  findAuthedResumeDetail: vi.fn(),
}));

import StartQuestionnairePage, { metadata } from '@/app/(protected)/questionnaires/start/page';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { isLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { createOrResumeAuthedSession } from '@/lib/app/questionnaire/chat/session-bootstrap';
import { resolveSessionResumeEnabledForVersion } from '@/lib/app/questionnaire/chat/anonymity';
import { findAuthedResumeDetail } from '@/lib/app/questionnaire/chat/resumable-session';
import { redirect } from 'next/navigation';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  session: {
    id: 'session_abc',
    userId: 'user_abc',
    expiresAt: new Date(Date.now() + 86_400_000),
    token: 'tok_abc',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  user: {
    id: 'user_abc',
    email: 'alice@example.com',
    name: 'Alice Example',
    emailVerified: true,
    image: null,
    role: 'USER' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

function makeSearchParams(params: { invitationToken?: string; versionId?: string }) {
  return Promise.resolve(params);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StartQuestionnairePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    vi.mocked(isLiveSessionsEnabled).mockResolvedValue(true);
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
      ok: true,
      sessionId: 's1',
      resumed: false,
    });
    // Resume defaults: enabled, but nothing resumable → the versionId path falls through to create.
    vi.mocked(resolveSessionResumeEnabledForVersion).mockResolvedValue(true);
    vi.mocked(findAuthedResumeDetail).mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has the correct title', () => {
      // Assert: the page exports the right metadata — no rendering needed
      expect(metadata.title).toBe('Start questionnaire');
    });
  });

  // -------------------------------------------------------------------------
  // Feature flag gate
  // -------------------------------------------------------------------------

  describe('feature flag gate', () => {
    it('calls notFound when live sessions are disabled', async () => {
      // Arrange
      vi.mocked(isLiveSessionsEnabled).mockResolvedValue(false);

      // Act & Assert: execution halts with the NEXT_NOT_FOUND sentinel
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
        })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // Missing access details (no token, no versionId)
  // -------------------------------------------------------------------------

  describe('incomplete link', () => {
    it('renders the "This link is incomplete" StartError when neither token nor versionId provided', async () => {
      // Arrange: flag on, no access details in the URL
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue(
        // Should never be called — but if it is, fail loudly
        { ok: false, code: 'NEVER', message: 'should not be called' }
      );

      // Act
      const Component = await StartQuestionnairePage({
        searchParams: makeSearchParams({}),
      });
      render(Component);

      // Assert: friendly error is rendered; bootstrap is NOT called
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'This link is incomplete'
      );
      expect(createOrResumeAuthedSession).not.toHaveBeenCalled();
    });

    it('does not call getServerSession when there are no access details', async () => {
      // Arrange

      // Act
      await StartQuestionnairePage({ searchParams: makeSearchParams({}) });

      // Assert: auth check is skipped — no session lookup before we know what to start
      expect(getServerSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Authentication guard — no session, token present
  // -------------------------------------------------------------------------

  describe('authentication guard', () => {
    it('calls clearInvalidSession with returnUrl containing the invitationToken when no session', async () => {
      // Arrange: token present, but not logged in
      vi.mocked(getServerSession).mockResolvedValue(null);
      const token = 'invite_abc';

      // Act & Assert
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ invitationToken: token }),
        })
      ).rejects.toThrow('NEXT_REDIRECT');
      expect(clearInvalidSession).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(token))
      );
    });

    it('calls clearInvalidSession with returnUrl containing the versionId when no session', async () => {
      // Arrange: versionId present, but not logged in
      vi.mocked(getServerSession).mockResolvedValue(null);
      const versionId = 'ver_xyz';

      // Act & Assert
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ versionId }),
        })
      ).rejects.toThrow('NEXT_REDIRECT');
      expect(clearInvalidSession).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(versionId))
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful bootstrap → redirect
  // -------------------------------------------------------------------------

  describe('successful bootstrap', () => {
    it('redirects to /questionnaires/<sessionId> when bootstrap returns ok:true', async () => {
      // Arrange: bootstrap succeeds with session ID 's1'
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
        ok: true,
        sessionId: 's1',
        resumed: false,
      });

      // Act & Assert: the page calls redirect to the chat surface
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
        })
      ).rejects.toThrow('NEXT_REDIRECT:/questionnaires/s1');
      // Confirm the redirect helper was invoked with the correct path
      expect(redirect).toHaveBeenCalledWith('/questionnaires/s1');
    });

    it('redirects using versionId path when bootstrap succeeds via versionId', async () => {
      // Arrange
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
        ok: true,
        sessionId: 'sess_v2',
        resumed: true,
      });

      // Act & Assert
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ versionId: 'ver_abc' }),
        })
      ).rejects.toThrow('NEXT_REDIRECT:/questionnaires/sess_v2');
      expect(redirect).toHaveBeenCalledWith('/questionnaires/sess_v2');
    });

    it('renders the resume chooser (no create/redirect) when a resumable session with progress exists', async () => {
      // Arrange: resume enabled + an in-progress session with real progress on the versionId path.
      vi.mocked(findAuthedResumeDetail).mockResolvedValue({
        sessionId: 'sess-resume',
        ref: '7F3K9M2P',
        answeredCount: 3,
      });

      // Act
      const result = await StartQuestionnairePage({
        searchParams: makeSearchParams({ versionId: 'ver_abc' }),
      });

      // Assert: short-circuits to the chooser — no silent create, no redirect.
      expect(createOrResumeAuthedSession).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(result?.props).toMatchObject({
        versionId: 'ver_abc',
        sessionId: 'sess-resume',
        refRaw: '7F3K9M2P',
        answeredCount: 3,
      });
    });

    it('falls through to create when resume is enabled but nothing is resumable', async () => {
      vi.mocked(findAuthedResumeDetail).mockResolvedValue(null);
      await expect(
        StartQuestionnairePage({ searchParams: makeSearchParams({ versionId: 'ver_abc' }) })
      ).rejects.toThrow('NEXT_REDIRECT:');
      expect(createOrResumeAuthedSession).toHaveBeenCalled();
    });

    it('falls through to create for a zero-progress session (no chooser for a barely-started returner)', async () => {
      // A resumable session exists but with no answers yet → below the >=1 threshold → resume silently.
      vi.mocked(findAuthedResumeDetail).mockResolvedValue({
        sessionId: 'sess-zero',
        ref: '7F3K9M2P',
        answeredCount: 0,
      });
      await expect(
        StartQuestionnairePage({ searchParams: makeSearchParams({ versionId: 'ver_abc' }) })
      ).rejects.toThrow('NEXT_REDIRECT:');
      expect(createOrResumeAuthedSession).toHaveBeenCalled();
    });

    it('skips the resume check when resume is disabled for the version', async () => {
      vi.mocked(resolveSessionResumeEnabledForVersion).mockResolvedValue(false);
      await expect(
        StartQuestionnairePage({ searchParams: makeSearchParams({ versionId: 'ver_abc' }) })
      ).rejects.toThrow('NEXT_REDIRECT:');
      expect(findAuthedResumeDetail).not.toHaveBeenCalled();
      expect(createOrResumeAuthedSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Failed bootstrap → StartError
  // -------------------------------------------------------------------------

  describe('failed bootstrap', () => {
    it('renders StartError with the failure message when bootstrap returns ok:false', async () => {
      // Arrange: bootstrap fails with a descriptive message
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
        ok: false,
        code: 'SESSION_CREATE_FAILED',
        message: 'nope',
      });

      // Act
      const Component = await StartQuestionnairePage({
        searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
      });
      render(Component);

      // Assert: the failure message from bootstrap is surfaced to the user (not swallowed)
      expect(screen.getByText('nope')).toBeInTheDocument();
      // The page wraps bootstrap failures in the "couldn't start" heading
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'We couldn’t start your questionnaire'
      );
    });

    it('still renders StartError when bootstrap message is a long descriptive string', async () => {
      // Arrange
      const message = 'The invitation link has expired. Please request a new one.';
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
        ok: false,
        code: 'INVITATION_EXPIRED',
        message,
      });

      // Act
      const Component = await StartQuestionnairePage({
        searchParams: makeSearchParams({ invitationToken: 'tok_expired' }),
      });
      render(Component);

      // Assert: full message is rendered verbatim
      expect(screen.getByText(message)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Resume is idempotent inside bootstrap (capture moved to the carousel — F-capture)
  // -------------------------------------------------------------------------

  describe('idempotent resume', () => {
    it('redirects to the resumed session (bootstrap reports resumed:true)', async () => {
      // Arrange: the create route returned an existing non-terminal session.
      vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
        ok: true,
        sessionId: 'resumed_1',
        resumed: true,
      });

      // Act & Assert: same redirect, no separate pre-create profile step.
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
        })
      ).rejects.toThrow('NEXT_REDIRECT:/questionnaires/resumed_1');
      expect(redirect).toHaveBeenCalledWith('/questionnaires/resumed_1');
      expect(createOrResumeAuthedSession).toHaveBeenCalledWith({ invitationToken: 'tok_xyz' });
    });
  });
});
