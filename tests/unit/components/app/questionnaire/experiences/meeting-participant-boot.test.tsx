// @vitest-environment happy-dom

/**
 * MeetingParticipantBoot — the participant's surface in a facilitated meeting (P15.5).
 *
 * These tests exist for one behaviour above all: a breakout must run on the questionnaire author's
 * OWN configuration, not on the workspace's prop defaults. That is not a cosmetic detail — a
 * meeting's steps (and the rooms inside one step) may each run a different questionnaire, and this
 * surface mounts ONCE and swaps sessions in place, so nothing ever re-renders on the server to pick
 * the new config up. The regression this guards is silent by nature: everything still works, it
 * just works as a different questionnaire than the one the author configured.
 *
 * Covered: config threading into the workspace; the re-read when a breakout changes the session;
 * the refusal to paint one breakout's config onto another (the `forSessionId` guard, exercised via
 * an out-of-order in-flight read); holding the workspace behind a spinner rather than mounting on
 * defaults and reflowing; and the fail-soft path where the read returns null.
 *
 * `apiClient` and `boot-fetchers` are mocked at the module boundary — their own retry/Zod
 * behaviour is tested elsewhere; what matters here is which session id this component reads for and
 * where the result lands. `SessionWorkspace` is stubbed to `data-*` attributes so every threaded
 * prop can be asserted, the same way the sibling boot tests do it.
 *
 * @see components/app/questionnaire/experiences/meeting-participant-boot.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import type { SessionWorkspaceProps } from '@/components/app/questionnaire/session-workspace';
import type { RespondentSurfaceConfig } from '@/lib/app/questionnaire/session/respondent-surface';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({
    sessionId,
    accessToken,
    presentationMode,
    answerPanelScope,
    voiceInputEnabled,
    attachmentInputEnabled,
    reasoningPlacement,
    inlineCorrectionEnabled,
    showProgressPercentText,
    glossary,
  }: SessionWorkspaceProps) => (
    <div
      data-testid="workspace"
      data-session-id={sessionId}
      data-access-token={accessToken ?? ''}
      data-presentation-mode={presentationMode ?? ''}
      data-answer-panel-scope={answerPanelScope ?? ''}
      data-voice={String(voiceInputEnabled ?? false)}
      data-attachments={String(attachmentInputEnabled ?? false)}
      data-reasoning-placement={reasoningPlacement ?? ''}
      data-inline-correction={String(inlineCorrectionEnabled ?? false)}
      data-progress-percent={String(showProgressPercentText ?? true)}
      data-glossary-count={String(glossary?.length ?? 0)}
    />
  ),
}));

vi.mock('@/components/app/questionnaire/chat/brand-theme-provider', () => ({
  BrandThemeProvider: ({
    theme,
    children,
  }: {
    theme: { ctaColor: string };
    children: React.ReactNode;
  }) => (
    <div data-testid="brand" data-cta={theme.ctaColor}>
      {children}
    </div>
  ),
}));

vi.mock('@/components/app/questionnaire/experiences/meeting-insight-panel', () => ({
  MeetingInsightPanel: () => <div data-testid="insights" />,
}));

vi.mock('@/components/app/questionnaire/experiences/breakout-room-picker', () => ({
  BreakoutRoomPicker: () => <div data-testid="room-picker" />,
}));

const apiPost = vi.fn();
const apiGet = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => apiPost(...args),
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

const fetchSurfaceConfig = vi.fn();
vi.mock('@/lib/app/questionnaire/session/boot-fetchers', () => ({
  fetchSurfaceConfig: (...args: unknown[]) => fetchSurfaceConfig(...args),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { MeetingParticipantBoot } from '@/components/app/questionnaire/experiences/meeting-participant-boot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEETING_ID = 'meet-1';
const RUN_ID = 'run-1';

/**
 * A config that differs from EVERY workspace prop default, so a passing assertion can only mean
 * the value travelled — never that two defaults happened to agree.
 */
