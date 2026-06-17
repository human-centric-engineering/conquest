/**
 * Preview Turn Inspector — plaintext serialization for "copy to clipboard".
 *
 * Pure (no DOM/Prisma/Next) so it's unit-testable and shared by the drawer's three copy
 * affordances: copy-all, copy-one-turn, and copy-one-call. Produces a readable, paste-into-a-ticket
 * transcript — a turn header, then each call's metrics followed by its raw prompt + response.
 *
 * Formatting mirrors what the drawer shows (same cost/latency rounding) so the clipboard text and
 * the on-screen console read the same.
 */

import type { AgentCallTrace, TurnInspectorData } from '@/lib/app/questionnaire/inspector/types';
import {
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
} from '@/lib/app/questionnaire/inspector/types';

/** $0.00 → "$0", small values to 4 sig decimals, larger to cents — mirrors the drawer's `fmtCost`. */
function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Mirrors the drawer's `fmtLatency`: ms under a second, one-decimal seconds above. */
function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Serialize one agent/LLM call: a metrics block, then each raw prompt message + the response.
 * Pass `index` to prefix the label with its 1-based position (`[01] …`) as the drawer does.
 */
export function formatInspectorCall(call: AgentCallTrace, index?: number): string {
  const heading =
    index === undefined ? call.label : `[${String(index + 1).padStart(2, '0')}] ${call.label}`;
  const lines: string[] = [heading];

  lines.push(`  Model:      ${call.model || '—'}`);
  lines.push(`  Provider:   ${call.provider || '—'}`);
  lines.push(`  Latency:    ${fmtLatency(call.latencyMs)}`);
  lines.push(`  Est. cost:  ${fmtCost(call.costUsd)}`);
  if (call.tokensIn !== undefined) lines.push(`  Tokens in:  ${call.tokensIn.toLocaleString()}`);
  if (call.tokensOut !== undefined) lines.push(`  Tokens out: ${call.tokensOut.toLocaleString()}`);

  lines.push('', '  Prompt:');
  for (const m of call.prompt) {
    lines.push(`  [${m.role}]`, m.content);
  }

  lines.push('', '  Response:', call.response || '—');

  return lines.join('\n');
}

/** Serialize one turn: a header line (counts · latency · cost) + each call, blank-line separated. */
export function formatInspectorTurn(turn: TurnInspectorData): string {
  const cost = totalInspectorCostUsd(turn.calls);
  const latency = totalInspectorLatencyMs(turn.calls);
  const header = `── Turn ${turn.turnIndex + 1} — ${turn.calls.length} call${
    turn.calls.length === 1 ? '' : 's'
  } · ${fmtLatency(latency)} · ${fmtCost(cost)} ──`;

  const body = turn.calls.map((c, i) => formatInspectorCall(c, i)).join('\n\n');
  return body ? `${header}\n\n${body}` : header;
}

/** Serialize every turn under a session header. Empty input yields just the header line. */
export function formatInspectorTurns(turns: TurnInspectorData[]): string {
  const totalCalls = turns.reduce((n, t) => n + t.calls.length, 0);
  const header = `=== Turn Inspector — ${turns.length} turn${
    turns.length === 1 ? '' : 's'
  }, ${totalCalls} agent call${totalCalls === 1 ? '' : 's'} ===`;

  if (turns.length === 0) return header;
  return `${header}\n\n${turns.map(formatInspectorTurn).join('\n\n\n')}`;
}
