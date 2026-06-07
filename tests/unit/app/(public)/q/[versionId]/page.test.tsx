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

/**
 * Stub AnonymousSessionBoot — exposes all props via data-* attributes so tests
 * can assert on what the page passes without running client-side bootstrap logic.
 */
vi.mock('@/components/app/questionnaire/chat/anonymous-session-boot', () => ({
  AnonymousSessionBoot: ({
    versionId,
    voiceInputEnabled,
    attachmentInputEnabled,
    welcomeCopy,
  }: {
    versionId: string;
    voiceInputEnabled: boolean;
    attachmentInputEnabled: boolean;
    welcomeCopy: string;
  }) => (
    <div
      data-testid="anonymous-session-boot"
      data-version-id={versionId}
      data-voice-input-enabled={String(voiceInputEnabled)}
      data-attachment-input-enabled={String(attachmentInputEnabled)}
      data-welcome-copy={welcomeCopy}
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
};

function makeParams(versionId: string = VERSION_ID) {
  return Promise.resolve({ versionId });
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
      await expect(PublicQuestionnairePage({ params: makeParams() })).rejects.toThrow(
        'NEXT_NOT_FOUND'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful render
  // -------------------------------------------------------------------------

  describe('successful render', () => {
    it('renders AnonymousSessionBoot with the correct versionId', async () => {
      // Arrange (defaults from beforeEach)

      // Act
      const Component = await PublicQuestionnairePage({ params: makeParams() });
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
      await PublicQuestionnairePage({ params: makeParams() });

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
      const Component = await PublicQuestionnairePage({ params: makeParams() });
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
      const Component = await PublicQuestionnairePage({ params: makeParams() });
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
      const Component = await PublicQuestionnairePage({ params: makeParams() });
      render(Component);

      // Assert
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-voice-input-enabled',
        'true'
      );
    });

    it('passes attachmentInputEnabled=true when the attachment flag is on', async () => {
      vi.mocked(isAttachmentInputEnabled).mockResolvedValue(true);

      const Component = await PublicQuestionnairePage({ params: makeParams() });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-attachment-input-enabled',
        'true'
      );
    });

    it('passes attachmentInputEnabled=false when the attachment flag is off', async () => {
      const Component = await PublicQuestionnairePage({ params: makeParams() });
      render(Component);

      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-attachment-input-enabled',
        'false'
      );
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
      const Component = await PublicQuestionnairePage({ params: makeParams(otherVersionId) });
      render(Component);

      // Assert: versionId from params — not a hard-coded value — is forwarded
      expect(screen.getByTestId('anonymous-session-boot')).toHaveAttribute(
        'data-version-id',
        otherVersionId
      );
    });
  });
});
