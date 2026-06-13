/**
 * PublicQuestionnairePage Tests
 *
 * Tests the no-login respondent chat surface (F7.1) Server Component.
 *
 * Test Coverage:
 * - Feature flag off → notFound()
 * - Flag on → renders AnonymousSessionBoot with versionId, voiceInputEnabled, welcomeCopy from theme
 * - voiceInputEnabled=true propagated when flag is on
 * - voiceInputEnabled=false propagated when flag is off
 * - welcomeCopy is taken from the resolved theme (page does not hard-code it)
 * - Page metadata title
 *
 * No session-sensitive data is needed here: session creation happens client-side
 * in AnonymousSessionBoot; this page only resolves the theme server-side.
 *
 * @see app/(public)/q/[versionId]/page.tsx
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
 * Mock feature flags — defaulted to true (happy path); individual tests override.
 */
vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isLiveSessionsEnabled: vi.fn(),
  isVoiceInputEnabled: vi.fn(),
  isAttachmentInputEnabled: vi.fn(),
}));

/**
 * Mock theme resolver — returns a minimal resolved theme.
 */
vi.mock('@/lib/app/questionnaire/chat/theme', () => ({
  resolveThemeForVersion: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/chat/anonymity', () => ({
  resolveAnonymousForVersion: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/chat/preview-nav', () => ({
  resolveAdminPreviewExitHref: vi.fn(),
}));

/**
 * Stub AnonymousSessionBoot — exposes all props via data-* attributes so tests
 * can assert on what the page passes without running client-side bootstrap logic.
 */
vi.mock('@/components/app/questionnaire/chat/anonymous-session-boot', () => ({
  AnonymousSessionBoot: ({
    versionId,
    voiceInputEnabled,
    attachmentInputEnabled,
    anonymous,
    welcomeCopy,
    preview,
  }: {
    versionId: string;
    voiceInputEnabled: boolean;
    attachmentInputEnabled: boolean;
    anonymous: boolean;
    welcomeCopy: string;
    preview: boolean;
  }) => (
    <div
      data-testid="anonymous-session-boot"
      data-version-id={versionId}
      data-voice-input-enabled={String(voiceInputEnabled)}
      data-attachment-input-enabled={String(attachmentInputEnabled)}
      data-anonymous={String(anonymous)}
      data-welcome-copy={welcomeCopy}
      data-preview={String(preview)}
    />
  ),
}));

/**
 * Stub BrandThemeProvider — renders children so AnonymousSessionBoot still
 * appears in the tree, matching the page's wrapping structure.
 */
