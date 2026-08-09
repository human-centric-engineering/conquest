/**
 * RunSessionBoot — client bootstrap for the experience run surface, `/x/<publicRef>` (P15.3).
 *
 * The sibling of `AnonymousSessionBoot`, and deliberately smaller: this one OPENS a session that
 * already exists (server-resolved credential handed down for this render only) rather than
 * creating one. Covers: (1) the loading spinner while the four boot reads are in flight;
 * (2) a fresh session (`fetchTranscript` returns no turns) seeds the welcome turns and sets
 * `autoStart`; (3) a resumed/handed-off leg (transcript has turns already) seeds those turns and
 * suppresses `autoStart`; (4) every prop — including the F7.2 `answerPanelScope` this branch
 * added — reaches the workspace unchanged; (5) React 19 StrictMode's mount→cleanup→remount fires
 * the boot reads exactly once (the `startedRef` dedup).
 *
 * `boot-fetchers` (shared with `AnonymousSessionBoot`) is mocked at the module boundary — its own
 * fail-soft/Zod-validation behaviour has no test here, only that this component calls it with the
 * right session/token and wires the result through. `SessionWorkspace` is stubbed the same way
 * `anonymous-session-boot.test.tsx` stubs it, via the real (unmocked) `SessionEntry` passthrough.
 *
 * @see components/app/questionnaire/experiences/run-session-boot.tsx
 */

import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import type { SessionWorkspaceProps } from '@/components/app/questionnaire/session-workspace';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({
    sessionId,
    accessToken,
    autoStart,
    initialTurns,
    initialInspectorTurns,
    presentationMode,
    answerPanelScope,
    voiceInputEnabled,
    attachmentInputEnabled,
    reasoningPlacement,
    reasoningDwellMs,
    reasoningPerItemMs,
    inlineCorrectionEnabled,
    glossary,
    glossaryAppendix,
    intro,
    personas,
    capture,
  }: SessionWorkspaceProps & {
    intro?: { enabled?: boolean } | null;
    personas?: unknown;
    capture?: unknown;
  }) => (
    <div
      data-testid="questionnaire-chat"
      data-session-id={sessionId}
      data-access-token={accessToken ?? ''}
      data-auto-start={String(autoStart ?? false)}
      data-turn-count={String(initialTurns?.length ?? 0)}
      data-inspector-count={String(initialInspectorTurns?.length ?? 0)}
      data-presentation-mode={presentationMode ?? ''}
      data-answer-panel-scope={answerPanelScope ?? ''}
      data-voice={String(voiceInputEnabled ?? false)}
      data-attachments={String(attachmentInputEnabled ?? false)}
      data-reasoning-placement={reasoningPlacement ?? ''}
      data-reasoning-dwell={String(reasoningDwellMs ?? '')}
      data-reasoning-per-item={String(reasoningPerItemMs ?? '')}
      data-inline-correction={String(inlineCorrectionEnabled ?? false)}
      data-glossary-count={String(glossary?.length ?? 0)}
      data-glossary-appendix={String(glossaryAppendix != null)}
      data-intro-enabled={String(
        (intro as { enabled?: boolean } | null | undefined)?.enabled ?? false
      )}
      data-personas={String(personas != null)}
      data-capture={String(capture != null)}
    />
  ),
}));

const fetchTranscript = vi.fn();
const fetchIntro = vi.fn();
const fetchPersonas = vi.fn();
const fetchCapture = vi.fn();

vi.mock('@/lib/app/questionnaire/session/boot-fetchers', () => ({
  fetchTranscript: (...args: unknown[]) => fetchTranscript(...args),
  fetchIntro: (...args: unknown[]) => fetchIntro(...args),
  fetchPersonas: (...args: unknown[]) => fetchPersonas(...args),
  fetchCapture: (...args: unknown[]) => fetchCapture(...args),
}));

