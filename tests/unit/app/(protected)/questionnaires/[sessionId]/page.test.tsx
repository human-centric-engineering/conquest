/**
 * QuestionnaireSessionPage Tests
 *
 * Tests the authenticated respondent chat surface (F7.1) Server Component.
 *
 * Test Coverage:
 * - Feature flag off → notFound()
 * - No session → clearInvalidSession called with correct return URL
 * - DB row not found → notFound()
 * - Row belongs to a different user → notFound() (ownership 404 — key authz test)
 * - Valid owned active session, no prior answers → QuestionnaireChat with initialStatus='idle', fresh welcome
 * - Valid owned active session, answers exist → resumed welcome copy
 * - Completed session → initialStatus='completed' (terminal-positive, F7.3)
 * - Abandoned session → initialStatus='not_active'
 * - voiceInputEnabled flag propagated to QuestionnaireChat
 * - Page metadata title
 *
 * @see app/(protected)/questionnaires/[sessionId]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Mock next/navigation — notFound() throws a sentinel so page execution halts,
 * matching Next.js runtime behaviour.
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
 * Mock Prisma client — prevents real DB calls.
 */
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: {
      findUnique: vi.fn(),
    },
  },
}));

/**
 * Mock feature flags — default both to true (the happy path), individual tests
 * override as needed.
 */
vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isLiveSessionsEnabled: vi.fn(),
  isVoiceInputEnabled: vi.fn(),
}));

/**
 * Mock theme resolver — returns a minimal resolved theme.
 */
vi.mock('@/lib/app/questionnaire/chat/theme', () => ({
  resolveThemeForSession: vi.fn(),
}));

/**
 * Stub SessionWorkspace (chat + answer panel) — exposes all props via data-*
 * attributes so tests can assert on what the page passes without rendering the
 * full component tree.
 */
vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({
    sessionId,
    initialStatus,
    voiceInputEnabled,
    initialTurns,
    initialPanel,
    initialStatusView,
  }: {
    sessionId: string;
    initialStatus: string;
    voiceInputEnabled: boolean;
    initialTurns: Array<{ role: string; content: string }>;
    initialPanel?: Record<string, unknown>;
    initialStatusView?: Record<string, unknown>;
  }) => (
    <div
      data-testid="questionnaire-chat"
      data-session-id={sessionId}
      data-initial-status={initialStatus}
      data-voice-input-enabled={String(voiceInputEnabled)}
      data-initial-turns={JSON.stringify(initialTurns)}
      data-has-panel={initialPanel ? 'true' : 'false'}
      data-has-status-view={initialStatusView ? 'true' : 'false'}
    />
  ),
}));

/**
 * Mock the answer-panel read seam — the page SSR-seeds the panel via it; tests
 * default it to a minimal view (individual tests don't depend on its shape).
 */
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel', () => ({
  loadAnswerPanelState: vi.fn(),
}));

/**
 * Mock the session-status read seam (F7.3) — the page SSR-seeds the lifecycle
 * status via it, and derives the surface's initialStatus from the projected view.
 * Tests drive the scenario through this mock (see makeStatus); the real seam reads
 * the DB via buildTurnContext and is covered by status-route / session-status tests.
 */
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-status', () => ({
  loadSessionStatus: vi.fn(),
}));

/**
 * Stub BrandThemeProvider — renders children so the QuestionnaireChat stub
 * still appears in the tree.
 */
