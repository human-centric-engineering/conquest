/**
 * "Where the time goes" — the per-stage latency split on the Diagnostics tab (P20 Phase 1).
 *
 * A respondent waits through four to six sequential model calls before the first token of the
 * reply appears, and until this panel existed there was no way to tell WHICH of them the wait
 * actually was. Every turn already persists an `AgentCallTrace[]` on `inspectorCalls` — label,
 * latency, tokens, cost — so this reads telemetry that was already on disk rather than adding any.
 *
 * The last row is the one to read first. **Not in a model call** is the turn's wall-clock minus
 * every call in it: DB reads, embedding, persistence, framework overhead. If that row dominates,
 * shaving model round-trips will not make the conversation feel faster, and the latency work
 * planned on top of this measurement should be re-planned instead.
 *
 * A plain server component — static markup from an already-aggregated result.
 *
 * @see lib/app/questionnaire/analytics/diagnostics.ts — `getStageLatency`, and the caveat about
 *      what the residual means once stages are allowed to overlap.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatCount,
  formatMs,
  formatShare,
} from '@/components/admin/questionnaires/diagnostics/format';
import type { StageLatencyBreakdown } from '@/lib/app/questionnaire/analytics';

interface StageLatencyPanelProps {
  data: StageLatencyBreakdown;
}

/** The proportional bar behind a share cell. Decorative — the percentage beside it is the value. */
function ShareBar({ share }: { share: number | null }) {
  const pct = share === null || !Number.isFinite(share) ? 0 : Math.max(0, Math.min(1, share)) * 100;
  return (
    <span
      aria-hidden="true"
      className="bg-muted relative inline-block h-1.5 w-16 overflow-hidden rounded-full align-middle"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--cq-accent)]"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export function StageLatencyPanel({ data }: StageLatencyPanelProps) {
  const heading = (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">Where the time goes</h3>
      <p className="text-muted-foreground max-w-2xl text-xs">
        Each stage of a turn, from the calls recorded against it. <strong>Per turn</strong> is what
        the stage adds to an average turn — the number to compare across rows. A stage that runs on
        only some turns shows a smaller per-turn figure than its own average call.
      </p>
    </div>
  );

  if (data.turns === 0) {
    return (
      <section className="space-y-3">
        {heading}
        <p className="text-muted-foreground rounded-lg border px-4 py-6 text-sm">
          No turn in this window recorded per-stage timings yet.
        </p>
      </section>
    );
  }

  const avgTurnMs = data.totalTurnMs / data.turns;

  return (
    <section className="space-y-3">
      {heading}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Per turn</TableHead>
              <TableHead className="text-right">Avg call</TableHead>
              <TableHead className="text-right">p95 call</TableHead>
              <TableHead className="text-right">Share of turn</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.stages.map((s) => {
              const share = data.totalTurnMs > 0 ? s.totalMs / data.totalTurnMs : null;
              return (
                <TableRow key={s.label}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(s.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMs(s.perTurnMs)}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatMs(s.avgMs)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatMs(s.p95Ms)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <ShareBar share={share} />
                    <span className="ml-2">{formatShare(share)}</span>
                  </TableCell>
                </TableRow>
              );
            })}
            {/* The residual. Deliberately the last row and visually distinct: it is not a stage,
                it is everything that was not one. */}
            <TableRow className="bg-muted/30">
              <TableCell className="font-medium">
                Not in a model call
                <span className="text-muted-foreground ml-2 text-xs font-normal">
                  database, embedding, persistence
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground text-right">—</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMs(data.residualMs / data.turns)}
              </TableCell>
              <TableCell className="text-muted-foreground text-right">—</TableCell>
              <TableCell className="text-muted-foreground text-right">—</TableCell>
              <TableCell className="text-right tabular-nums">
                <ShareBar share={data.residualShare} />
                <span className="ml-2">{formatShare(data.residualShare)}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        {formatCount(data.turns)} turns averaging {formatMs(avgTurnMs)} end to end, of which{' '}
        {formatMs(data.totalCallMs / data.turns)} was spent waiting on a model.
      </p>
    </section>
  );
}