vi.mock('@/lib/app/questionnaire/chat/greeting', () => ({
  buildWelcomeTurns: vi.fn().mockReturnValue([{ role: 'assistant', content: 'Welcome turn' }]),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { RunSessionBoot } from '@/components/app/questionnaire/experiences/run-session-boot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-run-001';
const ACCESS_TOKEN = 'tok-run-001';

const RESUMED_TURN: QuestionnaireTurn = { role: 'assistant', content: 'Bridging line' };

function emptyTranscript() {
  return { turns: [], inspectorTurns: [] };
}

function resumedTranscript() {
  return { turns: [RESUMED_TURN], inspectorTurns: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchTranscript.mockResolvedValue(emptyTranscript());
  fetchIntro.mockResolvedValue(null);
  fetchPersonas.mockResolvedValue(null);
  fetchCapture.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunSessionBoot', () => {
  it('shows the loading spinner while the boot reads are in flight', async () => {
    let resolveTranscript: (value: ReturnType<typeof emptyTranscript>) => void = () => {};
    fetchTranscript.mockReturnValue(
      new Promise((resolve) => {
        resolveTranscript = resolve;
      })
    );

    render(<RunSessionBoot sessionId={SESSION_ID} accessToken={ACCESS_TOKEN} />);

    expect(screen.getByText('Opening your conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('questionnaire-chat')).not.toBeInTheDocument();

    // Resolve and flush the resulting state update inside act() so the pending promise
    // doesn't leak an unwrapped update into the next test.
    await act(async () => {
      resolveTranscript(emptyTranscript());
      await Promise.resolve();
    });
  });

  it('a fresh session seeds the welcome turns and sets autoStart', async () => {
    render(
      <RunSessionBoot
        sessionId={SESSION_ID}
        accessToken={ACCESS_TOKEN}
        welcomeCopy="Hello there"
        voiceInputEnabled
      />
    );

    const chat = await screen.findByTestId('questionnaire-chat');
    expect(chat).toHaveAttribute('data-session-id', SESSION_ID);
    expect(chat).toHaveAttribute('data-access-token', ACCESS_TOKEN);
    expect(chat).toHaveAttribute('data-auto-start', 'true');
    expect(chat).toHaveAttribute('data-turn-count', '1'); // the seeded welcome turn
  });

  it('a resumed/handed-off leg seeds the prior turns and suppresses autoStart', async () => {
    fetchTranscript.mockResolvedValue(resumedTranscript());

    render(<RunSessionBoot sessionId={SESSION_ID} accessToken={ACCESS_TOKEN} />);

    const chat = await screen.findByTestId('questionnaire-chat');
    expect(chat).toHaveAttribute('data-auto-start', 'false');
    expect(chat).toHaveAttribute('data-turn-count', '1');
  });

  it('forwards every prop — including answerPanelScope (F7.2) — to the workspace unchanged', async () => {
    render(
      <RunSessionBoot
        sessionId={SESSION_ID}
        accessToken={ACCESS_TOKEN}
        glossary={[
          {
            termId: 'churn',
            term: 'Churn',
            surfaces: ['churn'],
            definitions: ['A respondent leaving.'],
          },
        ]}
        glossaryAppendix={{ heading: 'Definitions', entries: [] }}
        presentationMode="both"
        answerPanelScope="hidden"
        voiceInputEnabled
        attachmentInputEnabled
        reasoningPlacement="inline"
        reasoningDwellMs={2500}
        reasoningPerItemMs={750}
        inlineCorrectionEnabled
      />
    );

    const chat = await screen.findByTestId('questionnaire-chat');
    expect(chat).toHaveAttribute('data-answer-panel-scope', 'hidden');
    expect(chat).toHaveAttribute('data-presentation-mode', 'both');
    expect(chat).toHaveAttribute('data-voice', 'true');
    expect(chat).toHaveAttribute('data-attachments', 'true');
    expect(chat).toHaveAttribute('data-reasoning-placement', 'inline');
    expect(chat).toHaveAttribute('data-reasoning-dwell', '2500');
    expect(chat).toHaveAttribute('data-reasoning-per-item', '750');
    expect(chat).toHaveAttribute('data-inline-correction', 'true');
    expect(chat).toHaveAttribute('data-glossary-count', '1');
    expect(chat).toHaveAttribute('data-glossary-appendix', 'true');
  });

  it('forwards the resolved intro, personas, and capture from the boot reads', async () => {
    fetchIntro.mockResolvedValue({ enabled: true });
    fetchPersonas.mockResolvedValue({ enabled: true, switcher: 'page' });
    fetchCapture.mockResolvedValue({ enabled: true });

    render(<RunSessionBoot sessionId={SESSION_ID} accessToken={ACCESS_TOKEN} />);

    const chat = await screen.findByTestId('questionnaire-chat');
    expect(chat).toHaveAttribute('data-intro-enabled', 'true');
    expect(chat).toHaveAttribute('data-personas', 'true');
    expect(chat).toHaveAttribute('data-capture', 'true');
  });

  it('an authenticated respondent (no accessToken) still boots — the fetchers get an empty token', async () => {
    render(<RunSessionBoot sessionId={SESSION_ID} />);

    await screen.findByTestId('questionnaire-chat');
    expect(fetchTranscript).toHaveBeenCalledWith(SESSION_ID, '');
    expect(fetchIntro).toHaveBeenCalledWith(SESSION_ID, '');
  });

  it('StrictMode double-invoke fires the boot reads exactly once (startedRef dedup)', async () => {
    render(
      <StrictMode>
        <RunSessionBoot sessionId={SESSION_ID} accessToken={ACCESS_TOKEN} />
      </StrictMode>
    );

    await screen.findByTestId('questionnaire-chat');
    await waitFor(() => expect(fetchTranscript).toHaveBeenCalledTimes(1));
    expect(fetchIntro).toHaveBeenCalledTimes(1);
    expect(fetchPersonas).toHaveBeenCalledTimes(1);
    expect(fetchCapture).toHaveBeenCalledTimes(1);
  });
});
