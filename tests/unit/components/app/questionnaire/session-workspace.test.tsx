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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';

const sendMessage = vi.fn();
const applyStatus = vi.fn();
const kickoff = vi.fn();
const refetch = vi.fn();
const lifecycleRefetch = vi.fn();

const streamHook = vi.fn();
const panelHook = vi.fn();
const lifecycleHook = vi.fn();

vi.mock('@/lib/hooks/use-questionnaire-session-stream', () => ({
  useQuestionnaireSessionStream: (opts: unknown) => streamHook(opts),
}));
vi.mock('@/lib/hooks/use-answer-panel', () => ({
  useAnswerPanel: (opts: unknown) => panelHook(opts),
}));
vi.mock('@/lib/hooks/use-session-lifecycle', () => ({
  useSessionLifecycle: (opts: unknown) => lifecycleHook(opts),
}));

// Chat + lifecycle children are irrelevant here — marker stubs keep the render cheap.
vi.mock('@/components/app/questionnaire/chat/questionnaire-chat', () => ({
  QuestionnaireChat: () => <div data-testid="chat" />,
}));
// Lifecycle-bar stub surfaces the Pause/Resume handlers as buttons so the test can verify
// the workspace wires them to the hook's actions.
vi.mock('@/components/app/questionnaire/lifecycle/session-lifecycle-bar', () => ({
  SessionLifecycleBar: ({ onPause, onResume }: { onPause: () => void; onResume: () => void }) => (
    <div data-testid="lifecycle-bar">
      <button type="button" onClick={onPause}>
        bar-pause
      </button>
      <button type="button" onClick={onResume}>
        bar-resume
      </button>
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
vi.mock('@/components/app/questionnaire/lifecycle/session-complete', () => ({
  SessionComplete: () => <div data-testid="session-complete" />,
}));

// Panel stub exposes the props the workspace controls + a button that fires onRevisit.
vi.mock('@/components/app/questionnaire/panel/answer-slot-panel', () => ({
  AnswerSlotPanel: ({
    loading,
    canRevisit,
    onRevisit,
  }: {
    loading: boolean;
    canRevisit: boolean;
    onRevisit: (slot: PanelSlotView) => void;
  }) => (
    <div data-testid="panel" data-loading={String(loading)} data-can-revisit={String(canRevisit)}>
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
  required: true,
  answered: true,
  value: '£10k',
  provenance: 'direct',
  confidence: 0.8,
  rationale: null,
  answeredAtTurnIndex: 2,
  refinementHistory: [],
};

function lifecycleReturn(over: Record<string, unknown> = {}) {
  return {
    view: null,
    loading: false,
    busy: false,
    actionError: null,
    canSubmit: false,
    canPause: false,
    canResume: false,
    refetch: lifecycleRefetch,
    pause: vi.fn(),
    resume: vi.fn(),
    submit: vi.fn(),
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
  render(<SessionWorkspace sessionId="s1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
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
    // A re-render must NOT fire a second kickoff (the ref guard holds across renders).
    rerender(<SessionWorkspace sessionId="s1" autoStart />);

    expect(kickoff).toHaveBeenCalledTimes(1);
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
        answeredCount: 3,
        requiredUnansweredKeys: [],
        capReached: false,
      },
      cost: null,
      anonymous: false,
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
});
