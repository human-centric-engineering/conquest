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
import {
  REASONING_STEP_KINDS,
  REASONING_TONES,
  type ReasoningStep,
} from '@/lib/app/questionnaire/reasoning';
import type { AgentCallTrace, InspectorMessage } from '@/lib/app/questionnaire/inspector';

/** The `ChatEvent` variants the respondent `/messages` stream can produce. */
export type SessionStreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'content'; delta: string }
  | { type: 'warning'; code: string; message: string; detail?: string }
  | { type: 'reasoning'; steps: ReasoningStep[] }
  // Preview Turn Inspector (admin-only): the agent-call trace for this turn. The server only emits
  // it for a preview session with the inspector toggle on — never to a real respondent.
  | { type: 'inspector'; turnIndex: number; calls: AgentCallTrace[] }
  | { type: 'done'; costUsd: number }
  | { type: 'error'; code: string; message: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Narrow one untyped item from the `reasoning` frame to a {@link ReasoningStep}, or drop it. */
function asReasoningStep(value: unknown): ReasoningStep | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  const tone = v.tone;
  const label = v.label;
  if (
    typeof label !== 'string' ||
    typeof kind !== 'string' ||
    typeof tone !== 'string' ||
    !(REASONING_STEP_KINDS as readonly string[]).includes(kind) ||
    !(REASONING_TONES as readonly string[]).includes(tone)
  ) {
    return null;
  }
  return {
    kind: kind as ReasoningStep['kind'],
    label,
    tone: tone as ReasoningStep['tone'],
    ...(typeof v.detail === 'string' ? { detail: v.detail } : {}),
    ...(typeof v.rationale === 'string' ? { rationale: v.rationale } : {}),
    ...(typeof v.sourceQuote === 'string' ? { sourceQuote: v.sourceQuote } : {}),
    ...(typeof v.confidence === 'number' ? { confidence: v.confidence } : {}),
    ...(typeof v.provenance === 'string'
      ? { provenance: v.provenance as ReasoningStep['provenance'] }
      : {}),
  };
}

/** Narrow one prompt message from an `inspector` frame; drops malformed entries. */
function asInspectorMessage(value: unknown): InspectorMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.role !== 'string' || typeof v.content !== 'string') return null;
  return { role: v.role, content: v.content };
}

/** Narrow one untyped item from the `inspector` frame to an {@link AgentCallTrace}, or drop it. */
function asAgentCallTrace(value: unknown): AgentCallTrace | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== 'string') return null;
  const prompt = Array.isArray(v.prompt)
    ? v.prompt.map(asInspectorMessage).filter((m): m is InspectorMessage => m !== null)
    : [];
  return {
    label: v.label,
    model: typeof v.model === 'string' ? v.model : '',
    provider: typeof v.provider === 'string' ? v.provider : '',
    latencyMs: typeof v.latencyMs === 'number' ? v.latencyMs : 0,
    costUsd: typeof v.costUsd === 'number' ? v.costUsd : 0,
    ...(typeof v.tokensIn === 'number' ? { tokensIn: v.tokensIn } : {}),
    ...(typeof v.tokensOut === 'number' ? { tokensOut: v.tokensOut } : {}),
    prompt,
    response: typeof v.response === 'string' ? v.response : '',
  };
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
      const detail = asString(data.detail);
      return { type: 'warning', code, message, ...(detail !== null ? { detail } : {}) };
    }
    case 'reasoning': {
      if (!Array.isArray(data.steps)) return null;
      const steps = data.steps.map(asReasoningStep).filter((s): s is ReasoningStep => s !== null);
      if (steps.length === 0) return null;
      return { type: 'reasoning', steps };
    }
    case 'inspector': {
      if (!Array.isArray(data.calls)) return null;
      const calls = data.calls.map(asAgentCallTrace).filter((c): c is AgentCallTrace => c !== null);
      if (calls.length === 0) return null;
      const turnIndex = typeof data.turnIndex === 'number' ? data.turnIndex : 0;
      return { type: 'inspector', turnIndex, calls };
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
