/**
 * The boundary between the current exchange and the history behind it.
 *
 * One pure function decides where the conversation is cut in two, and both halves of the split
 * transcript call it. Getting it wrong is not cosmetic: too high and a turn is rendered twice, too
 * low and one vanishes, and under Horizon — the layout the split was made for — the cut is the
 * only thing on screen.
 *
 * @see lib/app/questionnaire/chat/exchange.ts
 * @see .context/app/questionnaire/respondent-layouts.md
 */
import { describe, expect, it } from 'vitest';

import {
  currentExchangeStart,
  hasConversationHistory,
} from '@/lib/app/questionnaire/chat/exchange';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

const ask = (content: string): QuestionnaireTurn => ({ role: 'assistant', content });
const say = (content: string): QuestionnaireTurn => ({ role: 'user', content });

describe('currentExchangeStart', () => {
  it('treats the whole opening burst as current', () => {
    // A greeting and the first question arrive as two assistant turns with no respondent message
    // between or before them. Cutting after the greeting would strand it in a history the
    // respondent has not made yet — and under Horizon would hide the interviewer's opening words
    // behind a disclosure on the very first screen.
    expect(currentExchangeStart([ask('Welcome.'), ask('What brought you here?')])).toBe(0);
  });

  it('starts at the respondent’s most recent message, not the interviewer’s reply', () => {
    // The answer and the question it prompted are one thought. Showing the question alone asks the
    // respondent to read a follow-up with no idea what it follows.
    const turns = [ask('Welcome.'), ask('Q1?'), say('My answer.'), ask('Q2?')];
    expect(currentExchangeStart(turns)).toBe(2);
  });

  it('keeps every interviewer turn since that message in the same exchange', () => {
    // A turn can commit more than one assistant message (a notice, then the next question). They
    // belong together — they are all things said since the respondent last spoke.
    const turns = [say('A.'), ask('Noted.'), ask('And another thing?')];
    expect(currentExchangeStart(turns)).toBe(0);
  });

  it('moves as the conversation advances', () => {
    const turns = [ask('Q1?'), say('A1.'), ask('Q2?'), say('A2.'), ask('Q3?')];
    expect(currentExchangeStart(turns)).toBe(3);
  });

  it('reports no history for an empty transcript', () => {
    expect(currentExchangeStart([])).toBe(0);
  });
});

describe('hasConversationHistory', () => {
  it('is false while the respondent has not answered anything', () => {
    // What the container asks before it decides whether the `history` slot is a node or `null` —
    // and `null` is what stops Horizon offering a disclosure that opens onto nothing.
    expect(hasConversationHistory([ask('Welcome.'), ask('Q1?')])).toBe(false);
  });

  it('is true once there is a turn behind the current exchange', () => {
    expect(hasConversationHistory([ask('Q1?'), say('A1.'), ask('Q2?')])).toBe(true);
  });

  it('counts stitched Experience legs even when this leg has said nothing yet', () => {
    // Under `stitched` continuity the earlier legs ARE conversation the respondent had; a new leg
    // that opens with no history of its own still has a past to fold away.
    expect(hasConversationHistory([ask('Welcome back.')], 2)).toBe(true);
  });

  it('does not count an absent stitched history', () => {
    expect(hasConversationHistory([ask('Welcome.')], 0)).toBe(false);
  });
});
