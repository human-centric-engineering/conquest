// @vitest-environment happy-dom

/**
 * The history and the current exchange, placed APART.
 *
 * `questionnaire-chat.test.tsx` covers the conversation as one assembled component, which is how
 * the read-only viewer and three of the four layouts render it. This file covers what the
 * `history` / `currentExchange` split newly makes possible, and therefore what can newly break:
 * the two halves mounted as unrelated siblings, as Horizon mounts them — one on a stage, the other
 * folded into a disclosure above it.
 *
 * Two risks, both specific:
 *
 *   1. The cut. Each half decides what to render from the same boundary; if they disagree, a turn
 *      is either rendered twice or lost. In Horizon that is the whole screen.
 *   2. The clamp. The boundary is held back to the reveal cursor, because a turn still typing
 *      itself in must not be moved into the history under it — it would unmount mid-reveal, its
 *      `onDone` would never fire, and `composerReady` would stay false for the rest of the session.
 *      The panel's Revisit and Refine both send on `canSend`, so that race is reachable in
 *      production, not theoretical.
 *
 * @see components/app/questionnaire/chat/conversation-context.tsx
 * @see lib/app/questionnaire/chat/exchange.ts
 * @see components/app/questionnaire/layouts/horizon-layout.tsx
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

import { ConversationProvider } from '@/components/app/questionnaire/chat/conversation-context';
import { ChatHistory } from '@/components/app/questionnaire/chat/chat-history';
import { CurrentExchange } from '@/components/app/questionnaire/chat/current-exchange';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type {
  QuestionnaireChatStatus,
  QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';

// happy-dom implements neither of these; the live exchange scrolls itself into view on every settle.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});

const ask = (content: string): QuestionnaireTurn => ({ role: 'assistant', content });
const say = (content: string): QuestionnaireTurn => ({ role: 'user', content });

function streamStub(
  turns: QuestionnaireTurn[],
  over: Partial<UseQuestionnaireSessionStreamReturn> = {}
): UseQuestionnaireSessionStreamReturn {
  return {
    turns,
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
 * The two halves as Horizon places them: separate subtrees, with the history folded away and the
 * live exchange on its own. If either half ever decided the boundary for itself rather than reading
 * it from the provider, this arrangement is where the disagreement would show.
 */
function renderSplit(
  turns: QuestionnaireTurn[],
  animateOpening = false,
  history: Partial<React.ComponentProps<typeof ChatHistory>> = {}
) {
  const stream = streamStub(turns);
  return render(
    <ConversationProvider stream={stream} animateOpening={animateOpening}>
      <div data-testid="folded">
        <ChatHistory stream={stream} {...history} />
      </div>
      <div data-testid="stage">
        <CurrentExchange sessionId="s1" stream={stream} />
      </div>
    </ConversationProvider>
  );
}

/** Two earlier legs of an Experience run, as `stitched` continuity replays them. */
const STITCHED: StitchedHistory = {
  segments: [
    { stepTitle: 'Your situation', turns: [ask('Where are you based?'), say('Leeds.')] },
    { stepTitle: 'What you need', turns: [ask('What is the deadline?'), say('March.')] },
  ],
};

