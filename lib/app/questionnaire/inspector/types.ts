/**
 * Preview Turn Inspector (admin-only) — shared types.
 *
 * The inspector surfaces, for each respondent turn in an **admin preview** session, the
 * sequence of agent/LLM calls the turn made, with each call's model, latency, estimated cost,
 * token counts, and the raw prompt + response. It is gated twice: the session must be a preview
 * (`AppQuestionnaireSession.isPreview`, only ever created by the admin-only `/preview` route)
 * AND the version's `previewInspectorEnabled` config toggle must be on. It is therefore NEVER
 * emitted to a real respondent. These types are pure (no Prisma/Next) so the capture seam, the
 * stream event, and the client drawer can all share them.
 */

/** One message in a captured prompt. `role` is `system`/`user` for LLM calls, or `input` when
 *  the call is a dispatched capability whose request is structured args rather than chat messages. */
export interface InspectorMessage {
  role: string;
  content: string;
}

/** One agent/LLM call made during a turn. */
export interface AgentCallTrace {
  /**
   * What kind of call this is. Absent ⇒ `'llm'` (back-compat — every existing call site is an LLM
   * call). `'embedding'` marks a vector-embedding call (e.g. ranking slots by similarity): it has
   * input tokens + a width but no completion tokens and no free-text response, so the UI/serializer
   * render it distinctly (a "VEC" tag, a "Dimensions" metric, the response shown as the ranking).
   */
  kind?: 'llm' | 'embedding';
  /** Human label, e.g. "Answer extraction", "Seriousness judge", "Interviewer phrasing". */
  label: string;
  /** Resolved model id (e.g. `gpt-4o-mini`), or `''` when not resolvable. */
  model: string;
  /** Resolved provider slug (e.g. `openai`), or `''`. */
  provider: string;
  /** Wall-clock latency of the call, in ms. */
  latencyMs: number;
  /** Estimated USD cost of the call (0 for a no-spend/deterministic step). */
  costUsd: number;
  /** Input (prompt) tokens, when the call path exposes them. */
  tokensIn?: number;
  /** Output (completion) tokens, when the call path exposes them. */
  tokensOut?: number;
  /** Embedding width (the vector dimension), for `kind: 'embedding'` calls. */
  dimensions?: number;
  /** The request sent — chat messages, or a single `input` entry holding the dispatched args. */
  prompt: InspectorMessage[];
  /** The response received — the assistant text, or the structured result serialized. */
  response: string;
}

/** All the inspector data for one turn. */
export interface TurnInspectorData {
  /** 0-based selection round (the turn index). */
  turnIndex: number;
  /** The calls in execution order. */
  calls: AgentCallTrace[];
}

/** Sink the app-seam call sites push traces into. A no-op when the inspector is off. */
export type RecordAgentCall = (trace: AgentCallTrace) => void;

/** Sum a turn's call costs (USD). */
export function totalInspectorCostUsd(calls: AgentCallTrace[]): number {
  return calls.reduce((sum, c) => sum + (Number.isFinite(c.costUsd) ? c.costUsd : 0), 0);
}

/** Sum a turn's call latencies (ms). */
export function totalInspectorLatencyMs(calls: AgentCallTrace[]): number {
  return calls.reduce((sum, c) => sum + (Number.isFinite(c.latencyMs) ? c.latencyMs : 0), 0);
}
