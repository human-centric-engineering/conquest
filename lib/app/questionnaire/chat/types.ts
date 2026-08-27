/**
 * Client-facing transcript + status types for the respondent chat surface (F7.1).
 *
 * Pure types — no React, no DOM. Shared by the streaming hook, the chat
 * component, and their unit tests. The wire contract (the SSE `ChatEvent`
 * subset the `/messages` route emits) is narrowed separately in
 * `parse-session-event.ts`; these types describe the *rendered* transcript.
 */

import type { ReasoningStep } from '@/lib/app/questionnaire/reasoning';
import type { QuestionCardPayload } from '@/lib/app/questionnaire/chat/question-card';

/** One committed turn in the rendered transcript. */
export interface QuestionnaireTurn {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Side-band notices surfaced with this (assistant) turn — the seriousness / support /
   * contradiction callouts rendered inline beneath it. Attached to the turn (rather than held
   * as one transient banner) so they persist as the conversation scrolls on AND replay on
   * resume from {@link AppQuestionnaireTurn.warnings}. Absent/empty on user turns and turns
   * that raised none.
   */
  warnings?: SessionWarning[];
  /**
   * Live "watch it think" reasoning trace persisted with this (assistant) turn — replayed on
   * resume / scroll-back when the version opted into persistence. Absent on user turns, on turns
   * with no trace, and when persistence is off (the trace was live-only). See
   * `lib/app/questionnaire/reasoning`.
   */
  reasoning?: ReasoningStep[];
  /**
   * Question fidelity (P18): the question's REAL answer control, rendered inside this turn instead
   * of the interviewer reading its options out in prose. Present only for a typed `must_ask`
   * question (or a last-resort re-ask); absent everywhere else, which is the overwhelming majority
   * of turns. Replayed on resume from `AppQuestionnaireTurn.questionCardKey`, and suppressed once
   * the question has been answered. See `lib/app/questionnaire/chat/question-card.ts`.
   */
  card?: QuestionCardPayload;
}

/**
 * A non-fatal side-band notice surfaced as a banner. The `/messages` core
 * emits these for contradiction detections and fail-soft capability notices;
 * the turn still completes, so a warning never blocks the composer.
 */
export interface SessionWarning {
  code: string;
  message: string;
  /**
   * The agent's underlying rationale for the notice — the seriousness judge's `reason`, or a
   * contradiction's `explanation` when the message shown is the probe. Surfaced behind a small
   * "Why?" disclosure on the notice so a respondent (and the demo audience) can see *why* the agent
   * flagged it. Optional — notices without a deeper reason (support signpost, fail-soft) omit it.
   */
  detail?: string;
}

/**
 * The surface's interaction status. Drives whether the composer is enabled
 * and which (if any) blocking panel is shown.
 *
 * - `idle` — ready for input.
 * - `streaming` — a turn is in flight; composer disabled.
 * - `cost_capped` — the session's budget is exhausted (HTTP 402). Terminal
 *   for this session: the next turn would 409, so the composer stays disabled.
 * - `not_active` — the session is paused / abandoned (HTTP 409). For a
 *   respondent-paused session this is resumable (F7.3); the surface shows a
 *   Resume affordance rather than treating it as final.
 * - `completed` — the respondent submitted (or the session was completed).
 *   Terminal + positive: the surface shows the completion confirmation (F7.3),
 *   not an error panel.
 * - `expired` — an anonymous session token is invalid or past its 24h TTL
 *   (HTTP 401). The respondent must restart.
 * - `error` — a transient failure (network, 429 rate-limit, defensive stream
 *   error). The composer stays enabled so the respondent can retry.
 */
export type QuestionnaireChatStatus =
  'idle' | 'streaming' | 'cost_capped' | 'not_active' | 'completed' | 'expired' | 'error';

/** A respondent-facing error with a friendly title + body and optional retry hint. */
export interface ChatErrorState {
  /** Stable code from the wire (`COST_CAP_REACHED`, `SESSION_TOKEN_INVALID`, …) or a synthetic one. */
  code: string;
  /** Short heading for the panel/banner. */
  title: string;
  /** Body copy. */
  message: string;
}

/** Statuses that disable the composer (no further input is meaningful). */
export const BLOCKING_STATUSES: readonly QuestionnaireChatStatus[] = [
  'streaming',
  'cost_capped',
  'not_active',
  'completed',
  'expired',
];

/**
 * Statuses after which no further input is possible at all — {@link BLOCKING_STATUSES} minus the
 * merely-transient `streaming`.
 *
 * Declared here rather than inline because two places now decide on it and they must not drift:
 * the conversation context (which reports `isTerminal` to both halves of the chat) and
 * `SessionWorkspace` (which decides whether to build a composer node for the layout at all). A
 * terminal session that still shows a composer offers the respondent an input that cannot send.
 */
export const TERMINAL_STATUSES: readonly QuestionnaireChatStatus[] = [
  'cost_capped',
  'not_active',
  'completed',
  'expired',
];

/** True when the session has reached a state no further respondent input can change. */
export function isTerminalStatus(status: QuestionnaireChatStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
