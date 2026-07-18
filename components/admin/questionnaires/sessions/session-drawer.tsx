'use client';

/**
 * SessionDrawer — a right-side slide-over that opens a session's conversation + report from the alpha
 * Sessions list WITHOUT navigating away, so the list (and its URL-driven filter/page position) stays
 * put underneath. One admin-authed fetch (`/admin-view`) seeds both tabs:
 *   - Transcript → the read-only {@link SessionWorkspace} replay (reused verbatim from the viewer page).
 *   - Report    → the delivered report ({@link ReportBody}) plus {@link SessionReportRerun} to view the
 *                 re-run history and trigger a new report.
 * A footer link opens the full-page viewer for deep work (e.g. continuing a preview session).
 *
 * Built on the Radix dialog primitives directly (not the shared centred `DialogContent`) so it slides
 * in from the right as a sheet.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ExternalLink, FlaskConical, Loader2, Split, X } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { formatCompactDuration } from '@/lib/utils/format-duration';
import { formatCompactDateTime } from '@/lib/utils/format-datetime';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { SessionReportRerun } from '@/components/admin/questionnaires/sessions/session-report-rerun';
import { SessionDownloads } from '@/components/admin/questionnaires/sessions/session-downloads';
import { ReportBody } from '@/components/app/questionnaire/report/report-body';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import type { RespondentReportSettings } from '@/lib/app/questionnaire/types';
import type { RespondentReportRevisionsView } from '@/lib/app/questionnaire/report/revision';
import type { RespondentReportClientView } from '@/lib/app/questionnaire/report/view';

/** The `/admin-view` payload the drawer mounts both tabs from. */
interface AdminViewData {
  turns: QuestionnaireTurn[];
  reportPanel: {
    settings: RespondentReportSettings;
    hasClient: boolean;
    initialView: RespondentReportRevisionsView;
  };
  report: RespondentReportClientView | null;
}