function surfaceConfig(overrides: Partial<RespondentSurfaceConfig> = {}): RespondentSurfaceConfig {
  return {
    voiceInputEnabled: true,
    attachmentInputEnabled: true,
    presentationMode: 'chat',
    respondentLayout: 'classic',
    answerPanelScope: 'hidden',
    reasoningPlacement: 'inline',
    reasoningDwellMs: 4321,
    reasoningPerItemMs: 765,
    inlineCorrectionEnabled: true,
    showProgressPercentText: false,
    anonymous: true,
    theme: {
      ctaColor: '#123456',
      accentColor: '#654321',
      logoUrl: null,
      bannerUrl: null,
      welcomeCopy: 'Welcome',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      hasBrandIdentity: true,
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
    },
    header: { title: 'Team health check', round: null },
    glossary: [{ termId: 't1', term: 'ego', surfaces: ['ego'], definitions: ['the self'] }],
    glossaryAppendix: null,
    ...overrides,
  };
}

/** The live-meeting poll payload for a running breakout. */
function liveRunning(stepId = 'step-1') {
  return {
    status: 'running',
    currentStepId: stepId,
    currentStepTitle: 'What is working?',
    breakoutStartedAt: null,
    breakoutEndsAt: null,
    breakoutGraceSeconds: 30,
    participantCount: 4,
    completedCount: 0,
    insights: [],
  };
}

/** Wire the two poll endpoints. `participant` decides which session the surface is answering. */
function primePolls(sessionId: string | null, live = liveRunning()) {
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/participant')) {
      return Promise.resolve({
        sessionId,
        window: { canAnswer: true, canSubmit: true, wrappingUp: false },
      });
    }
    if (url.includes('/rooms')) return Promise.resolve({ rooms: [] });
    return Promise.resolve(live);
  });
}