vi.mock('@/components/app/questionnaire/chat/brand-theme-provider', () => ({
  BrandThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PublicQuestionnairePage, { metadata } from '@/app/(public)/q/[versionId]/page';
import {
  isAttachmentInputEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveAnonymousForVersion } from '@/lib/app/questionnaire/chat/anonymity';
import { resolveAdminPreviewExitHref } from '@/lib/app/questionnaire/chat/preview-nav';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type React from 'react';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VERSION_ID = 'ver_abc123';

const MOCK_THEME: ResolvedTheme = {
  ctaColor: '#5469d4',
  accentColor: '#5469d4',
  logoUrl: null,
  welcomeCopy: 'Welcome to our survey — it only takes a few minutes.',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
};

function makeParams(versionId: string = VERSION_ID) {
  return Promise.resolve({ versionId });
}

function makeSearchParams(preview?: string) {
  return Promise.resolve(preview === undefined ? {} : { preview });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublicQuestionnairePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    vi.mocked(isLiveSessionsEnabled).mockResolvedValue(true);
    vi.mocked(isVoiceInputEnabled).mockResolvedValue(false);
    vi.mocked(isAttachmentInputEnabled).mockResolvedValue(false);
    vi.mocked(resolveThemeForVersion).mockResolvedValue(MOCK_THEME);
    vi.mocked(resolveAnonymousForVersion).mockResolvedValue(false);
    vi.mocked(resolveAdminPreviewExitHref).mockResolvedValue(
      '/admin/questionnaires/q_abc/v/ver_abc123'
    );
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
      await expect(
        PublicQuestionnairePage({ params: makeParams(), searchParams: makeSearchParams() })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // Successful render
  // -------------------------------------------------------------------------

  describe('successful render', () => {
    it('renders AnonymousSessionBoot with the correct versionId', async () => {
      // Arrange (defaults from beforeEach)

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert: the page passed the versionId from params to the boot component
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-version-id',
        VERSION_ID
      );
    });

    it('resolves the theme using the versionId from params', async () => {
      // Arrange (defaults)

      // Act
      await PublicQuestionnairePage({ params: makeParams(), searchParams: makeSearchParams() });

      // Assert: the page called the theme resolver with the correct versionId (side effect)
      expect(resolveThemeForVersion).toHaveBeenCalledWith(VERSION_ID);
    });

    it('passes welcomeCopy from the resolved theme to AnonymousSessionBoot', async () => {
      // Arrange: theme with custom welcome copy
      const customTheme: ResolvedTheme = {
        ...MOCK_THEME,
        welcomeCopy: 'Custom branded welcome message for this client.',
      };
      vi.mocked(resolveThemeForVersion).mockResolvedValue(customTheme);

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert: the page used the theme-resolved welcomeCopy (not a hard-coded default)
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-welcome-copy',
        customTheme.welcomeCopy
      );
    });

    it('passes voiceInputEnabled=false when the voice flag is off', async () => {
      // Arrange: voice flag already defaulted to false in beforeEach

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert: the resolved flag value reaches the boot component
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-voice-input-enabled',
        'false'
      );
    });

    it('passes voiceInputEnabled=true when the voice flag is on', async () => {
      // Arrange
      vi.mocked(isVoiceInputEnabled).mockResolvedValue(true);

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-voice-input-enabled',
        'true'
      );
    });

    it('passes attachmentInputEnabled=true when the attachment flag is on', async () => {
      vi.mocked(isAttachmentInputEnabled).mockResolvedValue(true);

      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-attachment-input-enabled',
        'true'
      );
    });

    it('passes attachmentInputEnabled=false when the attachment flag is off', async () => {
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-attachment-input-enabled',
        'false'
      );
    });

    it('passes anonymous=true when the version is configured anonymousMode', async () => {
      // Arrange: the no-login surface resolves the version's anonymity for the opening turn.
      vi.mocked(resolveAnonymousForVersion).mockResolvedValue(true);

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert: the flag is resolved for this version and forwarded to the boot.
      expect(resolveAnonymousForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-anonymous',
        'true'
      );
    });

    it('passes anonymous=false when the version is not anonymous', async () => {
      // Arrange: default mock resolves false.
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-anonymous',
        'false'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Preview mode (?preview=1)
  // -------------------------------------------------------------------------

  describe('admin preview mode', () => {
    it('passes preview=false when no preview query param is present', async () => {
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute('data-preview', 'false');
    });

    it('passes preview=true when ?preview=1 is present', async () => {
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams('1'),
      });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute('data-preview', 'true');
    });

    it('passes preview=false for any non-"1" preview value', async () => {
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams('true'),
      });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute('data-preview', 'false');
    });

    it('renders an "Exit preview" link to the admin workspace in preview mode', async () => {
      vi.mocked(resolveAdminPreviewExitHref).mockResolvedValue(
        '/admin/questionnaires/q_xyz/v/ver_abc123'
      );

      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams('1'),
      });
      render(Component);

      // Resolved with the version from params.
      expect(resolveAdminPreviewExitHref).toHaveBeenCalledWith(VERSION_ID);
      const exit = screen.getByRole('link', { name: /exit preview/i });
      expect(exit).toHaveAttribute('href', '/admin/questionnaires/q_xyz/v/ver_abc123');
    });

    it('does not resolve an exit href or render the banner outside preview mode', async () => {
      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // The expensive lookup is skipped entirely for real respondents.
      expect(resolveAdminPreviewExitHref).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: /exit preview/i })).not.toBeInTheDocument();
    });

    it('omits the banner when the exit href cannot be resolved (version gone)', async () => {
      vi.mocked(resolveAdminPreviewExitHref).mockResolvedValue(null);

      const Component = await PublicQuestionnairePage({
        params: makeParams(),
        searchParams: makeSearchParams('1'),
      });
      render(Component);

      // Still a preview run, but no dangling/broken exit control.
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute('data-preview', 'true');
      expect(screen.queryByRole('link', { name: /exit preview/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Different versionIds
  // -------------------------------------------------------------------------

  describe('versionId routing', () => {
    it('forwards a different versionId from params to the boot component', async () => {
      // Arrange: a different version is being accessed
      const otherVersionId = 'ver_other999';

      // Act
      const Component = await PublicQuestionnairePage({
        params: makeParams(otherVersionId),
        searchParams: makeSearchParams(),
      });
      render(Component);

      // Assert: versionId from params — not a hard-coded value — is forwarded
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-version-id',
        otherVersionId
      );
    });
  });
});
