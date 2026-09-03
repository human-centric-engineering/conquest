// @vitest-environment happy-dom

/**
 * Sectioned interviews (P21) — the handover beat.
 *
 * The reply has just said "That's everything for Opening. I'll take us on to Growth now." Something
 * has to make that true. Before this, nothing did: the interviewer asked "Ready to move on?", the
 * respondent said yes, and the next turn found the same empty part and asked again.
 *
 * What is under test here is the BEAT — the couple of seconds between the promise and the move —
 * because it is the piece with a clock in it, and because every way it can go wrong strands a
 * respondent: a beat that never fires leaves the interview stopped, and one that fires twice moves
 * them two parts on.
 *
 * @see components/app/questionnaire/chat/conversation-context.tsx
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import {
  ConversationProvider,
  SECTION_HANDOVER_DWELL_MS,
} from '@/components/app/questionnaire/chat/conversation-context';
import { ChatTranscript } from '@/components/app/questionnaire/chat/chat-transcript';
import type {
  SectionHandover,
  UseQuestionnaireSessionStreamReturn,
} from '@/lib/hooks/use-questionnaire-session-stream';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

const HANDOVER: SectionHandover = { sectionKey: 'opening', nextLabel: 'Growth Strategy' };

beforeEach(() => {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function streamStub(over: Partial<UseQuestionnaireSessionStreamReturn> = {}) {
  return {
    turns: [
      { role: 'assistant', content: 'Welcome.' },
      { role: 'assistant', content: "That's everything for Opening. I'll take us on to Growth." },
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

function renderBeat(opts: {
  handover: SectionHandover | null;
  onHandover: () => void;
  /** True mid-reveal: the reply announcing the move has not finished typing itself in. */
  revealing?: boolean;
}) {
  const stream = streamStub();
  return render(
    <ConversationProvider
      stream={stream}
      animateOpening={opts.revealing ?? false}
      sectionHandover={opts.handover}
      onSectionHandover={opts.onHandover}
    >
      <ChatTranscript sessionId="s1" stream={stream} />
    </ConversationProvider>
  );
}

describe('the section handover beat', () => {
  it('names where the interview is going, then makes the move', () => {
    const onHandover = vi.fn();
    renderBeat({ handover: HANDOVER, onHandover });

    // The cue, in place of the silence the conversation used to fall into.
    expect(screen.getByTestId('turn-progress-label')).toHaveTextContent(
      'Moving on to Growth Strategy'
    );
    expect(onHandover).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SECTION_HANDOVER_DWELL_MS);
    });

    expect(onHandover).toHaveBeenCalledTimes(1);
  });

  it('retires the cue when the beat is up, whatever happens to the move', () => {
    // The move usually leads straight into the next part's opening turn, whose own stage labels take
    // this row over. But a refused move (the gate widened under them) leaves the respondent with the
    // reply and their own control — and a cue still claiming the interview was moving would be a lie
    // for the rest of the session.
    const onHandover = vi.fn();
    renderBeat({ handover: HANDOVER, onHandover });

    act(() => {
      vi.advanceTimersByTime(SECTION_HANDOVER_DWELL_MS);
    });

    expect(screen.queryByTestId('turn-progress-label')).toBeNull();
  });

  it('waits for the reply announcing the move to finish revealing', () => {
    // Firing on the stream closing alone would move the respondent out of a part while the sentence
    // explaining why was still typing itself in.
    const onHandover = vi.fn();
    renderBeat({ handover: HANDOVER, onHandover, revealing: true });

    act(() => {
      vi.advanceTimersByTime(SECTION_HANDOVER_DWELL_MS * 3);
    });

    expect(onHandover).not.toHaveBeenCalled();
  });

  it('cancels the move when the handover is withdrawn mid-beat', () => {
    // What lets a respondent keep talking: sending a message clears the stream's handover, and the
    // beat has to abandon rather than move them out from under their own answer.
    const onHandover = vi.fn();
    const { rerender } = renderBeat({ handover: HANDOVER, onHandover });

    const stream = streamStub();
    rerender(
      <ConversationProvider
        stream={stream}
        animateOpening={false}
        sectionHandover={null}
        onSectionHandover={onHandover}
      >
        <ChatTranscript sessionId="s1" stream={stream} />
      </ConversationProvider>
    );

    act(() => {
      vi.advanceTimersByTime(SECTION_HANDOVER_DWELL_MS * 2);
    });

    expect(onHandover).not.toHaveBeenCalled();
    expect(screen.queryByTestId('turn-progress-label')).toBeNull();
  });

  it('shows nothing at all on an ordinary turn', () => {
    renderBeat({ handover: null, onHandover: vi.fn() });
    expect(screen.queryByTestId('turn-progress-label')).toBeNull();
  });
});
