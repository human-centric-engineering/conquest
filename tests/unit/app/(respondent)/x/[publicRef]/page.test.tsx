// @vitest-environment happy-dom

/**
 * ExperienceRunPage Tests
 *
 * Tests the experience run surface (P15.3) Server Component — `/x/<publicRef>`, the ONE stable
 * address for a whole respondent journey. Resolves server-side via `resolveRunSurface` to
 * whichever leg the run is currently on.
 *
 * Test Coverage:
 * - `not_found` → notFound() is called and execution halts (no surface rendered)
 * - `no_credential` → the explanatory, non-accusatory notice renders and quotes the publicRef;
 *   RunSessionBoot is not rendered
 * - Success path: RunSessionBoot receives sessionId + accessToken from the resolved surface, and
 *   welcomeCopy from the resolved theme
 * - Cookie scanning: only `cq_run_`-prefixed cookie VALUES (never names) are forwarded to
 *   resolveRunSurface — the cookie name is untrusted input
 * - Per-leg resolution: the nine `resolve*ForVersion` helpers are called with the versionId FROM
 *   THE RESOLVED SURFACE (the current leg), not any other source — each leg may run a different
 *   questionnaire
 * - `sessionToken: null` (authenticated-respondent path) yields `accessToken={undefined}` on
 *   RunSessionBoot, never the string "null"
 * - Static metadata: `robots: { index: false, follow: false }` — a journey address must never be
 *   indexed
 *
 * @see app/(respondent)/x/[publicRef]/page.tsx
 * @see app/api/v1/app/experiences/_lib/run-surface.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';

/**
 * Mock next/navigation — notFound() throws a sentinel so page execution halts, matching Next.js
 * runtime behaviour (the global mock in tests/setup.ts is a no-op vi.fn() that does not throw).
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
 * Mock next/headers — overrides the global tests/setup.ts stub so each test controls exactly
 * which cookies `getAll()` reports.
 */
vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

/** Mock the access-control resolver — the contract this page depends on. */
vi.mock('@/app/api/v1/app/experiences/_lib/run-surface', () => ({
  resolveRunSurface: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/chat/theme', () => ({
  resolveThemeForVersion: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/header/resolve', () => ({
  resolveVersionHeader: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/chat/anonymity', () => ({
  resolveAnonymousForVersion: vi.fn(),
  resolveAnswerPanelScopeForVersion: vi.fn(),
  resolveAttachmentsEnabledForVersion: vi.fn(),
  resolveInlineCorrectionForVersion: vi.fn(),
  resolvePresentationModeForVersion: vi.fn(),
  resolveRespondentLayoutForVersion: vi.fn(),
  resolveRespondentDesignForVersion: vi.fn(),
  resolveRespondentChromeForVersion: vi.fn(),
  resolveReasoningDwellForVersion: vi.fn(),
  resolveReasoningPlacementForVersion: vi.fn(),
  resolveShowProgressPercentTextForVersion: vi.fn(),
  resolveChatTextScaleIndexForVersion: vi.fn(),
  resolveVoiceEnabledForVersion: vi.fn(),
  // P21: resolved server-side so the tab strip is present in the first paint. Defaults false here,
  // which is what every questionnaire that never opted in resolves to.
  resolveSectionedForVersion: vi.fn().mockResolvedValue(false),
}));

// The chrome is rendered by the page now, not inherited from a layout. Stubbed to a pass-through
// that surfaces the mode it was handed: the marketing nav inside the real one needs a router, and
// what these tests care about is that the page resolved the questionnaire's chrome and passed it —
// `respondent-chrome.test.tsx` covers what each mode actually draws.
vi.mock('@/components/app/questionnaire/chrome/respondent-chrome', () => ({
  RespondentChrome: ({
    mode,
    shell,
    children,
  }: {
    mode: string;
    shell?: boolean;
    children: React.ReactNode;
  }) => (
    // `shell` is surfaced, not swallowed: this page is the one caller that turns it OFF, and a stub
    // that quietly dropped the prop would let that removal pass every test in the file.
    <div data-testid="chrome" data-mode={mode} data-shell={String(shell ?? true)}>
      {children}
    </div>
  ),
}));

/**
 * Stub RunSessionBoot — exposes the props under test via data-* attributes so we can assert on
 * what the page passes without running client-side bootstrap logic. React omits a data-*
 * attribute entirely when its value is `undefined`, which is what lets the sessionToken-null test
 * distinguish "omitted" from the literal string "null".
 */
