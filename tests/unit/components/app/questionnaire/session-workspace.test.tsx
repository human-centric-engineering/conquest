/**
 * SessionWorkspace — the chat + answer-panel split-screen wiring (F7.2).
 *
 * All three hooks and the children are mocked so the test pins SessionWorkspace's OWN
 * responsibilities, not theirs: that the single stream is created with `onTurnSettled`
 * fanning out to BOTH the panel refetch and the lifecycle refetch (F7.3), that the
 * panel's view/loading and the stream's `canSend` are threaded down, that the lifecycle
 * `applyStatus` is wired to the shared stream, and that the Revisit handler sends a
 * correctly-phrased turn through the shared stream only when sending is allowed.
 *
 * @see components/app/questionnaire/session-workspace.tsx
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';

const sendMessage = vi.fn();
const applyStatus = vi.fn();
const kickoff = vi.fn();
const refetch = vi.fn();
const lifecycleRefetch = vi.fn();

const formRefresh = vi.fn();
const formSetValue = vi.fn();

const streamHook = vi.fn();
const panelHook = vi.fn();
const lifecycleHook = vi.fn();
const formHook = vi.fn();

vi.mock('@/lib/hooks/use-questionnaire-session-stream', () => ({
  useQuestionnaireSessionStream: (opts: unknown) => streamHook(opts),
}));
vi.mock('@/lib/hooks/use-answer-panel', () => ({
  useAnswerPanel: (opts: unknown) => panelHook(opts),
}));
vi.mock('@/lib/hooks/use-session-lifecycle', () => ({
  useSessionLifecycle: (opts: unknown) => lifecycleHook(opts),
}));
vi.mock('@/lib/hooks/use-form-answers', () => ({
  useFormAnswers: (opts: unknown) => formHook(opts),
}));
vi.mock('@/components/app/questionnaire/form/questionnaire-form', () => ({
  QuestionnaireForm: () => <div data-testid="form" />,
}));

// Chat + lifecycle children are irrelevant here — marker stubs keep the render cheap. The chat
// stub surfaces `readOnly` so the read-only-mode tests can assert it's threaded through.
vi.mock('@/components/app/questionnaire/chat/questionnaire-chat', () => ({
  QuestionnaireChat: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="chat" data-read-only={String(Boolean(readOnly))} />
  ),
}));
// Lifecycle-bar stub surfaces the Pause/Resume handlers as buttons so the test can verify
// the workspace wires them to the hook's actions.
vi.mock('@/components/app/questionnaire/lifecycle/session-lifecycle-bar', () => ({
  SessionLifecycleBar: ({
    onPause,
    onResume,
    trailing,
  }: {
    onPause: () => void;
    onResume: () => void;
    trailing?: ReactNode;
  }) => (
    <div data-testid="lifecycle-bar">
      <button type="button" onClick={onPause}>
        bar-pause
      </button>
      <button type="button" onClick={onResume}>
        bar-resume
      </button>
      {/* The mode toggle is passed here as `trailing` — render it so the test can drive it. */}
      {trailing}
    </div>
  ),
}));
// Completion-offer stub surfaces the Submit handler as a button (same reason).
vi.mock('@/components/app/questionnaire/lifecycle/completion-offer', () => ({
  CompletionOffer: ({ onSubmit }: { onSubmit: () => void }) => (
    <div data-testid="completion-offer">
      <button type="button" onClick={onSubmit}>
        offer-submit
      </button>
    </div>
  ),
}));
// Early-finish-control stub surfaces the Finish handler as a button (same reason).
vi.mock('@/components/app/questionnaire/lifecycle/early-finish-control', () => ({
  EarlyFinishControl: ({ onFinish }: { onFinish: () => void }) => (
    <div data-testid="early-finish-control">
      <button type="button" onClick={onFinish}>
        early-finish
      </button>
    </div>
  ),
}));
vi.mock('@/components/app/questionnaire/lifecycle/session-complete', () => ({
  SessionComplete: () => <div data-testid="session-complete" />,
}));

