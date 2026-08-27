/**
 * Where the CURRENT exchange begins — the one derivation the transcript's two halves share.
 *
 * The `transcript` slot became `history` + `currentExchange` for Horizon, which shows one question
 * at a time and therefore needs the live exchange apart from everything behind it. Both halves are
 * built by the container as separate nodes, and a layout may place them with nothing in common
 * between them — so "which turns are current" has to be answered identically in two places.
 *
 * It is a pure function of `turns` rather than state on `ConversationProvider` for exactly that
 * reason: the provider carries what genuinely CANNOT be derived twice (the reveal cursor is the
 * state, not a view of it). This can, and a single exported function is one derivation whoever
 * calls it — see `conversation-context.tsx` for why the line is drawn there.
 *
 * Pure: no React, no Prisma, no DOM.
 */

import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

/**
 * The index of the first turn of the current exchange.
 *
 * An exchange is the respondent's most recent message and everything the interviewer has said
 * since — NOT the last assistant turn alone. Two reasons, and both matter to Horizon, which is the
 * only layout that ever shows the boundary:
 *
 *   - A question read without the answer it followed is a question out of context. "You said X;
 *     here is what I want to ask about it" is one thought, and splitting it in half mid-thought is
 *     what a one-question-at-a-time layout must not do.
 *   - The OPENING BURST has no respondent message at all — a greeting and the first question arrive
 *     as two assistant turns. Anchoring on the last user turn resolves that to `0` naturally, so
 *     the whole burst is current and nothing is stranded in a history nobody has made yet.
 *
 * Returns `0` for an empty transcript and for one the respondent has not yet answered, which is the
 * same statement: there is no history.
 */
export function currentExchangeStart(turns: readonly QuestionnaireTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === 'user') return i;
  }
  return 0;
}

/**
 * Is there anything behind the current exchange at all?
 *
 * The container asks this to decide whether the `history` slot is a node or `null`, and `null`
 * matters: a layout that puts history behind a gesture (Horizon) must not offer the gesture when
 * the disclosure would open onto nothing. Stitched Experience legs count — they are conversation
 * the respondent had, replayed above the live one, even when this leg has no turns of its own yet.
 */
export function hasConversationHistory(
  turns: readonly QuestionnaireTurn[],
  stitchedSegmentCount = 0
): boolean {
  return currentExchangeStart(turns) > 0 || stitchedSegmentCount > 0;
}
