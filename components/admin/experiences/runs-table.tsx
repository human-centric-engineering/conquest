'use client';

/**
 * The runs console — one respondent's journey per row.
 *
 * Clicking a row opens a drawer with its legs and the routing rationale, fetched on demand: the
 * list endpoint carries only what the table shows, so a hundred runs cost one query rather than a
 * hundred. A stuck run (`awaiting_handoff` with nothing having happened) gets an explicit Advance
 * action — the normal path is the submit hook, and this covers the case where it was cut off.
 */

import { useState } from 'react';
import { ChevronRight, Loader2, PlayCircle } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import type { ExperienceRunStatus } from '@/lib/app/questionnaire/experiences/run/types';
import type { RoutingSource } from '@/lib/app/questionnaire/experiences/types';
import type { RunDetailView } from '@/app/api/v1/app/experiences/_lib/run-read';

export interface RunRow {
  id: string;
  publicRef: string | null;
  status: ExperienceRunStatus;
  legCount: number;
  spentUsd: number;
  startedAt: string;
  completedAt: string | null;
  decisionSource: RoutingSource | null;
  selectedStepKey: string | null;
}

/** How a decision was reached. The distinction an operator most needs at a glance. */
const SOURCE_LABELS: Record<RoutingSource, string> = {
  rule: 'Rule',
  llm: 'AI',
  fallback: 'Fallback',
  budget: 'Budget',
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: ExperienceRunStatus }) {
  const variant =
    status === 'completed' ? 'default' : status === 'active' ? 'outline' : 'secondary';
  return (
    <Badge variant={variant} className="capitalize">
      {status.replace('_', ' ')}
    </Badge>
  );
}

export function RunsTable({ runs }: { runs: RunRow[] }) {
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (runId: string) => {
    setLoadingId(runId);
    setError(null);
    try {
      setDetail(await apiClient.get<RunDetailView>(API.APP.EXPERIENCES.run(runId)));
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not load that run.');
    } finally {
      setLoadingId(null);
    }
  };

  const advance = async (runId: string) => {
    setAdvancing(true);
    setError(null);
    try {
      await apiClient.post(API.APP.EXPERIENCES.advanceRun(runId), { body: {} });
      // Re-fetch rather than mutating locally: an advance may have created a leg, concluded the
      // run, or done nothing, and the server is the only honest account of which.
      setDetail(await apiClient.get<RunDetailView>(API.APP.EXPERIENCES.run(runId)));
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not advance that run.');
    } finally {
      setAdvancing(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Ref</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Legs</TableHead>
              <TableHead>Routed to</TableHead>
              <TableHead>Decided by</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Started</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow
                key={run.id}
                className="group cursor-pointer hover:bg-[color:var(--cq-accent-muted)]"
                onClick={() => void open(run.id)}
              >
                <TableCell className="font-mono text-xs">
                  {run.publicRef ? formatSessionRef(run.publicRef) : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={run.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{run.legCount}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {run.selectedStepKey ? (
                    <code className="text-xs">{run.selectedStepKey}</code>
                  ) : (
                    'Concluded'
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {run.decisionSource ? SOURCE_LABELS[run.decisionSource] : '—'}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  ${run.spentUsd.toFixed(4)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                  {formatDateTime(run.startedAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {loadingId === run.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:text-[color:var(--cq-accent)]" />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={detail !== null} onOpenChange={(isOpen) => !isOpen && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Run {detail?.publicRef ? formatSessionRef(detail.publicRef) : ''}
            </DialogTitle>
            <DialogDescription>
              The questionnaires this respondent was taken through, and why.
            </DialogDescription>
          </DialogHeader>

          {detail && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={detail.status} />
                <span className="text-muted-foreground text-sm tabular-nums">
                  ${detail.spentUsd.toFixed(4)}
                </span>
                {/* The stuck case: awaiting a handoff that never resolved, usually because the
                    submit hook was cut off mid-flight. */}
                {detail.status === 'awaiting_handoff' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={advancing}
                    onClick={() => void advance(detail.id)}
                  >
                    {advancing ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlayCircle className="mr-2 h-3.5 w-3.5" />
                    )}
                    Advance now
                  </Button>
                )}
              </div>

              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Journey
                </p>
                <ol className="mt-2 space-y-2">
                  {detail.legs.map((leg) => (
                    <li key={leg.ordinal} className="bg-muted/40 rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {leg.ordinal + 1}. {leg.stepTitle ?? 'Step no longer exists'}
                        </span>
                        <Badge variant="outline" className="capitalize">
                          {leg.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-1 font-mono text-xs">
                        {leg.sessionRef ? formatSessionRef(leg.sessionRef) : leg.sessionId}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>

              {detail.decision && (
                <div>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    The routing decision
                  </p>
                  <div className="mt-2 space-y-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={detail.decision.decision === 'route' ? 'default' : 'secondary'}
                      >
                        {detail.decision.decision === 'route'
                          ? `→ ${detail.decision.selectedStepKey}`
                          : 'Concluded'}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {SOURCE_LABELS[detail.decision.source]}
                      </span>
                      {detail.decision.source === 'llm' && detail.decision.confidence !== null && (
                        <span className="text-muted-foreground text-xs tabular-nums">
                          confidence {detail.decision.confidence.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {detail.decision.rationale && <p>{detail.decision.rationale}</p>}
                  </div>
                </div>
              )}

              {detail.briefing && (
                <div>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    What was carried forward
                  </p>
                  <p className="mt-1 text-sm">{detail.briefing}</p>
                  {detail.carriedThemes.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {detail.carriedThemes.map((theme) => (
                        <Badge key={theme} variant="outline" className="font-normal">
                          {theme}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
