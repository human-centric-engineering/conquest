'use client';

/**
 * Read-only Turn Inspector for the Diagnostics deep-dive.
 *
 * Renders a turn's persisted `AgentCallTrace[]` — every LLM/embedding call with its model, latency,
 * token counts, cost, and the raw prompt + response. Unlike the live preview drawer
 * (`turn-inspector-drawer.tsx`), this is purely presentational: no portal, no evaluation actions,
 * no preview gating. The traces are persisted for every session, so the deep-dive works for real
 * respondent conversations — the whole point of the Diagnostics surface.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
  totalInspectorTokensIn,
  totalInspectorTokensOut,
  type AgentCallTrace,
} from '@/lib/app/questionnaire/inspector/types';
import { formatUsd } from '@/lib/utils/format-currency';
import { formatCount, formatMs } from '@/components/admin/questionnaires/diagnostics/format';

function CallRow({ call, index }: { call: AgentCallTrace; index: number }) {
  const [open, setOpen] = useState(false);
  const isEmbedding = call.kind === 'embedding';
  return (
    <div className="border-border/60 rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
        )}
        <span className="text-muted-foreground w-5 shrink-0 tabular-nums">{index + 1}</span>
        <span className="font-medium">{call.label}</span>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {isEmbedding ? 'VEC' : 'LLM'}
        </Badge>
        <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums">
          {call.model && <span className="font-mono">{call.model}</span>}
          <span>{formatMs(call.latencyMs)}</span>
          <span>{formatUsd(call.costUsd)}</span>
        </span>
      </button>
      {open && (
        <div className="border-border/60 space-y-3 border-t px-3 py-3 text-xs">
          <dl className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <div>
              <dt className="font-medium">Provider</dt>
              <dd className="font-mono">{call.provider || '—'}</dd>
            </div>
            <div>
              <dt className="font-medium">{isEmbedding ? 'Dimensions' : 'Tokens in'}</dt>
              <dd className="tabular-nums">
                {isEmbedding ? formatCount(call.dimensions) : formatCount(call.tokensIn)}
              </dd>
            </div>
            {!isEmbedding && (
              <div>
                <dt className="font-medium">Tokens out</dt>
                <dd className="tabular-nums">{formatCount(call.tokensOut)}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium">Cost</dt>
              <dd className="tabular-nums">{formatUsd(call.costUsd)}</dd>
            </div>
          </dl>
          <div>
            <p className="text-muted-foreground mb-1 font-medium">Prompt</p>
            <div className="bg-muted/50 max-h-72 space-y-2 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
              {call.prompt.map((m, i) => (
                <div key={i}>
                  <span className="text-muted-foreground">[{m.role}] </span>
                  {m.content}
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-muted-foreground mb-1 font-medium">Response</p>
            <div className="bg-muted/50 max-h-72 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
              {call.response || '—'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DiagnosticsInspectorCalls({
  calls,
  className,
}: {
  calls: AgentCallTrace[];
  className?: string;
}) {
  if (calls.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">No agent calls were captured for this turn.</p>
    );
  }
  return (
    <div className={cn('space-y-2', className)}>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        <span>{calls.length} calls</span>
        <span>{formatMs(totalInspectorLatencyMs(calls))}</span>
        <span>{formatUsd(totalInspectorCostUsd(calls))}</span>
        <span>{formatCount(totalInspectorTokensIn(calls))} in</span>
        <span>{formatCount(totalInspectorTokensOut(calls))} out</span>
      </div>
      {calls.map((call, i) => (
        <CallRow key={i} call={call} index={i} />
      ))}
    </div>
  );
}
