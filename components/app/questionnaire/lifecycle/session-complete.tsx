'use client';

/**
 * SessionComplete — the post-submission confirmation (F7.3, + F7.4 PDF download).
 *
 * Replaces the workspace once the respondent submits. A calm, positive close to the
 * conversation (distinct in tone from {@link ChatErrorPanel}'s blocking states), themed
 * via the page's `BrandThemeProvider` CSS vars. Shows a count of captured answers when
 * known, so the respondent sees their effort acknowledged.
 *
 * F7.4: offers a "Download PDF" of their responses. The download must `fetch` (not a
 * plain `<a download>`) so it can send the anonymous `X-Session-Token` header — a no-login
 * respondent has no cookie, only the client-held token. The blob is saved via an
 * object-URL; a transient error line appears if the request fails, keeping the calm tone.
 */

import { useCallback, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';
import { API } from '@/lib/api/endpoints';
import { useRespondentReport } from '@/lib/hooks/use-respondent-report';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';

export interface SessionCompleteProps {
  /** The session to export. */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions (cookie carries auth). */
  accessToken?: string;
  /** Number of answers captured, or null when unknown. */
  answeredCount: number | null;
  /** The session's raw support reference; shown so the respondent can quote it later. */
  refRaw?: string | null;
  className?: string;
}

export function SessionComplete({
  sessionId,
  accessToken,
  answeredCount,
  refRaw,
  className,
}: SessionCompleteProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);
  // Guard against a double-click kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  // Respondent report view (polls while insights generate). When no report is configured the view
  // is `enabled: false` and the screen keeps its default responses-PDF download (F7.4 behaviour).
  const { view, loaded } = useRespondentReport(sessionId, accessToken);
  const reportEnabled = view?.enabled ?? false;
  // Hold the download button until the view resolves so a `download: false` config never flashes a
  // clickable button in the gap before the first fetch settles. No report configured → default on.
  const showDownload = loaded ? (reportEnabled ? view!.download : true) : false;
  const showInsights =
    reportEnabled &&
    view!.onScreen &&
    view!.mode === 'raw_plus_insights' &&
    view!.insights !== null;

  const handleDownload = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setDownloading(true);
    setError(false);

    const headers: Record<string, string> = {};
    if (accessToken) headers['X-Session-Token'] = accessToken;

    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.exportPdf(sessionId), {
      method: 'GET',
      credentials: 'include',
      headers,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'responses.pdf';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => setError(true))
      .finally(() => {
        inFlightRef.current = false;
        setDownloading(false);
      });
  }, [sessionId, accessToken]);

  return (
    <div className={cn('flex h-full min-h-0 items-center justify-center p-6', className)}>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'bg-card flex flex-col items-center gap-4 rounded-2xl border px-8 py-10 text-center',
          showInsights ? 'max-w-2xl' : 'max-w-md'
        )}
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 14%, transparent)',
            color: 'var(--app-accent-color, var(--color-primary))',
          }}
        >
          <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-foreground text-xl font-semibold text-balance">
            Thank you — your responses are submitted
          </h1>
          <p className="text-muted-foreground text-sm text-balance">
            {answeredCount !== null && answeredCount > 0
              ? `We captured ${answeredCount} answer${answeredCount === 1 ? '' : 's'} from our conversation. There's nothing more you need to do.`
              : "There's nothing more you need to do."}
          </p>
        </div>

        {showInsights && view?.insights && <ReportInsights insights={view.insights} />}

        {showDownload && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {downloading ? 'Preparing…' : 'Download PDF'}
          </Button>
        )}
        {error && (
          <p className="text-destructive text-xs" role="alert">
            Couldn&rsquo;t prepare your PDF. Please try again.
          </p>
        )}

        {refRaw && (
          <div className="mt-1 border-t pt-3">
            <SessionRefChip refRaw={refRaw} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The AI insights section on the completion screen — preparing / ready / failed states. */
function ReportInsights({
  insights,
}: {
  insights: {
    status: 'queued' | 'processing' | 'ready' | 'failed';
    content: RespondentReportContent | null;
    generatedAt: string | null;
    error: string | null;
  };
}) {
  if (insights.status === 'failed') {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        We couldn&rsquo;t prepare your personalised insights this time. Your responses were saved.
      </p>
    );
  }

  if (insights.status !== 'ready' || !insights.content) {
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 text-sm"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Preparing your personalised report…
      </div>
    );
  }

  const { summary, sections, actions } = insights.content;
  return (
    <div className="w-full space-y-4 border-t pt-4 text-left">
      <p className="text-foreground text-sm leading-relaxed">{summary}</p>
      {sections.map((section, i) => (
        <div key={i} className="space-y-1">
          <h2 className="text-foreground text-sm font-semibold">{section.heading}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">{section.body}</p>
        </div>
      ))}
      {actions.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-foreground text-sm font-semibold">What you can do next</h2>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            {actions.map((action, i) => (
              <li key={i}>{action}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
