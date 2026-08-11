/**
 * SessionViewerPage Tests — the admin "read (and, for a preview, continue) one session" surface.
 *
 * The page has two mutually exclusive branches, keyed on `continuable` (`isPreview && active`):
 *  - **read-only replay** (a real respondent session, or a finished preview) → `readOnly`, bare
 *    transcript. `SessionWorkspace` returns early in that mode, so none of the surface-config
 *    props are read — and the page must not spend the queries resolving them.
 *  - **continued preview** → an access token PLUS the version's respondent-surface config, so the
 *    admin sees the same surface `/q/<vid>?preview=1` would show. Before this was threaded, a
 *    chat-only (`answerPanelScope: 'hidden'`) or form-mode questionnaire silently rendered as the
 *    default chat-plus-full-panel, misrepresenting the configured experience.
 *
 * Ownership is the other contract worth pinning: the session must belong to BOTH the route's
 * questionnaire and its version, or the page 404s (so the URL can't confirm a cross-questionnaire
 * session).
 *
 * `SessionWorkspace` is stubbed to `data-*` attributes so the props can be asserted without
 * mounting the streaming/panel/form hook tree.
 *
 * @see app/admin/questionnaires/[id]/v/[vid]/sessions/[sessionId]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// notFound() throws a sentinel so page execution halts, matching Next.js runtime behaviour.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view', () => ({
  loadAdminSessionView: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript', () => ({
  loadTranscript: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => ({
  mintSessionToken: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/admin-report-rerun-view', () => ({
  loadAdminReportRerunPanel: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/glossary/resolve', () => ({
  resolveGlossaryForHints: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/chat/anonymity', () => ({
  resolveAnswerPanelScopeForVersion: vi.fn(),
  resolveAttachmentsEnabledForVersion: vi.fn(),
  resolveInlineCorrectionForVersion: vi.fn(),
  resolvePresentationModeForVersion: vi.fn(),
  resolveReasoningDwellForVersion: vi.fn(),
  resolveReasoningPlacementForVersion: vi.fn(),
  resolveVoiceEnabledForVersion: vi.fn(),
}));

/** Stub the workspace — surface the props under test as `data-*` attributes. */
vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({
    sessionId,
    accessToken,
    readOnly,
    initialTurns,
    presentationMode,
    answerPanelScope,
    voiceInputEnabled,
    attachmentInputEnabled,
    reasoningPlacement,
    reasoningDwellMs,
    reasoningPerItemMs,
    inlineCorrectionEnabled,
  }: {
    sessionId: string;
    accessToken?: string;
    readOnly?: boolean;
    initialTurns?: unknown[];
    presentationMode?: string;
    answerPanelScope?: string;
    voiceInputEnabled?: boolean;
    attachmentInputEnabled?: boolean;
    reasoningPlacement?: string | null;
    reasoningDwellMs?: number;
    reasoningPerItemMs?: number;
    inlineCorrectionEnabled?: boolean;
  }) => (
    <div
      data-testid="session-workspace"
      data-session-id={sessionId}
      data-access-token={accessToken ?? ''}
      data-read-only={String(readOnly ?? false)}
      data-turn-count={String(initialTurns?.length ?? 0)}
      data-presentation-mode={presentationMode ?? ''}
      data-answer-panel-scope={answerPanelScope ?? ''}
      data-voice={String(voiceInputEnabled ?? false)}
      data-attachments={String(attachmentInputEnabled ?? false)}
      data-reasoning-placement={reasoningPlacement ?? ''}
      data-reasoning-dwell={String(reasoningDwellMs ?? '')}
      data-reasoning-per-item={String(reasoningPerItemMs ?? '')}
      data-inline-correction={String(inlineCorrectionEnabled ?? false)}
    />
  ),
}));

// The two admin side-panels are unrelated to the props under test; stub them to inert markers.
vi.mock('@/components/admin/questionnaires/sessions/session-downloads', () => ({
  SessionDownloads: () => <div data-testid="session-downloads" />,
}));

vi.mock('@/components/admin/questionnaires/sessions/session-report-rerun', () => ({
  SessionReportRerun: () => <div data-testid="session-report-rerun" />,
}));