vi.mock('@/components/app/questionnaire/chat/brand-theme-provider', () => ({
  BrandThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import QuestionnaireSessionPage, {
  metadata,
} from '@/app/(protected)/questionnaires/[sessionId]/page';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { isLiveSessionsEnabled, isVoiceInputEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveThemeForSession } from '@/lib/app/questionnaire/chat/theme';
import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';
import { loadSessionStatus } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-status';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type { SessionStatus } from '@/lib/app/questionnaire/types';
import type React from 'react';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess_abc123';

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

const MOCK_THEME: ResolvedTheme = {
  ctaColor: '#5469d4',
  accentColor: '#5469d4',
  logoUrl: null,
  welcomeCopy:
    "It's a short conversation — answer in your own words and we'll take care of the rest.",
};

/** Build a minimal DB row for the session. Defaults to owned + active + no prior answers. */
function makeRow(
  overrides: {
    respondentUserId?: string;
    status?: string;
    answerCount?: number;
  } = {}
) {
  return {
    status: overrides.status ?? 'active',
    respondentUserId: overrides.respondentUserId ?? 'user_abc',
    _count: { answers: overrides.answerCount ?? 0 },
  };
}

/**
 * Build a minimal LoadedSessionStatus for the session-status seam mock. The page
 * derives initialStatus from `view.status`, so tests vary that to drive the mapping.
 */
function makeStatus(
  status: SessionStatus = 'active',
  cost: { tier: 'none' | 'soft' | 'hard' } | null = null
) {
  return {
    session: { id: SESSION_ID, respondentUserId: 'user_abc' },
    view: {
      status,
      completion: {
        kind: 'not_ready' as const,
        coverage: 0,
        answeredCount: 0,
        requiredUnansweredKeys: [],
        capReached: false,
      },
      cost,
      anonymous: false,
    },
  };
}

function makeParams(sessionId: string = SESSION_ID) {
  return Promise.resolve({ sessionId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuestionnaireSessionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    vi.mocked(isLiveSessionsEnabled).mockResolvedValue(true);
    vi.mocked(isVoiceInputEnabled).mockResolvedValue(false);
    vi.mocked(resolveThemeForSession).mockResolvedValue(MOCK_THEME);
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(makeRow() as never);
    vi.mocked(loadAnswerPanelState).mockResolvedValue({
      session: { id: SESSION_ID, respondentUserId: 'user_abc' },
      view: {
        status: 'active',
        scope: 'full_progress',
        sections: [],
        answeredCount: 0,
        totalCount: 0,
      },
    });
    vi.mocked(loadSessionStatus).mockResolvedValue(makeStatus('active'));
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has the correct title', () => {
      // Assert: the page exports the right metadata — no rendering needed
      expect(metadata.title).toBe('Questionnaire');
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
      await expect(QuestionnaireSessionPage({ params: makeParams() })).rejects.toThrow(
        'NEXT_NOT_FOUND'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Authentication guard
  // -------------------------------------------------------------------------

  describe('authentication guard', () => {
    it('calls clearInvalidSession with the session URL when no session exists', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(null);

      // Act & Assert
      await expect(QuestionnaireSessionPage({ params: makeParams() })).rejects.toThrow(
        'NEXT_REDIRECT'
      );
      expect(clearInvalidSession).toHaveBeenCalledWith(`/questionnaires/${SESSION_ID}`);
    });
  });

  // -------------------------------------------------------------------------
  // DB row guards
  // -------------------------------------------------------------------------

  describe('row existence guard', () => {
    it('calls notFound when the DB row does not exist', async () => {
      // Arrange: session valid, but no row in the DB
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(null);

      // Act & Assert
      await expect(QuestionnaireSessionPage({ params: makeParams() })).rejects.toThrow(
        'NEXT_NOT_FOUND'
      );
    });
  });

  describe('ownership guard', () => {
    it('calls notFound when the row belongs to a different user (authz)', async () => {
      // Arrange: row exists but respondentUserId does not match the signed-in user
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ respondentUserId: 'user_OTHER' }) as never
      );

      // Act & Assert: the page 404s rather than revealing the session belongs to someone else
      await expect(QuestionnaireSessionPage({ params: makeParams() })).rejects.toThrow(
        'NEXT_NOT_FOUND'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful render — fresh session (no prior answers)
  // -------------------------------------------------------------------------

  describe('fresh active session', () => {
    it('renders QuestionnaireChat with initialStatus=idle when session is active', async () => {
      // Arrange: active session, no prior answers (defaults from beforeEach)

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: the route derived initialStatus from row.status, not just passed it through
      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-initial-status', 'idle');
      // The SSR-loaded status view is threaded down as initialStatusView (F7.3)
      expect(chat).toHaveAttribute('data-has-status-view', 'true');
    });

    it('passes the correct sessionId to QuestionnaireChat', async () => {
      // Arrange (defaults)

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: session ID from params flows through to the child component
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        SESSION_ID
      );
    });

    it('passes a non-resumed welcome turn (fresh session)', async () => {
      // Arrange: zero prior answers — the page should use the intro copy, not the resume copy

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: the welcome turn is a fresh greeting (not the resume acknowledgement)
      const chat = screen.getByTestId('questionnaire-chat');
      const turns = JSON.parse(chat.getAttribute('data-initial-turns') ?? '[]') as Array<{
        role: string;
        content: string;
      }>;
      expect(turns).toHaveLength(1);
      expect(turns[0].role).toBe('assistant');
      // Fresh greeting: does NOT contain the resume phrase
      expect(turns[0].content).not.toContain('Welcome back');
      // Fresh greeting: contains the theme's welcomeCopy
      expect(turns[0].content).toContain(MOCK_THEME.welcomeCopy);
    });
  });

  // -------------------------------------------------------------------------
  // Resumed session (answers already exist)
  // -------------------------------------------------------------------------

  describe('resumed session', () => {
    it('passes a resume welcome turn when the session has prior answers', async () => {
      // Arrange: session has existing answers
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ answerCount: 3 }) as never
      );

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: page computed resumed=true and built the resume turn
      const chat = screen.getByTestId('questionnaire-chat');
      const turns = JSON.parse(chat.getAttribute('data-initial-turns') ?? '[]') as Array<{
        role: string;
        content: string;
      }>;
      expect(turns).toHaveLength(1);
      expect(turns[0].role).toBe('assistant');
      // Resume greeting distinguishes itself from the fresh greeting
      expect(turns[0].content).toContain('Welcome back');
    });
  });

  // -------------------------------------------------------------------------
  // Non-active session status
  // -------------------------------------------------------------------------

  describe('non-active session status', () => {
    it('passes initialStatus=completed when the session is completed', async () => {
      // Arrange: completed session — F7.3 maps this to the distinct terminal-positive
      // 'completed' status (completion confirmation), not the generic 'not_active'.
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'completed' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(makeStatus('completed'));

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: the page derived 'completed' from the status view, not 'not_active'
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'completed'
      );
    });

    it('passes initialStatus=not_active when the session is abandoned', async () => {
      // Arrange
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'abandoned' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(makeStatus('abandoned'));

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'not_active'
      );
    });

    it('maps a budget-paused session (hard cost tier) to cost_capped', async () => {
      // Arrange: paused with a hard cost tier — terminal, not a resumable respondent pause
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'paused' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(makeStatus('paused', { tier: 'hard' }));

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'cost_capped'
      );
    });

    it('maps a respondent-paused session (non-hard tier) to not_active', async () => {
      // Arrange: paused without a hard cost tier — resumable, the lifecycle bar offers Resume
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'paused' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(makeStatus('paused', { tier: 'soft' }));

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'not_active'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Status-view fallback — when loadSessionStatus didn't resolve a view
  // -------------------------------------------------------------------------

  describe('status-view fallback', () => {
    it('falls back to idle from the row status when the status view is unavailable', async () => {
      // Arrange: active row, but the status seam returned null (e.g. transient)
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'active' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(null);

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: row.status === 'active' → idle fallback
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'idle'
      );
    });

    it('falls back to not_active from a non-active row when the status view is unavailable', async () => {
      // Arrange: non-active row + null status view
      vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(
        makeRow({ status: 'completed' }) as never
      );
      vi.mocked(loadSessionStatus).mockResolvedValue(null);

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: row.status !== 'active' → not_active fallback
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-initial-status',
        'not_active'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Voice input flag propagation
  // -------------------------------------------------------------------------

  describe('voiceInputEnabled flag', () => {
    it('passes voiceInputEnabled=true when the flag is on', async () => {
      // Arrange
      vi.mocked(isVoiceInputEnabled).mockResolvedValue(true);

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert: the resolved flag value reaches the chat component
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-voice-input-enabled',
        'true'
      );
    });

    it('passes voiceInputEnabled=false when the flag is off', async () => {
      // Arrange: flag already defaulted to false in beforeEach

      // Act
      const Component = await QuestionnaireSessionPage({ params: makeParams() });
      render(Component);

      // Assert
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-voice-input-enabled',
        'false'
      );
    });
  });
});
