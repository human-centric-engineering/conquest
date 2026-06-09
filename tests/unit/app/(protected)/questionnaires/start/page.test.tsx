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
 * Mock session bootstrap — the page's create/resume call.
 */
vi.mock('@/lib/app/questionnaire/chat/session-bootstrap', () => ({
  createOrResumeAuthedSession: vi.fn(),
}));

/**
 * Mock the F8.3 pre-create resolver — the page calls this (which hits Prisma)
 * before bootstrap to decide whether to collect a profile first. Defaulted to
 * `start-now` (the legacy straight-to-chat path); branch tests override it.
 */
vi.mock('@/lib/app/questionnaire/chat/start-context', () => ({
  loadStartContext: vi.fn(),
}));

/**
 * Mock the profile form — a client component the page renders for the
 * `needs-profile` branch. We only assert it is reached, not its internals.
 */
vi.mock('@/components/app/questionnaire/profile/profile-start-form', () => ({
  ProfileStartForm: vi.fn(({ invitationToken }: { invitationToken: string }) => (
    <div data-testid="profile-start-form" data-token={invitationToken} />
  )),
}));

import StartQuestionnairePage, { metadata } from '@/app/(protected)/questionnaires/start/page';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { isLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { createOrResumeAuthedSession } from '@/lib/app/questionnaire/chat/session-bootstrap';
import { loadStartContext } from '@/lib/app/questionnaire/chat/start-context';
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
    vi.mocked(loadStartContext).mockResolvedValue({ kind: 'start-now' });
    vi.mocked(createOrResumeAuthedSession).mockResolvedValue({
      ok: true,
      sessionId: 's1',
      resumed: false,
    });
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
  // F8.3 pre-create profile resolution
  // -------------------------------------------------------------------------

  describe('profile resolution (F8.3)', () => {
    it('redirects straight to the chat when a resumable session already exists', async () => {
      // Arrange: resolver finds a non-terminal session — skip the form entirely
      vi.mocked(loadStartContext).mockResolvedValue({ kind: 'resume', sessionId: 'resumed_1' });

      // Act & Assert: page redirects without creating a new session
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
        })
      ).rejects.toThrow('NEXT_REDIRECT:/questionnaires/resumed_1');
      expect(redirect).toHaveBeenCalledWith('/questionnaires/resumed_1');
      // Bootstrap is bypassed — the existing session is reused
      expect(createOrResumeAuthedSession).not.toHaveBeenCalled();
    });

    it('renders the profile form when the version needs a profile and no session exists', async () => {
      // Arrange: resolver asks for profile collection before session creation
      vi.mocked(loadStartContext).mockResolvedValue({
        kind: 'needs-profile',
        profileFields: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }],
      });

      // Act
      const Component = await StartQuestionnairePage({
        searchParams: makeSearchParams({ invitationToken: 'tok_xyz' }),
      });
      render(Component);

      // Assert: the form is rendered with the invitation token; bootstrap is deferred
      // to the form's submit (the page does not create the session itself here)
      const form = screen.getByTestId('profile-start-form');
      expect(form).toHaveAttribute('data-token', 'tok_xyz');
      expect(createOrResumeAuthedSession).not.toHaveBeenCalled();
    });

    it('falls through to bootstrap for a needs-profile context on the versionId surface', async () => {
      // Arrange: needs-profile but the request is versionId (no invitationToken) — the
      // page guards the form render on `'invitationToken' in request`, so it must NOT
      // render the form and instead create the session normally.
      vi.mocked(loadStartContext).mockResolvedValue({
        kind: 'needs-profile',
        profileFields: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }],
      });

      // Act & Assert: version-direct path creates the session despite needs-profile
      await expect(
        StartQuestionnairePage({
          searchParams: makeSearchParams({ versionId: 'ver_abc' }),
        })
      ).rejects.toThrow('NEXT_REDIRECT:/questionnaires/s1');
      expect(createOrResumeAuthedSession).toHaveBeenCalledWith({ versionId: 'ver_abc' });
    });
  });
});
