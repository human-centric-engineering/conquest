/**
 * Diagnostics tab — version rollup view.
 *
 * Aggregate telemetry tiles + a per-invitation table (each row links to the drill-down). A plain
 * server component: static markup, a GET filter form for the date window, and links — no client
 * state needed at this level (the deep-dive interactivity lives in the drill-down).
 */

import Link from 'next/link';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatUsd } from '@/lib/utils/format-currency';
import type { VersionDiagnosticsResult } from '@/lib/app/questionnaire/analytics';
import {
  formatCount,
  formatMs,
  formatWhen,
} from '@/components/admin/questionnaires/diagnostics/format';

interface DiagnosticsViewProps {
  questionnaireId: string;
  versionId: string;
  data: VersionDiagnosticsResult | null;
  filters: { from: string; to: string };
}

/** A short identity label for a row when the email is withheld (anonymous) or absent. */
function rowLabel(invitationId: string | null, email: string | null, name: string | null): string {
  if (email) return name ? `${name} · ${email}` : email;
  if (invitationId === null) return '(no invitation)';
  return `Invitation ${invitationId.slice(0, 8)}`;
}

export function DiagnosticsView({
  questionnaireId,
  versionId,
  data,
  filters,
}: DiagnosticsViewProps) {
  const base = `/admin/questionnaires/${questionnaireId}/v/${versionId}/diagnostics`;

  if (!data) {
    return (
      <div className="border-destructive/40 bg-destructive/5 text-muted-foreground rounded-lg border px-4 py-6 text-sm">
        Diagnostics couldn&rsquo;t be loaded for this version. Try again, or narrow the date window.
      </div>
    );
  }

  const t = data.totals;
  const stats: CqStat[] = [
    { label: 'Sessions', value: formatCount(t.sessions), hint: `${formatCount(t.turns)} turns` },
    {
      label: 'Tokens',
      value: formatCount(t.totalTokens),
      hint: `${formatCount(t.promptTokens)} in / ${formatCount(t.completionTokens)} out`,
    },
    {
      label: 'Avg response',
      value: formatMs(t.avgTurnMs),
      hint: t.p95TurnMs != null ? `p95 ${formatMs(t.p95TurnMs)}` : undefined,
    },
    { label: 'Cost', value: formatUsd(t.costUsd) },
    {
      label: 'Errors',
      value: formatCount(t.errorCount),
      accent: t.errorsBySeverity.error > 0,
      hint: `${t.errorsBySeverity.error} error · ${t.errorsBySeverity.warning} warn · ${t.errorsBySeverity.info} info`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Per-invitation telemetry and the error log for this version — token use, response time,
          cost, and any failures captured during conversations or delivery. Click a row to drill in.
          {data.identitySuppressed && ' Identities are hidden (anonymous mode).'}
        </p>
        {/* GET form — navigates to this same tab with the new window in the query. */}
        <form className="flex items-end gap-2 text-sm" method="get">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">From</span>
            <input
              type="date"
              name="from"
              defaultValue={filters.from}
              className="border-input bg-background rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">To</span>
            <input
              type="date"
              name="to"
              defaultValue={filters.to}
              className="border-input bg-background rounded-md border px-2 py-1"
            />
          </label>
          <button
            type="submit"
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5"
          >
            Apply
          </button>
        </form>
      </div>

      <CqStatTiles stats={stats} />

      {data.invitations.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border px-4 py-6 text-sm">
          No invitations or sessions in this window yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invitee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Turns</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Avg</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.invitations.map((row) => {
                const label = rowLabel(row.invitationId, row.email, row.name);
                return (
                  <TableRow
                    key={row.invitationId ?? 'no-invitation'}
                    className={row.invitationId ? 'hover:bg-muted/50' : undefined}
                  >
                    <TableCell className="font-medium">
                      {row.invitationId ? (
                        <Link
                          href={`${base}/${row.invitationId}`}
                          className="text-[color:var(--cq-accent)] hover:underline"
                        >
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      {row.sessionStatuses.length > 0 && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          {row.sessionStatuses.join(', ')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.status ? (
                        <Badge variant="outline">{row.status}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.turns)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.promptTokens + row.completionTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMs(row.avgTurnMs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUsd(row.costUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.errorCount > 0 ? (
                        <Badge variant="destructive">{row.errorCount}</Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatWhen(row.lastActivityAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