import SessionViewerPage from '@/app/admin/questionnaires/[id]/v/[vid]/sessions/[sessionId]/page';
import { loadAdminSessionView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';
import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { loadAdminReportRerunPanel } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-report-rerun-view';
import { resolveGlossaryForHints } from '@/lib/app/questionnaire/glossary/resolve';
import {
  resolveAnswerPanelScopeForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';

const QUESTIONNAIRE_ID = 'qn-admin-001';
const VERSION_ID = 'ver-admin-001';
const SESSION_ID = 'sess-admin-001';
const TOKEN = 'tok-preview-001';

function makeView(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    questionnaireId: QUESTIONNAIRE_ID,
    versionId: VERSION_ID,
    isPreview: true,
    status: 'active',
    publicRef: 'ABC123',
    respondentName: null,
    ...overrides,
  };
}

function params(overrides: Record<string, string> = {}) {
  return Promise.resolve({
    id: QUESTIONNAIRE_ID,
    vid: VERSION_ID,
    sessionId: SESSION_ID,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAdminSessionView).mockResolvedValue(
    makeView() as unknown as Awaited<ReturnType<typeof loadAdminSessionView>>
  );
  vi.mocked(loadTranscript).mockResolvedValue([]);
  // Non-nullable loader; the panel it seeds is stubbed out, so a marker object is enough.
  vi.mocked(loadAdminReportRerunPanel).mockResolvedValue({
    settings: {},
    hasClient: false,
    initialView: {},
  } as unknown as Awaited<ReturnType<typeof loadAdminReportRerunPanel>>);
  vi.mocked(resolveGlossaryForHints).mockResolvedValue([]);
  vi.mocked(mintSessionToken).mockReturnValue({ token: TOKEN } as unknown as ReturnType<
    typeof mintSessionToken
  >);

  // Non-default surface config throughout, so a prop that silently fell back to the workspace's
  // own default (chat/full_progress/off) is visible as a failure rather than a coincidental match.
  vi.mocked(resolvePresentationModeForVersion).mockResolvedValue('form');
  vi.mocked(resolveAnswerPanelScopeForVersion).mockResolvedValue('hidden');
  vi.mocked(resolveVoiceEnabledForVersion).mockResolvedValue(true);
  vi.mocked(resolveAttachmentsEnabledForVersion).mockResolvedValue(true);
  vi.mocked(resolveReasoningPlacementForVersion).mockResolvedValue('inline');
  vi.mocked(resolveReasoningDwellForVersion).mockResolvedValue({
    dwellMs: 2500,
    perItemMs: 750,
  });
  vi.mocked(resolveInlineCorrectionForVersion).mockResolvedValue(true);
});

describe('SessionViewerPage', () => {
  describe('ownership', () => {
    it('404s when the session is unknown', async () => {
      // Arrange: the loader finds nothing.
      vi.mocked(loadAdminSessionView).mockResolvedValue(null);

      // Act + Assert
      await expect(SessionViewerPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('404s when the session belongs to a different questionnaire', async () => {
      // Arrange: the view's questionnaire does not match the route's `:id`.
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ questionnaireId: 'qn-other' }) as unknown as Awaited<
          ReturnType<typeof loadAdminSessionView>
        >
      );

      await expect(SessionViewerPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('404s when the session belongs to a different version', async () => {
      // Arrange: the view's version does not match the route's `:vid`.
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ versionId: 'ver-other' }) as unknown as Awaited<
          ReturnType<typeof loadAdminSessionView>
        >
      );

      await expect(SessionViewerPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('continued preview', () => {
    it("forwards the version's answer-panel scope, so a chat-only preview is not shown a panel", async () => {
      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert: the configured `hidden` scope reaches the workspace, not the default.
      const workspace = screen.getByTestId('session-workspace');
      expect(workspace).toHaveAttribute('data-answer-panel-scope', 'hidden');
      expect(resolveAnswerPanelScopeForVersion).toHaveBeenCalledWith(VERSION_ID);
    });

    it('forwards the rest of the respondent-surface config unchanged', async () => {
      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert: every resolved value lands on the workspace as configured.
      const workspace = screen.getByTestId('session-workspace');
      expect(workspace).toHaveAttribute('data-presentation-mode', 'form');
      expect(workspace).toHaveAttribute('data-voice', 'true');
      expect(workspace).toHaveAttribute('data-attachments', 'true');
      expect(workspace).toHaveAttribute('data-reasoning-placement', 'inline');
      expect(workspace).toHaveAttribute('data-reasoning-dwell', '2500');
      expect(workspace).toHaveAttribute('data-reasoning-per-item', '750');
      expect(workspace).toHaveAttribute('data-inline-correction', 'true');
    });

    it('resolves the surface config against the route version, not the questionnaire', async () => {
      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert: config is per-VERSION — a questionnaire id here would read the wrong config.
      expect(resolvePresentationModeForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(resolveVoiceEnabledForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(resolveAttachmentsEnabledForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(resolveReasoningPlacementForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(resolveReasoningDwellForVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(resolveInlineCorrectionForVersion).toHaveBeenCalledWith(VERSION_ID);
    });

    it('mints an access token and does not mark the workspace read-only', async () => {
      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert
      const workspace = screen.getByTestId('session-workspace');
      expect(workspace).toHaveAttribute('data-access-token', TOKEN);
      expect(workspace).toHaveAttribute('data-read-only', 'false');
      expect(mintSessionToken).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  describe('read-only replay', () => {
    it('renders a real respondent session read-only, with no token', async () => {
      // Arrange: not a preview → never continuable.
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ isPreview: false }) as unknown as Awaited<
          ReturnType<typeof loadAdminSessionView>
        >
      );

      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert
      const workspace = screen.getByTestId('session-workspace');
      expect(workspace).toHaveAttribute('data-read-only', 'true');
      expect(workspace).toHaveAttribute('data-access-token', '');
      expect(mintSessionToken).not.toHaveBeenCalled();
    });

    it('renders a completed preview read-only (only an ACTIVE preview is continuable)', async () => {
      // Arrange: a preview that has finished.
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ status: 'completed' }) as unknown as Awaited<
          ReturnType<typeof loadAdminSessionView>
        >
      );

      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert
      expect(screen.getByTestId('session-workspace')).toHaveAttribute('data-read-only', 'true');
      expect(mintSessionToken).not.toHaveBeenCalled();
    });

    it('skips the surface-config reads entirely — the read-only branch never uses them', async () => {
      // Arrange
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ isPreview: false }) as unknown as Awaited<
          ReturnType<typeof loadAdminSessionView>
        >
      );

      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert: `SessionWorkspace` returns early under `readOnly`, so resolving these would be
      // seven wasted queries on every transcript view.
      expect(resolveAnswerPanelScopeForVersion).not.toHaveBeenCalled();
      expect(resolvePresentationModeForVersion).not.toHaveBeenCalled();
      expect(resolveVoiceEnabledForVersion).not.toHaveBeenCalled();
      expect(resolveAttachmentsEnabledForVersion).not.toHaveBeenCalled();
      expect(resolveReasoningPlacementForVersion).not.toHaveBeenCalled();
      expect(resolveReasoningDwellForVersion).not.toHaveBeenCalled();
      expect(resolveInlineCorrectionForVersion).not.toHaveBeenCalled();
    });
  });

  describe('anonymous badge', () => {
    it('shows an "Anonymous" badge when the view is anonymised', async () => {
      // Arrange: identity is redacted by loadAdminSessionView in anonymous mode.
      vi.mocked(loadAdminSessionView).mockResolvedValue(
        makeView({ anonymous: true }) as unknown as Awaited<ReturnType<typeof loadAdminSessionView>>
      );

      // Act
      render(await SessionViewerPage({ params: params() }));

      // Assert
      expect(screen.getByText('Anonymous')).toBeInTheDocument();
    });

    it('omits the "Anonymous" badge for an identified session', async () => {
      // Arrange: default fixture carries no `anonymous` flag.
      render(await SessionViewerPage({ params: params() }));

      // Assert
      expect(screen.queryByText('Anonymous')).not.toBeInTheDocument();
    });
  });
});
