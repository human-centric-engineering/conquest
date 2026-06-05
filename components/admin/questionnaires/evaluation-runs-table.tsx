'use client';

/**
 * EvaluationRunsTable (F5.2) — the design-evaluation run history for one version, rendered
 * on the `…/[id]/evaluations` sub-route.
 *
 * Lists persisted runs newest-first (the server already ordered them) with status, judges
 * run/requested, and total findings. A "Run evaluation" button POSTs a fresh run (the
 * synchronous panel — the request returns the completed run) and navigates straight to its
 * detail. Read-only otherwise; the accept/decline review queue is F5.3. Rows link to the
 * run detail, which is version-scoped via the `?v=` query param (admin routes carry the
 * version there, not in the path).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/server-fetch';
import type { EvaluationRunDetail, EvaluationRunListItem } from '@/lib/app/questionnaire/views';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';

interface Props {
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  runs: EvaluationRunListItem[];
  /** Whether the design-evaluation sub-flag is on — the POST 404s otherwise, so the
   *  "Run evaluation" button is hidden when off (history stays readable under the master flag). */
  canRun: boolean;
}

export function EvaluationRunsTable({
  questionnaireId,
  versionId,
  versionNumber,
  runs,
  canRun,
}: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detailHref = (runId: string): string =>
    `/admin/questionnaires/${questionnaireId}/evaluations/${runId}?v=${versionId}`;

  const runEvaluation = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionEvaluations(questionnaireId, versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          // Empty body → all seven dimensions (the route's default).
          body: JSON.stringify({}),
        }
      );
      const body = await parseApiResponse<EvaluationRunDetail>(res);
      if (!res.ok || !body.success) {
        throw new Error(!body.success ? body.error.message : 'Evaluation failed');
      }
      router.push(detailHref(body.data.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run the evaluation. Try again.');
      setRunning(false);
    }
    // On success we navigate away, so `running` stays true until the route changes.
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {runs.length === 0
            ? 'No evaluations have been run for this version yet.'
            : `${runs.length} run${runs.length === 1 ? '' : 's'} on v${versionNumber}.`}
        </p>
        {canRun && (
          <Button onClick={() => void runEvaluation()} disabled={running} size="sm">
            {running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            {running ? 'Running…' : 'Run evaluation'}
          </Button>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {runs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Judges</TableHead>
              <TableHead className="text-right">Findings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const badge = runStatusBadge(run.status);
              return (
                <TableRow
                  key={run.id}
                  className="hover:bg-accent/50 cursor-pointer"
                  onClick={() => router.push(detailHref(run.id))}
                >
                  <TableCell className="font-medium">
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                    {run.dimensionsRun}/{run.dimensionsRequested}
                    {run.dimensionsFailed > 0 ? ` · ${run.dimensionsFailed} failed` : ''}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {run.totalFindings}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