function renderBoot() {
  return render(
    <MeetingParticipantBoot
      meetingId={MEETING_ID}
      title="Quarterly offsite"
      insightDisplay="none"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiPost.mockResolvedValue({
    runId: RUN_ID,
    meetingId: MEETING_ID,
    sessionId: 'sess-a',
    sessionToken: 'tok-a',
  });
  primePolls('sess-a');
  fetchSurfaceConfig.mockResolvedValue(surfaceConfig());
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeetingParticipantBoot — breakout configuration', () => {
  it('threads the breakout’s own config into the workspace instead of the prop defaults', async () => {
    renderBoot();

    const workspace = await screen.findByTestId('workspace');
    expect(workspace.getAttribute('data-session-id')).toBe('sess-a');
    // Every one of these is the OPPOSITE of the workspace's own default for that prop.
    expect(workspace.getAttribute('data-presentation-mode')).toBe('chat');
    expect(workspace.getAttribute('data-answer-panel-scope')).toBe('hidden');
    expect(workspace.getAttribute('data-voice')).toBe('true');
    expect(workspace.getAttribute('data-attachments')).toBe('true');
    expect(workspace.getAttribute('data-reasoning-placement')).toBe('inline');
    expect(workspace.getAttribute('data-inline-correction')).toBe('true');
    expect(workspace.getAttribute('data-progress-percent')).toBe('false');
    expect(workspace.getAttribute('data-glossary-count')).toBe('1');
  });

  it('reads the config for the session it is answering, with that session’s token', async () => {
    renderBoot();

    await screen.findByTestId('workspace');
    expect(fetchSurfaceConfig).toHaveBeenCalledWith('sess-a', 'tok-a');
  });

  it('wraps the surface in the resolved brand once the config lands', async () => {
    renderBoot();

    const brand = await screen.findByTestId('brand');
    expect(brand.getAttribute('data-cta')).toBe('#123456');
  });

  it('holds the workspace behind a spinner rather than mounting it on defaults', async () => {
    // A read that never settles: the workspace must not appear at all. Mounting early and
    // re-rendering when the config lands would rearrange the layout under someone already reading.
    fetchSurfaceConfig.mockReturnValue(new Promise(() => {}));

    renderBoot();

    expect(await screen.findByText('Opening this round')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('still opens the workspace when the config read fails soft', async () => {
    // Null is the fail-soft contract: the participant gets the workspace's defaults — the old
    // behaviour — rather than being locked out of a breakout they are sitting in.
    fetchSurfaceConfig.mockResolvedValue(null);

    renderBoot();

    const workspace = await screen.findByTestId('workspace');
    expect(workspace.getAttribute('data-session-id')).toBe('sess-a');
    // Unset props fall through to the workspace's own defaults.
    expect(workspace.getAttribute('data-presentation-mode')).toBe('');
    // With no theme resolved there is nothing to brand the room with.
    expect(screen.queryByTestId('brand')).not.toBeInTheDocument();
  });
});

describe('MeetingParticipantBoot — a second breakout', () => {
  it('re-reads the config when the poll moves the participant to a new session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchSurfaceConfig.mockImplementation(async (sessionId: string) =>
      sessionId === 'sess-a'
        ? surfaceConfig({ presentationMode: 'chat' })
        : surfaceConfig({ presentationMode: 'form', glossary: [] })
    );

    renderBoot();
    await waitFor(() =>
      expect(screen.getByTestId('workspace').getAttribute('data-presentation-mode')).toBe('chat')
    );

    // The facilitator starts the next breakout — a different questionnaire.
    primePolls('sess-b', liveRunning('step-2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() => {
      const workspace = screen.getByTestId('workspace');
      expect(workspace.getAttribute('data-session-id')).toBe('sess-b');
      expect(workspace.getAttribute('data-presentation-mode')).toBe('form');
      expect(workspace.getAttribute('data-glossary-count')).toBe('0');
    });
    expect(fetchSurfaceConfig).toHaveBeenCalledWith('sess-b', expect.anything());
  });

  it('shows the spinner, not the previous breakout’s layout, while the new config is in flight', async () => {
    // The window this guards is narrow and easy to miss: between the poll swapping the session and
    // the new read landing, the only config in state is the PREVIOUS breakout's. Painting it would
    // show one questionnaire's layout under another's conversation for a frame or more — which is
    // why the config is stored paired with the session it was read for, not as a bare object.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchSurfaceConfig.mockImplementation((sessionId: string) =>
      sessionId === 'sess-a'
        ? Promise.resolve(surfaceConfig({ presentationMode: 'chat' }))
        : new Promise(() => {})
    );

    renderBoot();
    await waitFor(() =>
      expect(screen.getByTestId('workspace').getAttribute('data-presentation-mode')).toBe('chat')
    );

    primePolls('sess-b', liveRunning('step-2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() => expect(screen.getByText('Opening this round')).toBeInTheDocument());
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('never paints the previous breakout’s config onto the next one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The first breakout's read is still in flight when the second breakout starts — the exact
    // race a plain `setSurface(config)` would lose, painting breakout A's layout onto B.
    let settleA: (value: RespondentSurfaceConfig) => void = () => {};
    fetchSurfaceConfig.mockImplementation((sessionId: string) =>
      sessionId === 'sess-a'
        ? new Promise<RespondentSurfaceConfig>((resolve) => {
            settleA = resolve;
          })
        : Promise.resolve(surfaceConfig({ presentationMode: 'form' }))
    );

    renderBoot();
    expect(await screen.findByText('Opening this round')).toBeInTheDocument();

    primePolls('sess-b', liveRunning('step-2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await waitFor(() =>
      expect(screen.getByTestId('workspace').getAttribute('data-session-id')).toBe('sess-b')
    );

    // Breakout A's read lands late, addressed to a session nobody is in any more.
    await act(async () => {
      settleA(surfaceConfig({ presentationMode: 'chat' }));
    });

    const workspace = screen.getByTestId('workspace');
    expect(workspace.getAttribute('data-session-id')).toBe('sess-b');
    expect(workspace.getAttribute('data-presentation-mode')).toBe('form');
  });
});
