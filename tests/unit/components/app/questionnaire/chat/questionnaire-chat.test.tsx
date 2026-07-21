/**
 * QuestionnaireChat — rendering + composer interaction.
 *
 * The stream state is now owned by `SessionWorkspace` and passed in as the `stream`
 * prop, so the test supplies it directly (no hook mock). Verifies the component renders
 * turns, the in-flight states (thinking / streaming caret), the per-turn side-band notices
 * (attached to the turn they belong to, so they persist), the blocking panels, and that the
 * composer wires Enter / click to `sendMessage`.
 *
 * @see components/app/questionnaire/chat/questionnaire-chat.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import {
  AUTO_REVEAL_DWELL_MS,
  AUTO_REVEAL_COLLAPSE_MS,
} from '@/components/app/questionnaire/chat/reasoning-trace';

const sendMessage = vi.fn();
const dismissError = vi.fn();

let hookReturn: UseQuestionnaireSessionStreamReturn;

vi.mock('@/components/admin/orchestration/chat/mic-button', () => ({
  MicButton: ({
    onTranscript,
    onError,
    disabled,
  }: {
    onTranscript: (t: string) => void;
    onError: (m: string) => void;
    disabled?: boolean;
  }) => (
    <div>
      <button
        type="button"
        aria-label="Start voice input"
        disabled={disabled}
        onClick={() => onTranscript('voiced')}
      >
        mic
      </button>
      <button
        type="button"
        aria-label="Trigger voice error"
        onClick={() => onError('Mic unavailable')}
      >
        err
      </button>
    </div>
  ),
}));

// HTMLElement.scrollIntoView is not implemented in happy-dom.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';

function makeReturn(
  overrides: Partial<UseQuestionnaireSessionStreamReturn> = {}
): UseQuestionnaireSessionStreamReturn {
  return {
    turns: [],
    streaming: false,
    streamingText: '',
    inspectorTurns: [],
    status: 'idle',
    error: null,
    canSend: true,
    sendMessage,
    kickoff: vi.fn(),
    dismissError,
    retry: vi.fn(),
    applyStatus: vi.fn(),
    appendAgentTurn: vi.fn(),
    ...overrides,
  };
}

describe('QuestionnaireChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookReturn = makeReturn();
  });

  it('renders user and assistant turns', () => {
    hookReturn = makeReturn({
      turns: [
        { role: 'assistant', content: 'What is your name?' },
        { role: 'user', content: 'Ada' },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText('What is your name?')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  /**
   * The consuming half of the respondent text-size contract. SessionWorkspace publishes
   * `--cq-chat-scale`, but the size only changes if the transcript opts in via `.cq-chat-scale`
   * (globals.css) AND the bubbles leave their own size unpinned so they inherit it. Both are
   * invisible to the workspace's own tests, which mock this component out entirely.
   *
   * @see .context/app/questionnaire/chat-text-size.md
   */
  it('opts the transcript into the respondent text scale and lets bubbles inherit it', () => {
    hookReturn = makeReturn({
      turns: [
        { role: 'assistant', content: 'What is your name?' },
        { role: 'user', content: 'Ada' },
      ],
    });
    const { container } = render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    const transcript = container.querySelector('.cq-chat-scale');
    expect(transcript).not.toBeNull();

    // The user bubble must NOT pin its own font-size: re-adding a `text-*` class here silently
    // breaks the preference for that element while every other test stays green.
    const bubble = screen.getByText('Ada');
    expect(transcript?.contains(bubble)).toBe(true);
    expect(bubble.className).not.toMatch(/\btext-(xs|sm|base|lg|xl)\b/);
  });

  it('shows a thinking indicator while streaming with no text yet', () => {
    hookReturn = makeReturn({ streaming: true, streamingText: '', canSend: false });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByRole('status', { name: 'Thinking…' })).toBeInTheDocument();
  });

  it('shows the thinking indicator (not raw partial text) while a reply is in flight', () => {
    // The reply is no longer rendered token-by-token; it types itself in once it lands as a
    // committed turn, so an in-flight stream shows only the thinking indicator.
    hookReturn = makeReturn({ streaming: true, streamingText: 'Let me think', canSend: false });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByRole('status', { name: 'Thinking…' })).toBeInTheDocument();
    expect(screen.queryByText(/Let me think/)).not.toBeInTheDocument();
  });

  it('renders a generic side-band notice as a quiet line beneath its turn', () => {
    // Notices ride on the assistant turn that raised them (settled history renders them inline).
    hookReturn = makeReturn({
      turns: [
        {
          role: 'assistant',
          content: 'A question.',
          warnings: [{ code: 'fail_soft', message: 'A detail could not be checked.' }],
        },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText('A detail could not be checked.')).toBeInTheDocument();
    // Not the contradiction callout.
    expect(screen.queryByText(/I noticed something/i)).not.toBeInTheDocument();
  });

  it('renders a flagged contradiction as the "I noticed something" callout beneath its turn', () => {
    // The orchestrator emits a `contradiction`-coded warning whose message is the agent's probe.
    hookReturn = makeReturn({
      turns: [
        {
          role: 'assistant',
          content: 'A question.',
          warnings: [{ code: 'contradiction', message: 'That differs from your earlier answer.' }],
        },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText(/I noticed something/i)).toBeInTheDocument();
    expect(screen.getByText('That differs from your earlier answer.')).toBeInTheDocument();
  });

  it('keeps an earlier turn’s notice on screen once a later turn is added', () => {
    // The core fix: a notice is pinned to its turn, so a subsequent turn no longer wipes it
    // (the prior bug — the single transient banner cleared on the next input).
    hookReturn = makeReturn({
      turns: [
        {
          role: 'assistant',
          content: 'First question.',
          warnings: [{ code: 'seriousness', message: "Let's keep it genuine please." }],
        },
        { role: 'user', content: 'a real answer' },
        { role: 'assistant', content: 'Second question.' },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    // Both the later turn AND the earlier turn's notice are present.
    expect(screen.getByText('Second question.')).toBeInTheDocument();
    expect(screen.getByText("Let's keep it genuine please.")).toBeInTheDocument();
  });

  it('renders the reasoning trace closed for a turn already present at mount (historical, overlay placement)', () => {
    // The "Animated" (overlay) placement auto-reveals only NEWLY-ARRIVED turns. A turn present at
    // mount is history — it must render the collapsed chip closed, never flashing open on load.
    hookReturn = makeReturn({
      turns: [
        {
          role: 'assistant',
          content: 'A question.',
          reasoning: [{ kind: 'extraction', label: 'Captured your name', tone: 'neutral' }],
        },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} reasoningPlacement="overlay" />);

    const chip = screen.getByRole('button', { name: /reasoning/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('auto-reveals (mounts open) the reasoning trace on the newest turn under the overlay placement', async () => {
    // Mount with just the respondent's turn so `openingTurnCount` is 1; the assistant turn then
    // ARRIVES (index 1 ≥ openingTurnCount) and is the newest, so its trace auto-reveals open.
    hookReturn = makeReturn({ turns: [{ role: 'user', content: 'Ada' }] });
    const { rerender } = render(
      <QuestionnaireChat sessionId="s1" stream={hookReturn} reasoningPlacement="overlay" />
    );

    hookReturn = makeReturn({
      turns: [
        { role: 'user', content: 'Ada' },
        {
          role: 'assistant',
          content: 'Thanks, Ada.',
          reasoning: [{ kind: 'selection', label: 'Asking about your role next', tone: 'insight' }],
        },
      ],
    });
    rerender(<QuestionnaireChat sessionId="s1" stream={hookReturn} reasoningPlacement="overlay" />);

    // The trace mounts OPEN (autoReveal) — the chip's disclosure is expanded on arrival.
    const chip = await screen.findByRole('button', { name: /reasoning/i });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
  });

  it('holds the next question back until the auto-revealed reasoning has closed (overlay)', () => {
    // The respondent should read the reasoning first: under "Animated", the reply must not start
    // typing until the trace has dwelled (2s) and animated closed. Fake timers drive the sequence.
    vi.useFakeTimers();
    try {
      hookReturn = makeReturn({ turns: [{ role: 'user', content: 'Ada' }] });
      const { rerender } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} reasoningPlacement="overlay" />
      );

      hookReturn = makeReturn({
        turns: [
          { role: 'user', content: 'Ada' },
          {
            role: 'assistant',
            content: 'What is your current role?',
            reasoning: [
              { kind: 'selection', label: 'Asking about your role next', tone: 'insight' },
            ],
          },
        ],
      });
      act(() => {
        rerender(
          <QuestionnaireChat sessionId="s1" stream={hookReturn} reasoningPlacement="overlay" />
        );
      });

      // During the hold: the reasoning is open and the question has NOT begun typing.
      const chip = screen.getByRole('button', { name: /reasoning/i });
      expect(chip).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByText(/What is your current role/)).not.toBeInTheDocument();

      // After the 2s dwell: the trace has closed, but the question is still held (collapse pending).
      act(() => {
        vi.advanceTimersByTime(AUTO_REVEAL_DWELL_MS);
      });
      expect(chip).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText(/What is your current role/)).not.toBeInTheDocument();

      // The collapse window elapses → the hold releases and the typewriter is kicked off (the
      // interval is created on this commit, so it needs a further tick to actually type).
      act(() => {
        vi.advanceTimersByTime(AUTO_REVEAL_COLLAPSE_MS);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/What is your current role/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not render a reasoning trace when no placement is set even if the turn carries steps', () => {
    // Feature off (no placement) ⇒ TurnReasoning renders nothing regardless of the turn's steps.
    hookReturn = makeReturn({
      turns: [
        {
          role: 'assistant',
          content: 'A question.',
          reasoning: [{ kind: 'extraction', label: 'Captured your name', tone: 'neutral' }],
        },
      ],
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.queryByRole('button', { name: /reasoning/i })).not.toBeInTheDocument();
  });

  it('sends on Send click and clears the composer', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    const textarea = screen.getByLabelText('Your answer');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // No attachments selected → second arg is undefined.
    expect(sendMessage).toHaveBeenCalledWith('hello', undefined);
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);
    const textarea = screen.getByLabelText('Your answer');

    fireEvent.change(textarea, { target: { value: 'first' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends on Enter', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);
    const textarea = screen.getByLabelText('Your answer');

    fireEvent.change(textarea, { target: { value: 'first' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(sendMessage).toHaveBeenCalledWith('first', undefined);
  });

  it('hides the platform attachment picker unless attachmentInputEnabled', () => {
    const { rerender } = render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);
    expect(screen.queryByTestId('attachment-picker-button')).not.toBeInTheDocument();

    rerender(<QuestionnaireChat sessionId="s1" stream={hookReturn} attachmentInputEnabled />);
    // The composer mounts the shared <AttachmentPickerButton> (useAttachments hook),
    // not a hand-rolled file input.
    expect(screen.getByTestId('attachment-picker-button')).toBeInTheDocument();
  });

  it('disables the composer when sending is not allowed', () => {
    hookReturn = makeReturn({ streaming: true, canSend: false });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByLabelText('Your answer')).toBeDisabled();
  });

  it('hides the composer and shows a terminal panel when cost-capped', () => {
    hookReturn = makeReturn({
      status: 'cost_capped',
      error: {
        code: 'COST_CAP_REACHED',
        title: "We've reached this conversation's limit",
        message: 'Budget used up.',
      },
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText("We've reached this conversation's limit")).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
    // Terminal panels never have a dismiss control.
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument();
  });

  it('renders the mic button only when voice input is enabled', () => {
    const { rerender } = render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);
    expect(screen.queryByLabelText('Start voice input')).not.toBeInTheDocument();

    rerender(<QuestionnaireChat sessionId="s1" stream={hookReturn} voiceInputEnabled />);
    expect(screen.getByLabelText('Start voice input')).toBeInTheDocument();
  });

  it('does not send when input is whitespace-only', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);
    const textarea = screen.getByLabelText('Your answer');

    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('appends a transcript to existing textarea content (voice onTranscript)', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} voiceInputEnabled />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Your answer');

    fireEvent.change(textarea, { target: { value: 'existing' } });
    fireEvent.click(screen.getByLabelText('Start voice input'));

    expect(textarea.value).toBe('existing voiced');
  });

  it('sets textarea to transcript when it was empty (voice onTranscript)', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} voiceInputEnabled />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Your answer');

    fireEvent.click(screen.getByLabelText('Start voice input'));

    expect(textarea.value).toBe('voiced');
  });

  it('shows a role=alert with the error message on voice onError', () => {
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} voiceInputEnabled />);

    fireEvent.click(screen.getByLabelText('Trigger voice error'));

    expect(screen.getByRole('alert')).toHaveTextContent('Mic unavailable');
  });

  it('shows a dismiss control for transient errors and calls dismissError on click', () => {
    hookReturn = makeReturn({
      status: 'error',
      error: { code: 'STREAM_ERROR', title: 'Something went wrong', message: 'x' },
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    const dismissBtn = screen.getByLabelText('Dismiss');
    expect(dismissBtn).toBeInTheDocument();
    fireEvent.click(dismissBtn);

    expect(dismissError).toHaveBeenCalledTimes(1);
  });

  describe('composer wait cue + reveal-queue gate', () => {
    it('shows a "Waiting for a reply…" cue at the composer while a reply is streaming', () => {
      hookReturn = makeReturn({ streaming: true, canSend: false });
      render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

      // The disabled box is no longer silent — an explicit status cue sits above it.
      expect(screen.getByRole('status', { name: 'Waiting for a reply…' })).toBeInTheDocument();
      expect(screen.getByLabelText('Your answer')).toBeDisabled();
    });

    it('keeps the composer disabled with a "Revealing the reply…" cue while the queue is still typing (stream already closed)', () => {
      // The gate fix: streaming has ended (`canSend` true) but the opening greeting hasn't finished
      // revealing. The composer must stay closed — and say why — so the respondent can't answer a
      // question that is still typing onto the screen (or, on the opening burst, not yet visible).
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'Welcome to the questionnaire.' }],
        streaming: false,
        canSend: true,
      });
      render(<QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />);

      expect(screen.getByLabelText('Your answer')).toBeDisabled();
      expect(screen.getByRole('status', { name: 'Revealing the reply…' })).toBeInTheDocument();
    });

    it('does not send on Enter while the reveal queue is still typing', () => {
      // `handleSend` guards on the same reveal-aware readiness as the disabled state, so even a
      // forced keydown on the (disabled) textarea cannot race the queue.
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'Welcome.' }],
        streaming: false,
        canSend: true,
      });
      render(<QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />);

      const textarea = screen.getByLabelText('Your answer');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('enables the composer and drops the wait cue once the stream has closed and the queue has caught up', () => {
      // animateOpening off ⇒ the seeded turn is settled history (cursor already past it), stream idle.
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'A settled question.' }],
        streaming: false,
        canSend: true,
      });
      render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

      expect(screen.getByLabelText('Your answer')).not.toBeDisabled();
      // No "thinking" affordance anywhere — not in the transcript, not at the composer.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  describe('opening animation', () => {
    it('shows a "Thinking…" beat before the seeded opening message, then types it in', async () => {
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'Welcome to the questionnaire.' }],
      });
      const { container } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />
      );

      // The opening is fronted by a "Thinking…" indicator — the greeting hasn't started yet.
      expect(screen.getByRole('status', { name: 'Thinking…' })).toBeInTheDocument();
      expect(container.querySelector('.terminal-caret')).toBeNull();
      expect(screen.queryByText('Welcome to the questionnaire.')).toBeNull();

      // After the beat it types in to the full greeting.
      await waitFor(
        () => expect(screen.getByText('Welcome to the questionnaire.')).toBeInTheDocument(),
        { timeout: 3000 }
      );
    });

    it('renders the opening turn instantly (no caret) when animateOpening is not set', () => {
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'Welcome to the questionnaire.' }],
      });
      const { container } = render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

      expect(screen.getByText('Welcome to the questionnaire.')).toBeInTheDocument();
      expect(container.querySelector('.terminal-caret')).toBeNull();
    });

    it('types in a reply that arrives after mount (caret first, full text after)', async () => {
      // Fresh mount with just the seeded greeting.
      hookReturn = makeReturn({ turns: [{ role: 'assistant', content: 'Opening greeting.' }] });
      const { container, rerender } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />
      );
      // The greeting types in after its opening "Thinking…" beat.
      await waitFor(() => expect(screen.getByText('Opening greeting.')).toBeInTheDocument(), {
        timeout: 3000,
      });

      // The respondent answers, then a reply lands — a genuine post-answer reply (a user turn
      // precedes it), so it types straight in with no artificial opening beat.
      const next = makeReturn({
        turns: [
          { role: 'assistant', content: 'Opening greeting.' },
          { role: 'user', content: 'My answer.' },
          { role: 'assistant', content: 'A later question.' },
        ],
      });
      rerender(<QuestionnaireChat sessionId="s1" stream={next} animateOpening />);

      // Mid-type: a caret is present and the full reply isn't shown yet…
      expect(container.querySelector('.terminal-caret')).toBeTruthy();
      // …then it catches up.
      await waitFor(() => expect(screen.getByText('A later question.')).toBeInTheDocument());
    });

    it('types in a reply even on a resumed session (animateOpening off)', async () => {
      // Resume seeds prior history (rendered instantly); a new reply still types in.
      hookReturn = makeReturn({ turns: [{ role: 'assistant', content: 'Earlier history.' }] });
      const { container, rerender } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} />
      );
      // Seeded history is instant (no caret).
      expect(screen.getByText('Earlier history.')).toBeInTheDocument();
      expect(container.querySelector('.terminal-caret')).toBeNull();

      const next = makeReturn({
        turns: [
          { role: 'assistant', content: 'Earlier history.' },
          { role: 'assistant', content: 'A fresh reply.' },
        ],
      });
      rerender(<QuestionnaireChat sessionId="s1" stream={next} />);

      await waitFor(() => expect(screen.getByText('A fresh reply.')).toBeInTheDocument());
    });

    it('reveals two seeded opening turns one at a time (the second waits for the first)', async () => {
      hookReturn = makeReturn({
        turns: [
          { role: 'assistant', content: 'First opening message.' },
          { role: 'assistant', content: 'Second opening message.' },
        ],
      });
      render(<QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />);

      // The second opening turn is gated — it isn't even in the DOM until the first finishes.
      expect(screen.queryByText('Second opening message.')).toBeNull();

      // The first types in after its opening beat…
      await waitFor(() => expect(screen.getByText('First opening message.')).toBeInTheDocument(), {
        timeout: 3000,
      });
      // …then, after the longer inter-message beat, the second types in too.
      await waitFor(() => expect(screen.getByText('Second opening message.')).toBeInTheDocument(), {
        timeout: 5000,
      });
    });

    it('queues a second opening turn that ARRIVES AFTER MOUNT behind the first (no overlap)', async () => {
      // The reported bug: only the greeting is seeded; the first question streams in moments later
      // (a post-mount turn). It must NOT type over the still-typing greeting — the queue holds it.
      hookReturn = makeReturn({ turns: [{ role: 'assistant', content: 'First message.' }] });
      const { rerender } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />
      );

      const next = makeReturn({
        turns: [
          { role: 'assistant', content: 'First message.' },
          { role: 'assistant', content: 'Second message.' },
        ],
      });
      rerender(<QuestionnaireChat sessionId="s1" stream={next} animateOpening />);

      // Queued behind the first — not in the DOM while the first is still revealing.
      expect(screen.queryByText('Second message.')).toBeNull();

      // Both type in, in order.
      await waitFor(() => expect(screen.getByText('First message.')).toBeInTheDocument(), {
        timeout: 3000,
      });
      await waitFor(() => expect(screen.getByText('Second message.')).toBeInTheDocument(), {
        timeout: 5000,
      });
    });
  });
});
