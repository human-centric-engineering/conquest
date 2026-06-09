'use client';

/**
 * Cost panel (F8.1): per-version spend from `AiCostLog`.
 *
 * Summary cards (total / runtime / design-time), a per-capability breakdown, a daily
 * spend trend (recharts line), and the top respondent sessions by spend.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatUsd } from '@/lib/utils/format-currency';
// Import the threshold from the pure `privacy` leaf, not the barrel — the barrel
// re-exports the Prisma-coupled aggregators, which must not enter this client bundle.
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type { QuestionnaireCostResult } from '@/lib/app/questionnaire/analytics';

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-muted-foreground text-xs">{label}</div>
      </CardContent>
    </Card>
  );
}

export function CostPanel({ data }: { data: QuestionnaireCostResult | null }) {
  if (!data) {
    return <p className="text-muted-foreground text-sm">Cost data could not be loaded.</p>;
  }

  const maxCapability = Math.max(1, ...data.byCapability.map((c) => c.costUsd));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total spend" value={formatUsd(data.totalCostUsd)} />
        <StatCard label="Respondent runtime" value={formatUsd(data.runtimeCostUsd)} />
        <StatCard label="Design-time" value={formatUsd(data.designTimeCostUsd)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spend by capability</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byCapability.length === 0 ? (
              <p className="text-muted-foreground text-sm italic">No spend in this window.</p>
            ) : (
              <div className="space-y-2">
                {data.byCapability.map((c) => (
                  <div key={c.key} className="flex items-center gap-2 text-sm">
                    <span className="w-40 shrink-0 truncate" title={c.label}>
                      {c.label}
                    </span>
                    <div className="bg-muted relative h-4 flex-1 overflow-hidden rounded">
                      <div
                        className="bg-primary/70 h-full rounded"
                        style={{ width: `${Math.max(2, (c.costUsd / maxCapability) * 100)}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">
                      {formatUsd(c.costUsd)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily spend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trend.length === 0 ? (
              <p className="text-muted-foreground py-12 text-center text-sm">No spend to chart.</p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => formatUsd(v, { compact: true })}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(value) => [formatUsd(Number(value)), 'Spend']}
                    />
                    <Line type="monotone" dataKey="costUsd" stroke="#60a5fa" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top sessions by spend</CardTitle>
        </CardHeader>
        <CardContent>
          {data.topSessionsSuppressed ? (
            <p className="text-muted-foreground text-sm italic">
              Per-session spend is hidden to protect respondent privacy — the questionnaire is
              anonymous or has fewer than {K_ANONYMITY_THRESHOLD} sessions. Totals above are
              unaffected.
            </p>
          ) : data.topSessions.length === 0 ? (
            <p className="text-muted-foreground text-sm italic">No respondent session spend yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSessions.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell className="font-mono text-xs">{s.sessionId.slice(0, 12)}…</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{s.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUsd(s.costUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