export interface SessionDrawerProps {
  /** The selected session, or null when the drawer is closed. */
  item: AdminSessionRefItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SessionDrawer({ item, open, onOpenChange }: SessionDrawerProps) {
  const [data, setData] = useState<AdminViewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionId = item?.sessionId ?? null;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const view = await apiClient.get<AdminViewData>(API.APP.QUESTIONNAIRE_SESSIONS.adminView(id));
      setData(view);
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not load this session. Please retry.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load whenever the drawer opens on a session; clear when it closes so a reopen never flashes
  // the previous session's transcript.
  useEffect(() => {
    if (open && sessionId) void load(sessionId);
    if (!open) {
      setData(null);
      setError(null);
    }
  }, [open, sessionId, load]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l shadow-2xl duration-300 ease-out"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {item && (
            <>
              <header className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <DialogPrimitive.Title className="font-mono text-base font-semibold">
                      {item.refFormatted}
                    </DialogPrimitive.Title>
                    <Badge variant={item.status === 'completed' ? 'default' : 'secondary'}>
                      {item.status}
                    </Badge>
                    {item.isPreview && (
                      <span
                        title="Preview — admin rehearsal (excluded from analytics)"
                        className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                      >
                        <FlaskConical className="h-3 w-3" aria-hidden="true" />
                        Preview
                      </span>
                    )}
                  </div>
                  <DialogPrimitive.Description className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-medium">{item.questionnaireTitle}</span>
                    <span>· v{item.versionNumber}</span>
                    <span>· {item.percentComplete}% complete</span>
                    {(() => {
                      const { date, time, full } = formatCompactDateTime(item.createdAt);
                      return (
                        <span title={full}>
                          · {date} · {time}
                        </span>
                      );
                    })()}
                  </DialogPrimitive.Description>
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <ContextChip label="Client" value={item.clientName ?? 'Unassigned'} />
                    <ContextChip label="Cohort" value={item.cohortName ?? '—'} />
                    <ContextChip label="Round" value={item.roundName ?? '—'} />
                    <DurationChip item={item} />
                  </div>
                </div>
                <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-1.5 transition-colors">
                  <X className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              </header>

              {loading ? (
                <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading session…
                </div>
              ) : error ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-destructive text-sm">{error}</p>
                  <button
                    type="button"
                    onClick={() => sessionId && void load(sessionId)}
                    className="text-primary text-sm underline"
                  >
                    Retry
                  </button>
                </div>
              ) : data ? (
                <Tabs defaultValue="transcript" className="flex min-h-0 flex-1 flex-col">
                  <div className="px-5 pt-3">
                    <TabsList>
                      <TabsTrigger value="transcript">Transcript</TabsTrigger>
                      <TabsTrigger value="report">Report</TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent
                    value="transcript"
                    className="mt-0 min-h-0 flex-1 overflow-hidden px-5 pb-3"
                  >
                    {data.turns.length > 0 ? (
                      <SessionWorkspace
                        sessionId={item.sessionId}
                        initialTurns={data.turns}
                        readOnly
                      />
                    ) : (
                      <p className="text-muted-foreground py-12 text-center text-sm">
                        No conversation yet — this session has no turns.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent
                    value="report"
                    className="mt-0 min-h-0 flex-1 overflow-y-auto px-5 pb-4"
                  >
                    <ReportTab
                      sessionId={item.sessionId}
                      report={data.report}
                      panel={data.reportPanel}
                    />
                  </TabsContent>
                </Tabs>
              ) : null}

              <footer className="flex items-center justify-between gap-3 border-t px-5 py-3">
                <SessionDownloads
                  questionnaireId={item.questionnaireId}
                  sessionId={item.sessionId}
                />
                <Link
                  href={`${workspaceVersionBase(item.questionnaireId, item.versionId)}/sessions/${item.sessionId}`}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
                >
                  Open full page
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </footer>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The Report tab: the delivered report (when generated) above the re-run history + trigger. */
function ReportTab({
  sessionId,
  report,
  panel,
}: {
  sessionId: string;
  report: RespondentReportClientView | null;
  panel: AdminViewData['reportPanel'];
}) {
  const insights = report?.insights ?? null;
  const status = insights?.status ?? null;

  return (
    <div className="space-y-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <ReportStatusLine report={report} />
        <SessionReportRerun
          sessionId={sessionId}
          initialSettings={panel.settings}
          initialView={panel.initialView}
          hasClient={panel.hasClient}
        />
      </div>

      {status === 'ready' && insights?.content ? (
        <div className="bg-card rounded-lg border p-5 sm:p-6">
          <ReportBody
            content={insights.content}
            formatted={insights.formatted}
            completionPct={insights.completionPct}
            variant="screen"
            animate={false}
          />
        </div>
      ) : status === 'failed' ? (
        <p className="text-destructive rounded-lg border border-dashed p-6 text-center text-sm">
          The report failed to generate{insights?.error ? `: ${insights.error}` : '.'} Use “Re-run
          report” to try again.
        </p>
      ) : status === 'queued' || status === 'processing' ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          The report is being generated — check back shortly, or open “Re-run report” to watch its
          status.
        </p>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          No AI report has been generated for this session. Use “Re-run report” to generate one.
        </p>
      )}
    </div>
  );
}

/** A one-line summary of the delivered report's state. */
function ReportStatusLine({ report }: { report: RespondentReportClientView | null }) {
  if (!report || !report.insights) {
    return <span className="text-muted-foreground text-sm">Delivered report</span>;
  }
  const label =
    report.insights.status === 'ready'
      ? 'Delivered report'
      : report.insights.status === 'failed'
        ? 'Report failed'
        : 'Report generating…';
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {report.insights.generatedAt && (
        <span className="text-muted-foreground text-xs">
          {new Date(report.insights.generatedAt).toLocaleString()}
        </span>
      )}
    </div>
  );
}

/** Duration chip: beginning-to-end span, with a sittings marker when the session was staged. */
function DurationChip({ item }: { item: AdminSessionRefItem }) {
  const staged = (item.sittings ?? 1) > 1;
  const value =
    item.durationMs == null
      ? '—'
      : staged
        ? `${formatCompactDuration(item.durationMs)} · ${item.sittings} sittings`
        : `${formatCompactDuration(item.durationMs)} · one sitting`;
  const title =
    item.durationMs != null && staged
      ? `~${formatCompactDuration(item.activeMs)} active over ${formatCompactDuration(item.durationMs)} elapsed`
      : undefined;
  return (
    <span
      title={title}
      className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
    >
      {staged ? (
        <Split className="h-3 w-3" aria-hidden="true" />
      ) : (
        <span className="font-medium">Duration</span>
      )}
      <span className="text-foreground">{value}</span>
    </span>
  );
}

/** A compact "label: value" context chip for the drawer header. */
function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <span
      className={cn(
        'bg-muted/60 text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs'
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="text-foreground max-w-[12rem] truncate">{value}</span>
    </span>
  );
}
