'use client';

/**
 * ScopeEvaluationRunsTable (F17.21) — the Adaptive Scope evaluation run history for one version.
 *
 * Mirrors `EvaluationRunsTable` (F5.2) exactly, over the scope panel's own endpoints and view
 * types: lists persisted runs newest-first, "Run evaluation" POSTs a fresh run and navigates
 * straight to its detail.
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
import { parseApiResponse } from '@/lib/api/parse-response';
import type {
  ScopeEvaluationRunDetail,
  ScopeEvaluationRunListItem,
} from '@/lib/app/questionnaire/views';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { StatusTicker, EVALUATION_MESSAGES } from '@/components/admin/questionnaires/status-ticker';

interface Props {
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  runs: ScopeEvaluationRunListItem[];
  canRun: boolean;
}

export function ScopeEvaluationRunsTable({
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
    `/admin/questionnaires/${questionnaireId}/v/${versionId}/topics/evaluations/${runId}`;

  const runEvaluation = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionScopeEvaluations(questionnaireId, versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          // Empty body → all four dimensions (the route's default).
          body: JSON.stringify({}),
        }
      );
      const body = await parseApiResponse<ScopeEvaluationRunDetail>(res);
      if (!res.ok || !body.success) {
        throw new Error(!body.success ? body.error.message : 'Evaluation failed');
      }
      router.push(detailHref(body.data.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run the evaluation. Try again.');
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {runs.length === 0
            ? 'No scope evaluations have been run for this version yet.'
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

      {running && <StatusTicker messages={EVALUATION_MESSAGES} />}
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