describe('history and current exchange placed apart', () => {
  it('cuts at the respondent’s most recent message', () => {
    // Their answer and the reply it prompted stay together on the stage; what came before is folded.
    renderSplit([ask('Welcome.'), say('I run a bakery.'), ask('What made you start?')]);

    expect(within(screen.getByTestId('folded')).getByText('Welcome.')).toBeInTheDocument();
    const stage = within(screen.getByTestId('stage'));
    expect(stage.getByText('I run a bakery.')).toBeInTheDocument();
    expect(stage.getByText('What made you start?')).toBeInTheDocument();
  });

  it('renders every turn exactly once across the two halves', () => {
    // The failure mode a single component could not have: two halves reading the same array with
    // different ideas of where it splits. Duplicated turns look like the interviewer repeating
    // itself, which is worse than a layout bug — it looks like the product is broken.
    renderSplit([ask('Welcome.'), say('I run a bakery.'), ask('What made you start?')]);

    for (const text of ['Welcome.', 'I run a bakery.', 'What made you start?']) {
      expect(screen.getAllByText(text), text).toHaveLength(1);
    }
  });

  it('keeps the whole opening burst on the stage, with nothing folded behind it', () => {
    // A greeting and the first question arrive together, before the respondent has said anything.
    // Folding the greeting away would hide the interviewer's opening words on the very first screen.
    renderSplit([ask('Welcome.'), ask('What brought you here?')], true);

    expect(screen.getByTestId('folded')).toBeEmptyDOMElement();
  });

  it('will not fold a turn away while it is still typing itself in', () => {
    // The clamp. `canSend` is true a beat before the reveal queue has caught up, so the panel's
    // Revisit can commit a respondent turn while the reply above it is still revealing — which
    // would otherwise move that reply into the history mid-reveal, unmounting it, stranding the
    // queue, and leaving the composer shut for the rest of the session with nothing on screen to
    // explain why.
    renderSplit([ask('Welcome.'), ask('What brought you here?'), say('Revisit: budget')], true);

    // The cursor is still at 0, so the boundary is too: nothing has settled, nothing is folded.
    expect(screen.getByTestId('folded')).toBeEmptyDOMElement();
  });

  it('replays earlier Experience legs above this leg’s own history', () => {
    // `stitched` continuity: the journey reads as one conversation, so the earlier legs sit in the
    // history with the live leg's own settled turns. Rendered as their own block rather than
    // concatenated into `turns`, because the reveal cursor and the typewriter both index that array
    // and replayed history must animate nothing.
    renderSplit([ask('Welcome back.'), say('Ready.'), ask('Next?')], false, {
      stitchedHistory: STITCHED,
      stitchedSeamLabel: 'Today',
    });

    const folded = within(screen.getByTestId('folded'));
    expect(folded.getByText('Where are you based?')).toBeInTheDocument();
    expect(folded.getByText('Leeds.')).toBeInTheDocument();
    expect(folded.getByText('What is the deadline?')).toBeInTheDocument();
  });

  it('labels the seam between legs, and the seam introducing the live one', () => {
    // The dividers are how a respondent knows the earlier answers were theirs and not a mistake.
    renderSplit([ask('Welcome back.'), say('Ready.'), ask('Next?')], false, {
      stitchedHistory: STITCHED,
      stitchedSeamLabel: 'Today',
    });

    const folded = within(screen.getByTestId('folded'));
    // The FIRST segment gets no divider — there is nothing before it to divide from.
    expect(folded.queryByText('Your situation')).toBeNull();
    expect(folded.getByText('What you need')).toBeInTheDocument();
    expect(folded.getByText('Today')).toBeInTheDocument();
  });

  it('draws no seams at all when the author chose the seamless marker', () => {
    // `null` (not `undefined`) is the author saying the journey should read as one unbroken
    // conversation. Every divider goes, including the one introducing the live leg.
    renderSplit([ask('Welcome back.'), say('Ready.'), ask('Next?')], false, {
      stitchedHistory: STITCHED,
      stitchedSeamLabel: null,
    });

    const folded = within(screen.getByTestId('folded'));
    expect(folded.queryByText('What you need')).toBeNull();
    expect(folded.getByText('Where are you based?')).toBeInTheDocument();
  });

  it('shows stitched legs even when this leg has said nothing of its own yet', () => {
    // A fresh leg opens with a greeting and no respondent turn, so there is no history from THIS
    // leg — but the run still has a past, and Horizon must offer it. The container's
    // `hasConversationHistory` counts segments for exactly this case.
    renderSplit([ask('Welcome back.')], false, {
      stitchedHistory: STITCHED,
      stitchedSeamLabel: 'Today',
    });

    expect(within(screen.getByTestId('folded')).getByText('Leeds.')).toBeInTheDocument();
  });

  it('renders no history box at all when there is nothing behind the exchange', () => {
    // Not an empty container — nothing. A column that spaces its children with a gap would
    // otherwise open a gap around nothing, and Horizon's disclosure would have something to wrap.
    renderSplit([ask('Welcome.')]);

    expect(screen.getByTestId('folded')).toBeEmptyDOMElement();
  });
});

describe('the live end of the conversation', () => {
  /** The stage on its own — no history beside it, which is how Horizon renders it. */
  function renderStage(stream: UseQuestionnaireSessionStreamReturn, animateOpening = false) {
    return render(
      <ConversationProvider stream={stream} animateOpening={animateOpening}>
        <CurrentExchange sessionId="s1" stream={stream} />
      </ConversationProvider>
    );
  }

  it('never puts two waiting cues on screen at once', () => {
    // There are two sources of a "Thinking…" cue: the active turn's own opening beat, and the
    // stream-level one for a reply still in flight. Both can be true during the opening burst —
    // the queue is still typing message one while the stream fetches the next — and two of them on
    // screen reads as the interviewer talking over itself. So the stream-level cue is suppressed
    // until the queue has caught up to every committed turn. Asserted as a COUNT, because the
    // invariant is about doubling rather than about either cue individually.
    const stream = streamStub([ask('Welcome.'), ask('What brought you here?')], {
      streaming: true,
    });

    // Animating: the cursor is at 0, so the active turn's beat is showing — and only that.
    const { unmount } = renderStage(stream, true);
    expect(screen.getAllByRole('status', { name: 'Thinking…' })).toHaveLength(1);
    unmount();

    // Settled: nothing is revealing, so the stream-level cue is the only one — again exactly one.
    renderStage(stream, false);
    expect(screen.getAllByRole('status', { name: 'Thinking…' })).toHaveLength(1);
  });

  it('surfaces a stream error with both ways out of it', () => {
    // A respondent stuck behind a failed turn needs the retry; the dismiss is what lets them carry
    // on in the composer instead. Both are the container's callbacks, wired through this half.
    const dismissError = vi.fn();
    const retry = vi.fn();
    const stream = streamStub([ask('Welcome.')], {
      status: 'error' as QuestionnaireChatStatus,
      error: {
        code: 'TURN_FAILED',
        title: 'Something went wrong',
        message: 'The interviewer could not be reached.',
      },
      dismissError,
      retry,
    });

    renderStage(stream);
    expect(screen.getByText('The interviewer could not be reached.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for an error the respondent cannot resend past', () => {
    // Only `error` is transient. A terminal status (capped, expired) still shows what happened, but
    // a "Try again" there would be an invitation to a wall.
    const stream = streamStub([ask('Welcome.')], {
      status: 'cost_capped' as QuestionnaireChatStatus,
      error: {
        code: 'COST_CAP_REACHED',
        title: 'That is everything',
        message: 'This conversation has reached its budget.',
      },
    });

    renderStage(stream);
    expect(screen.getByText('This conversation has reached its budget.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});
