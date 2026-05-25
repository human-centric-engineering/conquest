/**
 * Agent subject case execution.
 *
 * Drains `streamChat(...)` to completion for one dataset case,
 * returning the assistant turn text plus any structured side-effects
 * the graders need (citations, tool calls, token usage).
 *
 * Deliberately does NOT set `contextType: 'evaluation'` — that flag
 * routes streamChat to write `AiEvaluationLog` rows for manual
 * sessions. Batch runs write to `AiEvaluationCaseResult` instead, so
 * we let streamChat persist the standard AiMessage rows (as a normal
 * conversation row) without mirroring them into evaluation logs.
 */

import type { ChatEvent, Citation, ToolCallTrace } from '@/types/orchestration';
import { streamChat } from '@/lib/orchestration/chat/streaming-handler';

export interface AgentCaseInput {
  agentSlug: string;
  userId: string;
  /** The case `input` — string for agent subjects. */
  message: string;
  /** Per-case cancellation. */
  signal?: AbortSignal;
}

export interface AgentCaseResult {
  /** Concatenated `content` events — the assistant's final text. */
  assistantText: string;
  citations: Citation[];
  toolCalls: ToolCallTrace[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export async function runAgentCase(input: AgentCaseInput): Promise<AgentCaseResult> {
  const start = Date.now();
  const stream = streamChat({
    agentSlug: input.agentSlug,
    userId: input.userId,
    message: input.message,
    includeTrace: true,
    signal: input.signal,
  });

  let assistantText = '';
  let citations: Citation[] = [];
  const toolCalls: ToolCallTrace[] = [];
  let tokenUsage = { input: 0, output: 0 };
  let costUsd = 0;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  for await (const event of stream as AsyncIterable<ChatEvent>) {
    switch (event.type) {
      case 'content':
        assistantText += event.delta ?? '';
        break;
      case 'capability_result': {
        if (event.trace) {
          toolCalls.push(event.trace);
        }
        break;
      }
      case 'citations':
        if (Array.isArray(event.citations)) citations = event.citations;
        break;
      case 'done':
        tokenUsage = {
          input: event.tokenUsage.inputTokens ?? 0,
          output: event.tokenUsage.outputTokens ?? 0,
        };
        costUsd = event.costUsd;
        break;
      case 'error':
        errorCode = event.code;
        errorMessage = event.message;
        break;
    }
  }

  const result: AgentCaseResult = {
    assistantText,
    citations,
    toolCalls,
    tokenUsage,
    costUsd,
    latencyMs: Date.now() - start,
  };
  if (errorCode) result.errorCode = errorCode;
  if (errorMessage) result.errorMessage = errorMessage;
  return result;
}