// Panel stub exposes the props the workspace controls + a button that fires onRevisit.
vi.mock('@/components/app/questionnaire/panel/answer-slot-panel', () => ({
  AnswerSlotPanel: ({
    loading,
    canRevisit,
    onRevisit,
    newlyFilledKeys,
  }: {
    loading: boolean;
    canRevisit: boolean;
    onRevisit: (slot: PanelSlotView) => void;
    newlyFilledKeys?: readonly string[];
  }) => (
    <div
      data-testid="panel"
      data-loading={String(loading)}
      data-can-revisit={String(canRevisit)}
      data-newly-filled={(newlyFilledKeys ?? []).join(',')}
    >
      <button type="button" onClick={() => onRevisit(SLOT)}>
        revisit
      </button>
    </div>
  ),
}));

import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';

const SLOT: PanelSlotView = {
  slotKey: 'budget',
  prompt: 'What is your budget?',
  type: 'free_text',
  typeConfig: null,
  required: true,
  answered: true,
  value: '£10k',
  provenance: 'direct',
  confidence: 0.8,
  rationale: null,
  answeredAtTurnIndex: 2,
  respondentEdited: false,
  refinementHistory: [],
};

function lifecycleReturn(over: Record<string, unknown> = {}) {
  return {
    view: null,
    loading: false,
    busy: false,
    actionError: null,
    canSubmit: false,
    canFinishEarly: false,
    canPause: false,
    canResume: false,
    refetch: lifecycleRefetch,
    pause: vi.fn(),
    resume: vi.fn(),
    submit: vi.fn(),
    finishEarly: vi.fn(),
    ...over,
  };
}

function setup(
  streamOver: Record<string, unknown> = {},
  panelOver: Record<string, unknown> = {},
  lifecycleOver: Record<string, unknown> = {}
) {
  streamHook.mockReturnValue({
    canSend: true,
    status: 'idle',
    sendMessage,
    kickoff,
    applyStatus,
    ...streamOver,
  });
  panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch, ...panelOver });
  lifecycleHook.mockReturnValue(lifecycleReturn(lifecycleOver));
  // Pin chat mode so these mode-agnostic tests render a single surface; the default is now
  // 'both' (which renders chat + form together). Mode-specific tests override per render.
  render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
}

function formReturn(over: Record<string, unknown> = {}) {
  return {
    view: null,
    loading: false,
    error: false,
    values: {},
    statuses: {},
    setValue: formSetValue,
    flush: vi.fn(),
    refresh: formRefresh,
    // Mirror the rest of the real useFormAnswers shape the workspace threads into QuestionnaireForm
    // (editedKeys / saveState / lastSavedAt) so the mock can't silently drift from the hook's API.
    editedKeys: new Set<string>(),
    saveState: 'idle' as const,
    lastSavedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults so a render in any mode doesn't crash; mode tests override as needed.
  streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, kickoff, applyStatus });
  panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
  lifecycleHook.mockReturnValue(lifecycleReturn());
  formHook.mockReturnValue(formReturn());
});

