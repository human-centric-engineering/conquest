/**
 * Typed adapter over the shared SSE frame parser for the respondent turn loop (F7.1).
 *
 * The `/messages` route streams the orchestration `ChatEvent` shape, but only ever
 * emits a small subset on this surface: `start`, `content`, `warning`, `done`, plus
 * a defensive `error`. This narrows a raw `{ type, data }` block into that subset so
 * the stream consumer's switch stays small and exhaustively typed. Anything outside
 * the subset (or malformed) returns `null` and is ignored by the caller.
 *
 * Pure — no React, no DOM — so it unit-tests in isolation.
 */

import { parseSseBlock } from '@/lib/api/sse-parser';

/** The `ChatEvent` variants the respondent `/messages` stream can produce. */
export type SessionStreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'content'; delta: string }
  | { type: 'warning'; code: string; message: string }
  | { type: 'done'; costUsd: number }
  | { type: 'error'; code: string; message: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse one SSE block into a narrowed session event, or `null` for keepalive
 * comments, unrecognised event types, and malformed payloads.
 */
export function parseSessionEvent(block: string): SessionStreamEvent | null {
  const parsed = parseSseBlock(block);
  if (!parsed) return null;

  const { type, data } = parsed;
  switch (type) {
    case 'start': {
      const conversationId = asString(data.conversationId);
      const messageId = asString(data.messageId);
      if (conversationId === null || messageId === null) return null;
      return { type: 'start', conversationId, messageId };
    }
    case 'content': {
      const delta = asString(data.delta);
      if (delta === null) return null;
      return { type: 'content', delta };
    }
    case 'warning': {
      const code = asString(data.code);
      const message = asString(data.message);
      if (code === null || message === null) return null;
      return { type: 'warning', code, message };
    }
    case 'done': {
      const costUsd = typeof data.costUsd === 'number' ? data.costUsd : 0;
      return { type: 'done', costUsd };
    }
    case 'error': {
      const code = asString(data.code) ?? 'STREAM_ERROR';
      const message = asString(data.message) ?? 'Something went wrong.';
      return { type: 'error', code, message };
    }
    default:
      return null;
  }
}
