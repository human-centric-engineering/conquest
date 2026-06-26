'use client';

/**
 * Diagnostics drill-down — one invitation.
 *
 * Lifecycle header, telemetry tiles, the captured error log (each with an expandable stack +
 * metadata), and every session's per-turn telemetry timeline with an expandable raw inspector
 * (the deep-dive). Client component — the accordions hold the only interactivity.
 */

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { formatUsd } from '@/lib/utils/format-currency';
import type { InvitationDiagnosticsResult } from '@/lib/app/questionnaire/analytics';
import { DiagnosticsInspectorCalls } from '@/components/admin/questionnaires/diagnostics/inspector-calls';
import {
  formatCount,
  formatMs,
  formatWhen,
  severityVariant,
} from '@/components/admin/questionnaires/diagnostics/format';

function jsonPreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function LifecycleStep({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={at ? 'text-foreground text-sm' : 'text-muted-foreground/50 text-sm'}>
        {formatWhen(at)}
      </span>
    </div>
  );
}

export function InvitationDiagnosticsView({ data }: { data: InvitationDiagnosticsResult }) {
  const identity = data.email
    ? data.name
      ? `${data.name} · ${data.email}`
      : data.email
    : data.identitySuppressed
      ? 'Anonymous invitee'
      : data.invitationId
        ? `Invitation ${data.invitationId.slice(0, 8)}`
        : '(no invitation)';

  const t = data.totals;
  const stats: CqStat[] = [
    { label: 'Turns', value: formatCount(t.turns) },
    {
      label: 'Tokens',
      value: formatCount(t.promptTokens + t.completionTokens),
      hint: `${formatCount(t.promptTokens)} in / ${formatCount(t.completionTokens)} out`,
    },
    { label: 'Avg response', value: formatMs(t.avgTurnMs) },
    { label: 'Cost', value: formatUsd(t.costUsd) },
    { label: 'Errors', value: formatCount(t.errorCount), accent: t.errorCount > 0 },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{identity}</h2>
          {data.status && <Badge variant="outline">{data.status}</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border px-4 py-3">
          <LifecycleStep label="Sent" at={data.sentAt} />
          <LifecycleStep label="Opened" at={data.openedAt} />
          <LifecycleStep label="Registered" at={data.registeredAt} />
          <LifecycleStep label="Expires" at={data.expiresAt} />
          {data.revokedAt && <LifecycleStep label="Revoked" at={data.revokedAt} />}
        </div>
      </div>

      <CqStatTiles stats={stats} />

      {/* Error log */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Error log ({data.errors.length})</h3>
        {data.errors.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border px-4 py-4 text-sm">
            No errors recorded for this invitation.
          </p>
        ) : (
          <Accordion type="multiple" className="space-y-2">
            {data.errors.map((err) => {
              const stack = err.stack;
              const meta = jsonPreview(err.metadata);
              const expandable = Boolean(stack || meta);
              const header = (
                <div className="flex flex-1 flex-wrap items-center gap-2 text-left">
                  <Badge variant={severityVariant(err.severity)}>{err.severity}</Badge>
                  <span className="font-mono text-xs">{err.scope}</span>
                  {err.stage && (
                    <span className="text-muted-foreground font-mono text-xs">/ {err.stage}</span>
                  )}
                  {err.code && <span className="text-muted-foreground text-xs">{err.code}</span>}
                  <span className="text-sm">{err.message}</span>
                  {err.turnOrdinal != null && (
                    <span className="text-muted-foreground text-xs">turn {err.turnOrdinal}</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs">
                    {formatWhen(err.createdAt)}
                  </span>
                </div>
              );
              return (
                <AccordionItem key={err.id} value={err.id} className="rounded-md border px-3">
                  {expandable ? (
                    <>
                      <AccordionTrigger className="py-2 hover:no-underline">
                        {header}
                      </AccordionTrigger>
                      <AccordionContent className="space-y-3 pb-3 text-xs">
                        {stack && (
                          <div>
                            <p className="text-muted-foreground mb-1 font-medium">Stack</p>
                            <pre className="bg-muted/50 max-h-72 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
                              {stack}
                            </pre>
                          </div>
                        )}
                        {meta && (
                          <div>
                            <p className="text-muted-foreground mb-1 font-medium">Metadata</p>
                            <pre className="bg-muted/50 max-h-72 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
                              {meta}
                            </pre>
                          </div>
                        )}
                      </AccordionContent>
                    </>
                  ) : (
                    <div className="py-2">{header}</div>
                  )}
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </section>

      {/* Sessions + per-turn telemetry */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Sessions ({data.sessions.length})</h3>
        {data.sessions.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border px-4 py-4 text-sm">
            This invitation hasn&rsquo;t started a session yet.
          </p>
        ) : (
          data.sessions.map((s) => (
            <div key={s.sessionId} className="space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{s.publicRef ?? s.sessionId.slice(0, 8)}</span>
                <Badge variant="outline">{s.status}</Badge>
                {s.isPreview && <Badge variant="secondary">preview</Badge>}
                <span className="text-muted-foreground ml-auto text-xs">
                  {formatWhen(s.createdAt)} · {s.turns.length} turns
                </span>
              </div>
              {s.turns.length === 0 ? (
                <p className="text-muted-foreground text-xs">No turns recorded.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead className="text-right">Response</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead>Deep-dive</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.turns.map((turn) => (
                        <TableRow key={turn.ordinal}>
                          <TableCell className="tabular-nums">{turn.ordinal}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMs(turn.durationMs)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCount((turn.promptTokens ?? 0) + (turn.completionTokens ?? 0))}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(turn.costUsd ?? 0)}
                          </TableCell>
                          <TableCell>
                            <Accordion type="single" collapsible>
                              <AccordionItem value="calls" className="border-0">
                                <AccordionTrigger className="py-1 text-xs hover:no-underline">
                                  {turn.inspectorCalls.length} calls
                                </AccordionTrigger>
                                <AccordionContent>
                                  <DiagnosticsInspectorCalls calls={turn.inspectorCalls} />
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