describe('SessionWorkspace', () => {
  it('fans onTurnSettled out to BOTH the panel and lifecycle refetches', () => {
    setup();
    const opts = streamHook.mock.calls[0][0];
    // It's a combined closure now (refs set in an effect), not the panel refetch directly.
    expect(typeof opts.onTurnSettled).toBe('function');
    opts.onTurnSettled();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(lifecycleRefetch).toHaveBeenCalledTimes(1);
  });

  it('wires the lifecycle hook to the shared stream applyStatus', () => {
    setup();
    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ applyStatus });
  });

  it('refreshes the lifecycle when the form reports a save (onSaved)', () => {
    // A form save must re-pull the status so coverage / submit-readiness reflect the new answer.
    render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
    const opts = formHook.mock.calls[0][0] as { onSaved?: () => void };
    expect(typeof opts.onSaved).toBe('function');
    opts.onSaved?.();
    expect(lifecycleRefetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-fire the kickoff when autoStart is off (the default)', () => {
    setup();
    expect(kickoff).not.toHaveBeenCalled();
  });

  it('fires the kickoff exactly once on mount when autoStart is set', () => {
    streamHook.mockReturnValue({
      canSend: true,
      status: 'idle',
      sendMessage,
      kickoff,
      applyStatus,
    });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());

    const { rerender } = render(<SessionWorkspace sessionId="s1" autoStart />);
    // A re-render with unchanged state must NOT fire a second kickoff (the effect deps —
    // status + turn count — are stable, so it does not re-run).
    rerender(<SessionWorkspace sessionId="s1" autoStart />);

    expect(kickoff).toHaveBeenCalledTimes(1);
  });

  it('re-fires the kickoff after a StrictMode abort (idle again with no question), then stops once a question arrives', () => {
    const greeting = [{ role: 'assistant', content: 'Welcome' }];
    const withQuestion = [...greeting, { role: 'assistant', content: 'Q1?' }];
    const base = { canSend: true, sendMessage, kickoff, applyStatus };
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());

    // 1) Fresh + idle + only the greeting → fire the opening kickoff.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: greeting });
    const { rerender } = render(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(1);

    // 2) Kickoff in flight (streaming) → no duplicate.
    streamHook.mockReturnValue({ ...base, status: 'streaming', turns: greeting });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(1);

    // 3) StrictMode aborted it: status recovered to idle, still only the greeting → re-fire.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: greeting });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(2);

    // 4) The first question landed (turns grew past the greeting) → never fire again.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: withQuestion });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(2);
  });

  // ── Intro carousel surface (deferred kickoff) ────────────────────────────────
  describe('intro surface', () => {
    const intro = {
      enabled: true,
      questionnaireTitle: 'Team Health Check',
      background: '',
      videoUrl: '',
      copy: {
        howItWorks: { heading: 'How it works', body: 'This is a conversation, not a form.' },
        whatYouGet: null,
        goodToKnow: [],
        buttonLabel: 'Begin your conversation',
      },
    };

    it('lands on the Intro surface and DEFERS the kickoff while it shows', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" autoStart intro={intro} />);

      // Intro is the active tab, and the opening turn has NOT been spent yet.
      expect(screen.getByRole('tab', { name: 'Intro' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Form' })).toBeInTheDocument();
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('fires the kickoff once the respondent leaves the intro', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" autoStart intro={intro} />);
      expect(kickoff).not.toHaveBeenCalled();

      // Sliding to Chat marks the session started, releasing the deferred opening turn.
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('on a resume (autoStart off) keeps the Intro tab but lands on the conversation, no kickoff', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" intro={intro} />);
      // The recap is still reachable (slide-back), but we open on chat and never fire the opening turn.
      expect(screen.getByRole('tab', { name: 'Intro' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('weaves an Intro toggle into a chat-only session (no form) and defers the kickoff', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" autoStart intro={intro} />);
      // chat-only normally has no toggle; the intro adds an Intro↔Chat one.
      expect(screen.getByRole('tab', { name: 'Intro' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Form' })).not.toBeInTheDocument();
      expect(kickoff).not.toHaveBeenCalled();
    });
  });

  it('threads the session id and access token into all three hooks', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    render(<SessionWorkspace sessionId="s1" accessToken="tok-9" />);

    expect(panelHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
    expect(streamHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
  });

  it('seeds useAnswerPanel with the SSR-resolved initialPanel view', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    const seed = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 0,
      totalCount: 0,
    };
    render(<SessionWorkspace sessionId="s1" initialPanel={seed} />);

    expect(panelHook.mock.calls[0][0]).toMatchObject({ initialView: seed });
  });

  it('seeds useSessionLifecycle with the SSR-resolved initialStatusView', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    const statusSeed = {
      status: 'active' as const,
      completion: {
        kind: 'offer' as const,
        coverage: 0.9,
        displayCoverage: 0.9,
        answeredCount: 3,
        requiredUnansweredKeys: [],
        capReached: false,
        earlyFinishAvailable: false,
      },
      cost: null,
      anonymous: false,
      ref: null,
    };
    render(<SessionWorkspace sessionId="s1" initialStatusView={statusSeed} />);

    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ initialView: statusSeed });
  });

  it('seeds the stream hook with the SSR-resolved initialStatus', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    render(<SessionWorkspace sessionId="s1" initialStatus="not_active" />);

    expect(streamHook.mock.calls[0][0]).toMatchObject({ initialStatus: 'not_active' });
  });

  it('passes the panel loading state and stream canSend down to the panel', () => {
    setup({ canSend: false }, { loading: true });
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('data-loading', 'true');
    expect(panel).toHaveAttribute('data-can-revisit', 'false');
  });

  it('diffs panel snapshots and passes the newly-filled data-slot keys down (seeding silently first)', () => {
    // A data-slot view where `goal` is unfilled.
    const before = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 0,
      totalCount: 0,
      dataSlotGroups: [
        {
          theme: 'Goals',
          slots: [
            {
              key: 'goal',
              name: 'Goal',
              description: '',
              paraphrase: null,
              provenance: null,
              confidence: null,
              rationale: null,
              filled: false,
              provisional: false,
              answeredAtTurnIndex: null,
              history: [],
            },
          ],
        },
      ],
      progressPercent: 0,
    };
    streamHook.mockReturnValue({
      canSend: true,
      status: 'idle',
      sendMessage,
      kickoff,
      applyStatus,
    });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    panelHook.mockReturnValue({ view: before, loading: false, error: false, refetch });
    const { rerender } = render(<SessionWorkspace sessionId="s1" />);
    // First snapshot only seeds the diff baseline — nothing is announced as newly filled.
    expect(screen.getByTestId('panel')).toHaveAttribute('data-newly-filled', '');

    // The turn fills `goal`.
    const after = {
      ...before,
      dataSlotGroups: [
        {
          theme: 'Goals',
          slots: [{ ...before.dataSlotGroups[0].slots[0], filled: true, answeredAtTurnIndex: 2 }],
        },
      ],
    };
    panelHook.mockReturnValue({ view: after, loading: false, error: false, refetch });
    rerender(<SessionWorkspace sessionId="s1" />);
    expect(screen.getByTestId('panel')).toHaveAttribute('data-newly-filled', 'goal');
  });

  it('sends a revisit turn through the shared stream when sending is allowed', () => {
    setup({ canSend: true });
    fireEvent.click(screen.getByText('revisit'));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "I'd like to revisit my answer to: What is your budget?"
    );
  });

  it('ignores Revisit while the stream cannot send', () => {
    setup({ canSend: false });
    fireEvent.click(screen.getByText('revisit'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('swaps to the completion confirmation (not the chat) once submitted', () => {
    setup({ status: 'completed', canSend: false });
    expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('shows the completion screen for a reopened completed session, not the "not active" chat', () => {
    // On resume the stream starts idle (no in-session submit fired), so the lifecycle status read
    // is the authority that the session is already done. Without this the surface would drop into
    // the chat and 409 on any send, flashing the "session no longer active" panel.
    setup(
      { status: 'not_active', canSend: false },
      {},
      {
        view: {
          status: 'completed',
          completion: {
            kind: 'offer',
            coverage: 1,
            displayCoverage: 1,
            answeredCount: 6,
            requiredUnansweredKeys: [],
            capReached: false,
            earlyFinishAvailable: false,
          },
          cost: null,
          anonymous: true,
          ref: 'GSP289HB',
        },
      }
    );
    expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });

  it('wires the lifecycle bar Pause/Resume controls to the hook actions', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    setup({}, {}, { canPause: true, canResume: true, pause, resume });

    fireEvent.click(screen.getByText('bar-pause'));
    fireEvent.click(screen.getByText('bar-resume'));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('shows the completion offer and wires Submit when the session is submittable', () => {
    const submit = vi.fn();
    setup({}, {}, { canSubmit: true, submit });

    fireEvent.click(screen.getByText('offer-submit'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('hides the completion offer when the session is not submittable', () => {
    setup({}, {}, { canSubmit: false });
    expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
  });

  it('shows the early-finish control and wires Finish when only the escape hatch is unlocked', () => {
    const finishEarly = vi.fn();
    setup({}, {}, { canSubmit: false, canFinishEarly: true, finishEarly });

    expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('early-finish'));
    expect(finishEarly).toHaveBeenCalledTimes(1);
  });

  it('prefers the full submit offer over the early-finish control when both are available', () => {
    setup({}, {}, { canSubmit: true, canFinishEarly: true });
    expect(screen.getByTestId('completion-offer')).toBeInTheDocument();
    expect(screen.queryByTestId('early-finish-control')).not.toBeInTheDocument();
  });

  describe('read-only mode (admin viewer)', () => {
    it('renders only the read-only transcript — no panel, lifecycle bar, completion offer, or form', () => {
      render(<SessionWorkspace sessionId="s1" readOnly />);
      const chat = screen.getByTestId('chat');
      expect(chat).toHaveAttribute('data-read-only', 'true');
      expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('lifecycle-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('form')).not.toBeInTheDocument();
    });

    it('makes the panel, lifecycle, and form hooks inert (enabled: false) — no fetches', () => {
      render(<SessionWorkspace sessionId="s1" readOnly />);
      expect(panelHook.mock.calls[0][0]).toMatchObject({ enabled: false });
      expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ enabled: false });
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: false });
    });

    it('shows the conversation (not the completion screen) for a completed session', () => {
      streamHook.mockReturnValue({ canSend: false, status: 'completed', sendMessage, applyStatus });
      render(<SessionWorkspace sessionId="s1" readOnly />);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.queryByTestId('session-complete')).not.toBeInTheDocument();
    });
  });

  describe('presentation mode (P-presentation)', () => {
    it('chat mode renders chat + panel, no form, and keeps the form hook inert', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.getByTestId('panel')).toBeInTheDocument();
      expect(screen.queryByTestId('form')).not.toBeInTheDocument();
      // The form hook is mounted but disabled (no fetch) in chat-only mode.
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: false });
    });

    it('form mode renders the form, no chat, and enables the form hook', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" />);
      expect(screen.getByTestId('form')).toBeInTheDocument();
      expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: true });
    });

    it('form mode never fires the chat kickoff even with autoStart', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" autoStart />);
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('both mode mounts BOTH surfaces (carousel) with a toggle defaulting to chat', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      // Toggle present and both surfaces are mounted simultaneously (they slide, not mount/unmount).
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.getByTestId('form')).toBeInTheDocument();
      // Chat is the selected tab by default.
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'false');
    });

    it('toggling to Form selects it and re-seeds the form from the server', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
      expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'true');
      expect(formRefresh).toHaveBeenCalledTimes(1);
    });

    it('toggling back to Chat refetches the panel so it reflects form edits', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(refetch).toHaveBeenCalled();
    });
  });

  describe('mobile "Review answers" drawer', () => {
    const questionView = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 3,
      totalCount: 8,
    };
    const dataSlotView = { ...questionView, dataSlotGroups: [], progressPercent: 40 };

    it('renders a mobile-only trigger (lg:hidden) in chat mode', () => {
      setup({}, { view: questionView });
      const trigger = screen.getByRole('button', { name: /review answers/i });
      expect(trigger).toHaveClass('lg:hidden');
    });

    it('omits the trigger in form-only mode (no answer panel there)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" />);
      expect(screen.queryByRole('button', { name: /review answers/i })).not.toBeInTheDocument();
    });

    it('labels the trigger "N of M" in question mode', () => {
      setup({}, { view: questionView });
      expect(screen.getByRole('button', { name: 'Review answers, 3 of 8' })).toBeInTheDocument();
    });

    it('labels the trigger by percent in data-slot mode', () => {
      setup({}, { view: dataSlotView });
      expect(
        screen.getByRole('button', { name: 'Review answers, 40% complete' })
      ).toBeInTheDocument();
    });

    it('opens the drawer reusing the workspace panel view — no second fetch hook', () => {
      setup({}, { view: questionView });
      // One panel (the hidden desktop side panel) before the sheet opens.
      expect(screen.getAllByTestId('panel')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

      const dialog = screen.getByRole('dialog');
      // Two panels now — the desktop side panel plus the drawer panel — both fed by the workspace's
      // single useAnswerPanel return value. Reusing the one view (not a second fetch hook) is what
      // lets both render the same data; the drawer mounts no hook of its own.
      expect(screen.getAllByTestId('panel')).toHaveLength(2);
      expect(within(dialog).getByTestId('panel')).toBeInTheDocument();
    });

    it('closes the drawer when a revisit fires from inside it', () => {
      setup({ canSend: true }, { view: questionView });
      fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByText('revisit'));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps the both-mode ModeToggle alongside the trigger', () => {
      panelHook.mockReturnValue({ view: questionView, loading: false, error: false, refetch });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      expect(screen.getByRole('button', { name: /review answers/i })).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });
  });

  // Carousel navigation (F7.x): the surfaces slide between via the swipe/wheel gesture and arrow
  // keys. `both` mode mounts two surfaces (Chat + Form) so there's something to move between; the
  // active surface is reflected by the selected tab.
  describe('carousel navigation (keyboard / wheel / touch)', () => {
    const selected = (name: string) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');

    it('steps to the next surface on ArrowRight and back on ArrowLeft', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      expect(selected('Chat')).toBe('true');

      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      expect(selected('Form')).toBe('true');
      expect(selected('Chat')).toBe('false');

      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      expect(selected('Chat')).toBe('true');
    });

    it('keeps the slide transition on settled surfaces so non-swipe navigation animates', () => {
      // At rest (no active drag → dragPx 0) every surface carries the transition class, so a tab
      // toggle or arrow-key move slides rather than snapping. Regression guard: gating the transition
      // on `animating` alone dropped it for toggle/keyboard nav (which never call settle()).
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      for (const panel of screen.getAllByRole('tabpanel')) {
        expect(panel.className).toContain('transition-transform');
      }
    });

    it('rubber-bands at the ends — ArrowLeft on the first surface is a no-op', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      expect(selected('Chat')).toBe('true');
    });

    it('ignores arrow keys while typing in a field (the composer owns its caret)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const input = document.createElement('input');
      document.body.appendChild(input);
      // finally so a failed assertion can't leave a focused <input> on document.body, which would
      // corrupt activeElement for the keyboard sibling tests that fire on document.body.
      try {
        input.focus();
        fireEvent.keyDown(input, { key: 'ArrowRight' });
        expect(selected('Chat')).toBe('true'); // unchanged — handed to the field
      } finally {
        input.remove();
      }
    });

    it('ignores arrow keys with a modifier held (browser shortcuts still work)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'ArrowRight', metaKey: true });
      expect(selected('Chat')).toBe('true');
    });

    it('ignores non-arrow keys (only ←/→ navigate)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(selected('Chat')).toBe('true');
    });

    it('does not bind arrow navigation in a single-surface mode', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
      // Only one surface — nothing to navigate, and no tablist to flip.
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });

    it('advances on a decisive horizontal wheel burst (trackpad swipe)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      // Horizontal-dominant burst past the instant-commit trip → forward one surface.
      fireEvent.wheel(carousel, { deltaX: 250, deltaY: 0 });
      expect(selected('Form')).toBe('true');
    });

    it('leaves a vertical-dominant wheel to native scroll (no surface change)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      fireEvent.wheel(carousel, { deltaX: 4, deltaY: 120 });
      expect(selected('Chat')).toBe('true');
    });

    it('commits a horizontal touch drag past the threshold', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      const t = (x: number) => ({
        touches: [{ clientX: x, clientY: 200 }],
        changedTouches: [{ clientX: x, clientY: 200 }],
      });
      // Width is unmeasured in jsdom (0 → 320 fallback), so a ~100px leftward drag clears the 20%
      // commit threshold and advances to the next surface.
      fireEvent.touchStart(carousel, t(300));
      fireEvent.touchMove(carousel, t(280));
      fireEvent.touchMove(carousel, t(180));
      fireEvent.touchEnd(carousel, t(180));
      expect(selected('Form')).toBe('true');
    });
  });
});
