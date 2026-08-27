// @vitest-environment happy-dom

/**
 * The transcript and the composer, placed APART.
 *
 * `questionnaire-chat.test.tsx` covers the conversation as one assembled component, which is how
 * the read-only viewer and every layout but Broadsheet render it. This file covers the thing the
 * `transcript` / `composer` slot split newly makes possible, and therefore the thing that can newly
 * break: the two halves mounted as unrelated siblings, with a layout's own markup between them.
 *
 * The risk is specific. The composer must stay shut until BOTH the HTTP stream has closed AND the
 * transcript's reveal queue has finished typing the reply in — otherwise a respondent can answer a
 * question they have not finished reading, or (during the opening burst) one still entirely hidden.
 * While the two lived in one component that gate was a local variable. Now it travels through
 * `ConversationProvider`, and "travels correctly when the two are not adjacent" is the assertion.
 *
 * @see components/app/questionnaire/chat/conversation-context.tsx
 * @see components/app/questionnaire/layouts/broadsheet-layout.tsx
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConversationProvider } from '@/components/app/questionnaire/chat/conversation-context';
import { ChatTranscript } from '@/components/app/questionnaire/chat/chat-transcript';
import { ChatComposer } from '@/components/app/questionnaire/chat/chat-composer';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

// happy-dom implements neither of these; the transcript calls scrollIntoView on every settle.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});

function streamStub(over: Partial<UseQuestionnaireSessionStreamReturn> = {}) {
  return {
    turns: [
      { role: 'assistant', content: 'Welcome.' },
      { role: 'assistant', content: 'What brought you here today?' },
    ],
    streaming: false,
    inspectorTurns: [],
    status: 'idle' as QuestionnaireChatStatus,
    error: null,
    canSend: true,
    sendMessage: vi.fn(),
    continueAfterCard: vi.fn(),
    dismissError: vi.fn(),
    retry: vi.fn(),
    ...over,
  } as unknown as UseQuestionnaireSessionStreamReturn;
}

/**
 * The two halves as a layout with a margin would place them: separate subtrees, with the composer
 * NOT a descendant of the transcript's box. If the gate ever depended on proximity rather than the
 * provider, this arrangement is where it would stop working.
 */
function renderSplit(stream: UseQuestionnaireSessionStreamReturn, animateOpening: boolean) {
  return render(
    <ConversationProvider stream={stream} animateOpening={animateOpening}>
      <div data-testid="document-column">
        <ChatTranscript sessionId="s1" stream={stream} />
      </div>
      <aside data-testid="margin">
        <ChatComposer sessionId="s1" stream={stream} />
      </aside>
    </ConversationProvider>
  );
}

describe('transcript and composer placed apart', () => {
  it('opens the composer once the stream has closed and the queue has caught up', () => {
    // A resumed session: history is already settled, so the queue starts past it and nothing is
    // waiting to be typed in.
    renderSplit(streamStub(), false);

    expect(screen.getByLabelText('Your answer')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); // empty input, not the gate
  });

  it('holds the composer shut while the transcript is still revealing a reply', () => {
    // A fresh session types its opening turns in one at a time. `canSend` is already true — the
    // HTTP stream closed the moment the turns committed — so ONLY the reveal queue is holding the
    // box, which is exactly the signal that has to cross from one subtree to the other.
    renderSplit(streamStub({ canSend: true }), true);

    const box = screen.getByLabelText('Your answer');
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'Revealing the reply…');
  });

  it('holds the composer shut while a reply is still streaming, and says so', () => {
    renderSplit(streamStub({ canSend: false, streaming: true }), false);

    expect(screen.getByLabelText('Your answer')).toHaveAttribute(
      'placeholder',
      'Waiting for a reply…'
    );
  });

  it('keeps the composer out of the transcript subtree — the arrangement is real, not nominal', () => {
    // Guards the premise of the test above rather than any production code: if a future edit nested
    // the two, every assertion here would still pass while testing nothing about the split.
    renderSplit(streamStub(), false);

    const margin = screen.getByTestId('margin');
    const document_ = screen.getByTestId('document-column');
    expect(margin.contains(screen.getByLabelText('Your answer'))).toBe(true);
    expect(document_.contains(screen.getByLabelText('Your answer'))).toBe(false);
  });

  it('refuses to render a half with no provider above it', () => {
    // A layout host that forgets the provider would otherwise get a composer that silently decided
    // it was ready — opening mid-reveal, the precise failure the queue exists to prevent. Loud is
    // the only safe direction here.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ChatComposer sessionId="s1" stream={streamStub()} />)).toThrow(
      /ConversationProvider/
    );
    quiet.mockRestore();
  });
});
