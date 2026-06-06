/**
 * SessionWorkspace — the chat + answer-panel split-screen wiring (F7.2).
 *
 * Both hooks and both children are mocked so the test pins SessionWorkspace's OWN
 * responsibilities, not theirs: that the single stream is created with
 * `onTurnSettled` wired to the panel's `refetch`, that the panel's view/loading and
 * the stream's `canSend` are threaded down, and that the Revisit handler sends a
 * correctly-phrased turn through the shared stream only when sending is allowed.
 *
 * @see components/app/questionnaire/session-workspace.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';

const sendMessage = vi.fn();
const refetch = vi.fn();

const streamHook = vi.fn();
const panelHook = vi.fn();

vi.mock('@/lib/hooks/use-questionnaire-session-stream', () => ({
  useQuestionnaireSessionStream: (opts: unknown) => streamHook(opts),
}));
vi.mock('@/lib/hooks/use-answer-panel', () => ({
  useAnswerPanel: (opts: unknown) => panelHook(opts),
}));

// Chat is irrelevant here — a marker stub keeps the render cheap.
vi.mock('@/components/app/questionnaire/chat/questionnaire-chat', () => ({
  QuestionnaireChat: () => <div data-testid="chat" />,
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

function setup(streamOver: Record<string, unknown> = {}, panelOver: Record<string, unknown> = {}) {
  streamHook.mockReturnValue({ canSend: true, sendMessage, ...streamOver });
  panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch, ...panelOver });
  render(<SessionWorkspace sessionId="s1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionWorkspace', () => {
  it('creates the stream with onTurnSettled wired to the panel refetch', () => {
    setup();
    const opts = streamHook.mock.calls[0][0];
    expect(opts.onTurnSettled).toBe(refetch);
  });

  it('threads the session id and access token into both hooks', () => {
    streamHook.mockReturnValue({ canSend: true, sendMessage });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    render(<SessionWorkspace sessionId="s1" accessToken="tok-9" />);

    expect(panelHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
    expect(streamHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
  });

  it('seeds useAnswerPanel with the SSR-resolved initialPanel view', () => {
    streamHook.mockReturnValue({ canSend: true, sendMessage });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
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
});
