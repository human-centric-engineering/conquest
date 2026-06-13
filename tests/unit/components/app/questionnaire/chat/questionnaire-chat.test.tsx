/**
 * QuestionnaireChat — rendering + composer interaction.
 *
 * The stream state is now owned by `SessionWorkspace` and passed in as the `stream`
 * prop, so the test supplies it directly (no hook mock). Verifies the component renders
 * turns, the in-flight states (thinking / streaming caret), the warning banner, the
 * blocking panels, and that the composer wires Enter / click to `sendMessage`.
 *
 * @see components/app/questionnaire/chat/questionnaire-chat.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';

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
    status: 'idle',
    warning: null,
    error: null,
    canSend: true,
    sendMessage,
    kickoff: vi.fn(),
    dismissError,
    applyStatus: vi.fn(),
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

  it('renders a generic side-band warning as a quiet line', () => {
    hookReturn = makeReturn({
      warning: { code: 'fail_soft', message: 'A detail could not be checked.' },
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText('A detail could not be checked.')).toBeInTheDocument();
    // Not the contradiction callout.
    expect(screen.queryByText(/I noticed something/i)).not.toBeInTheDocument();
  });

  it('renders a flagged contradiction as the "I noticed something" callout', () => {
    // The orchestrator emits a `contradiction`-coded warning whose message is the agent's probe.
    hookReturn = makeReturn({
      warning: { code: 'contradiction', message: 'That differs from your earlier answer.' },
    });
    render(<QuestionnaireChat sessionId="s1" stream={hookReturn} />);

    expect(screen.getByText(/I noticed something/i)).toBeInTheDocument();
    expect(screen.getByText('That differs from your earlier answer.')).toBeInTheDocument();
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

  describe('opening animation', () => {
    it('types the seeded opening turn in (caret first, full text after) when animateOpening is set', async () => {
      hookReturn = makeReturn({
        turns: [{ role: 'assistant', content: 'Welcome to the questionnaire.' }],
      });
      const { container } = render(
        <QuestionnaireChat sessionId="s1" stream={hookReturn} animateOpening />
      );

      // Mid-type: the streaming caret shows and the full greeting isn't revealed yet.
      expect(container.querySelector('.terminal-caret')).toBeTruthy();

      // The typewriter catches up to the full greeting.
      await waitFor(() =>
        expect(screen.getByText('Welcome to the questionnaire.')).toBeInTheDocument()
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
      await waitFor(() => expect(screen.getByText('Opening greeting.')).toBeInTheDocument());

      // A reply lands as a committed turn (index 1, past the seeded count) — it types itself in.
      const next = makeReturn({
        turns: [
          { role: 'assistant', content: 'Opening greeting.' },
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
  });
});