vi.mock('@/components/app/questionnaire/experiences/run-session-boot', () => ({
  RunSessionBoot: ({
    sessionId,
    accessToken,
    welcomeCopy,
    answerPanelScope,
  }: {
    sessionId: string;
    accessToken?: string;
    welcomeCopy?: string;
    answerPanelScope?: string;
  }) => (
    <div
      data-testid="run-session-boot"
      data-session-id={sessionId}
      data-access-token={accessToken}
      data-welcome-copy={welcomeCopy}
      data-answer-panel-scope={answerPanelScope}
    />
  ),
}));

/** Stub BrandThemeProvider — renders children so RunSessionBoot still appears in the tree. */
vi.mock('@/components/app/questionnaire/chat/brand-theme-provider', () => ({
  BrandThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ExperienceRunPage, { metadata } from '@/app/(respondent)/x/[publicRef]/page';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { resolveRunSurface } from '@/app/api/v1/app/experiences/_lib/run-surface';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import {
  resolveAnonymousForVersion,
  resolveAnswerPanelScopeForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveRespondentLayoutForVersion,
  resolveRespondentDesignForVersion,
  resolveRespondentChromeForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveShowProgressPercentTextForVersion,
  resolveChatTextScaleIndexForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import type { RunSurface } from '@/app/api/v1/app/experiences/_lib/run-surface';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PUBLIC_REF = 'abc12345';
const RUN_ID = 'run_xyz789';
const SESSION_ID = 'sess_leg2_abc';
// Deliberately distinct from PUBLIC_REF/SESSION_ID so a test that asserts a resolver was called
// with this value cannot be satisfied by accident.
const SURFACE_VERSION_ID = 'ver_leg2_current';
const ACCESS_TOKEN = 'tok_minted_for_leg2';

const MOCK_THEME: ResolvedTheme = {
  ctaColor: '#5469d4',
  accentColor: '#5469d4',
  logoUrl: null,
  bannerUrl: null,
  welcomeCopy: 'Welcome back — pick up right where you left off.',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
  hasBrandIdentity: false,
  canvasColor: null,
  onCanvas: null,
  canvasIsDark: false,
  canvasColorDark: null,
  onCanvasDark: null,
  accentColorEnd: null,
  logoMarkUrl: null,
  logoDarkUrl: null,
  bandLogoUrl: null,
  bandLogoDarkUrl: null,
  fontPairing: 'neutral',
  customFontDisplay: null,
  customFontBody: null,
  fontFaceCss: null,
};

const MOCK_SURFACE_OK: RunSurface = {
  ok: true,
  runId: RUN_ID,
  publicRef: PUBLIC_REF,
  status: 'active',
  sessionId: SESSION_ID,
  versionId: SURFACE_VERSION_ID,
  sessionToken: ACCESS_TOKEN,
};

function makeParams(publicRef: string = PUBLIC_REF) {
  return Promise.resolve({ publicRef });
}

/** Build the `next/headers` `cookies()` resolved value from a flat list of name/value pairs. */
function mockCookieJar(entries: Array<{ name: string; value: string }>) {
  // `next/headers`'s ReadonlyRequestCookies type is opaque; the page only calls `.getAll()`, so a
  // structural stub is cast the same way the rest of the suite casts cookie mocks (test files
  // have `@typescript-eslint/no-explicit-any` disabled — see eslint.config.mjs).
  vi.mocked(cookies).mockResolvedValue({ getAll: () => entries } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExperienceRunPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    mockCookieJar([]);
    vi.mocked(resolveRunSurface).mockResolvedValue(MOCK_SURFACE_OK);
    vi.mocked(resolveThemeForVersion).mockResolvedValue(MOCK_THEME);
    vi.mocked(resolveVersionHeader).mockResolvedValue({
      title: 'Current Leg Questionnaire',
      round: null,
    });
    vi.mocked(resolveAnonymousForVersion).mockResolvedValue(false);
    vi.mocked(resolvePresentationModeForVersion).mockResolvedValue('chat');
    vi.mocked(resolveRespondentLayoutForVersion).mockResolvedValue('classic');
    vi.mocked(resolveRespondentDesignForVersion).mockResolvedValue('rounded');
    vi.mocked(resolveRespondentChromeForVersion).mockResolvedValue('full');
    vi.mocked(resolveAnswerPanelScopeForVersion).mockResolvedValue('full_progress');
    vi.mocked(resolveVoiceEnabledForVersion).mockResolvedValue(true);
    vi.mocked(resolveAttachmentsEnabledForVersion).mockResolvedValue(true);
    vi.mocked(resolveReasoningPlacementForVersion).mockResolvedValue('overlay');
    vi.mocked(resolveReasoningDwellForVersion).mockResolvedValue({ dwellMs: 2000, perItemMs: 330 });
    vi.mocked(resolveInlineCorrectionForVersion).mockResolvedValue(true);
    vi.mocked(resolveShowProgressPercentTextForVersion).mockResolvedValue(true);
    vi.mocked(resolveChatTextScaleIndexForVersion).mockResolvedValue(1);
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('never indexes a respondent journey address', () => {
      // A journey URL is short, human-quotable, and respondent-private — indexing it would leak
      // the existence (and possibly content) of a private conversation to search engines.
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('keeps ConQuest out of the tab title, since a run can be white-labelled', () => {
      // The `(respondent)` layout applies a " - ConQuest" title template to any plain title string.
      // A run is a whole journey and may be presented as the client's own; the page honours that
      // for everything drawn on it, and the tab is the one surface the page cannot repaint. So the
      // title is ABSOLUTE, which is what opts out of the template.
      expect(metadata.title).toEqual({ absolute: 'Your conversation' });
    });
  });

  // -------------------------------------------------------------------------
  // not_found → notFound()
  // -------------------------------------------------------------------------

  describe('when the ref resolves to no run (not_found)', () => {
    it('calls notFound() and halts execution rather than rendering a surface', async () => {
      vi.mocked(resolveRunSurface).mockResolvedValue({ ok: false, reason: 'not_found' });

      // notFound() throws in the real Next.js runtime; the local mock reproduces that so we can
      // assert the page never falls through to render anything after calling it.
      await expect(ExperienceRunPage({ params: makeParams() })).rejects.toThrow('NEXT_NOT_FOUND');

      expect(notFound).toHaveBeenCalledTimes(1);
      // No per-leg resolution should have been attempted — the page bails out before that point.
      expect(resolveThemeForVersion).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // no_credential → explanatory notice
  // -------------------------------------------------------------------------

  describe('when this browser cannot prove ownership (no_credential)', () => {
    beforeEach(() => {
      vi.mocked(resolveRunSurface).mockResolvedValue({ ok: false, reason: 'no_credential' });
    });

    it('reassures rather than accuses, and quotes the publicRef as a support code', async () => {
      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      expect(
        screen.getByText(/can only be reopened in the browser it was started in/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/Nothing has been lost/i)).toBeInTheDocument();
      // The respondent must be able to quote this ref back to support.
      expect(screen.getByText(PUBLIC_REF)).toBeInTheDocument();
    });

    it('does not render RunSessionBoot', async () => {
      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      expect(screen.queryByTestId('run-session-boot')).not.toBeInTheDocument();
    });

    it('does not attempt any per-leg resolution', async () => {
      await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });

      expect(resolveThemeForVersion).not.toHaveBeenCalled();
      expect(resolveVersionHeader).not.toHaveBeenCalled();
    });

    it('falls back to full chrome and opts out of the reading shell', async () => {
      // No version resolved means no questionnaire to ask what chrome it wanted, so `full` is the
      // only honest answer. And `shell={false}` because the shared reading measure belongs to a
      // conversation — there isn't one here, just a narrow explanatory card that sets its own width.
      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      const chrome = screen.getByTestId('chrome');
      expect(chrome).toHaveAttribute('data-mode', 'full');
      expect(chrome).toHaveAttribute('data-shell', 'false');
    });
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  describe('when the surface resolves (ok: true)', () => {
    it('wraps the live surface in the chrome the CURRENT leg asked for', async () => {
      // Each leg of a run may be a different questionnaire, so chrome is re-resolved per load like
      // the theme and the layout. A leg that white-labels must not inherit the previous leg's
      // header — the respondent would watch our branding appear half-way through their journey.
      vi.mocked(resolveRespondentChromeForVersion).mockResolvedValue('white_label');

      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      expect(screen.getByTestId('chrome')).toHaveAttribute('data-mode', 'white_label');
      expect(resolveRespondentChromeForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
    });

    it('passes sessionId, accessToken, and the resolved theme welcomeCopy to RunSessionBoot', async () => {
      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      const boot = screen.getByTestId('run-session-boot');
      expect(boot).toHaveAttribute('data-session-id', SESSION_ID);
      expect(boot).toHaveAttribute('data-access-token', ACCESS_TOKEN);
      expect(boot).toHaveAttribute('data-welcome-copy', MOCK_THEME.welcomeCopy);
    });

    it('omits accessToken (undefined) rather than passing the string "null" for an authenticated respondent', async () => {
      // sessionToken is null when an authenticated respondent's own session ownership authorises
      // the leg — no minted token is needed. The page does `sessionToken ?? undefined`.
      vi.mocked(resolveRunSurface).mockResolvedValue({ ...MOCK_SURFACE_OK, sessionToken: null });

      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      // React omits a data-* attribute entirely when its value is undefined, so this fails if the
      // page ever regresses to forwarding the literal string "null".
      expect(screen.getByTestId('run-session-boot')).not.toHaveAttribute('data-access-token');
    });

    it("forwards the current leg's answer-panel scope so the chat-only layout is right on first paint", async () => {
      vi.mocked(resolveAnswerPanelScopeForVersion).mockResolvedValue('hidden');

      const Component = await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });
      render(Component);

      expect(screen.getByTestId('run-session-boot')).toHaveAttribute(
        'data-answer-panel-scope',
        'hidden'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cookie scanning
  // -------------------------------------------------------------------------

  describe('cookie scanning', () => {
    it('forwards only cq_run_-prefixed cookie VALUES (never names) to resolveRunSurface', async () => {
      // The cookie NAME is untrusted — only the signed payload inside the value decides which run
      // a credential is for (see run-surface.ts). Unrelated cookies (session, theme) must never
      // reach the resolver.
      mockCookieJar([
        { name: 'cq_run_primary', value: 'run-token-1' },
        { name: 'session', value: 'unrelated-session-value' },
        { name: 'cq_run_secondary', value: 'run-token-2' },
        { name: 'theme', value: 'dark' },
      ]);

      await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });

      expect(resolveRunSurface).toHaveBeenCalledWith(PUBLIC_REF, ['run-token-1', 'run-token-2']);
    });

    it('forwards an empty list when no cq_run_ cookie is present', async () => {
      mockCookieJar([{ name: 'session', value: 'unrelated' }]);

      await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });

      expect(resolveRunSurface).toHaveBeenCalledWith(PUBLIC_REF, []);
    });
  });

  // -------------------------------------------------------------------------
  // Per-leg resolution
  // -------------------------------------------------------------------------

  describe('per-leg resolution', () => {
    it("resolves theme, header, and config for the CURRENT LEG's versionId from the surface", async () => {
      await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });

      // Each leg may run a different questionnaire, so every per-version read must use the
      // versionId the surface resolved for the current leg — not the publicRef, not the run id,
      // not any stale value.
      expect(resolveThemeForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveVersionHeader).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveAnonymousForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolvePresentationModeForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveAnswerPanelScopeForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveVoiceEnabledForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveAttachmentsEnabledForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveReasoningPlacementForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveReasoningDwellForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveInlineCorrectionForVersion).toHaveBeenCalledWith(SURFACE_VERSION_ID);
    });

    it('re-resolves using a DIFFERENT versionId when the surface reports a different current leg', async () => {
      const otherLegVersionId = 'ver_leg3_next';
      vi.mocked(resolveRunSurface).mockResolvedValue({
        ...MOCK_SURFACE_OK,
        versionId: otherLegVersionId,
      });

      await ExperienceRunPage({ params: makeParams(PUBLIC_REF) });

      expect(resolveThemeForVersion).toHaveBeenCalledWith(otherLegVersionId);
      expect(resolveThemeForVersion).not.toHaveBeenCalledWith(SURFACE_VERSION_ID);
      expect(resolveAnswerPanelScopeForVersion).toHaveBeenCalledWith(otherLegVersionId);
      expect(resolveAnswerPanelScopeForVersion).not.toHaveBeenCalledWith(SURFACE_VERSION_ID);
    });
  });
});
