'use client';

/**
 * SessionComplete — the post-submission confirmation (F7.3, + F7.4 PDF download).
 *
 * Replaces the workspace once the respondent submits. A calm, positive close to the
 * conversation (distinct in tone from {@link ChatErrorPanel}'s blocking states), themed
 * via the page's `BrandThemeProvider` CSS vars. Shows a count of captured answers when
 * known, so the respondent sees their effort acknowledged.
 *
 * The card and its insights ease in on mount (the same restrained fade+rise the intro
 * splash uses), so the close of the conversation lands as a moment rather than an abrupt
 * surface swap. While the AI report generates, the "preparing" state quietly cycles the
 * positions the respondent shared (from the answer panel) instead of a bare spinner — the
 * wait reads as personal, not dead time — and falls back to a calm "taking longer than
 * usual" message with a retry if generation outruns the poll window.
 *
 * F7.4: offers a "Download PDF" of their responses. The download must `fetch` (not a
 * plain `<a download>`) so it can send the anonymous `X-Session-Token` header — a no-login
 * respondent has no cookie, only the client-held token. The blob is saved via an
 * object-URL; a transient error line appears if the request fails, keeping the calm tone.
 *
 * F7.6: adds a {@link TranscriptDownload} (themed PDF / plain text) of the conversation
 * itself, always available once submitted — independent of the responses-report config.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2, Maximize2 } from 'lucide-react';

import { cn, slugify } from '@/lib/utils';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';
import { TranscriptDownload } from '@/components/app/questionnaire/lifecycle/transcript-download';
import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import { API } from '@/lib/api/endpoints';
import { useRespondentReport } from '@/lib/hooks/use-respondent-report';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';
import {
  partialReportCaveat,
  splitReportParagraphs,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';
import type { RespondentReportHeader } from '@/lib/app/questionnaire/report/view';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';

/**
 * Build the PDF download filename from the questionnaire title so a saved file reads as the
 * questionnaire (e.g. `merlin5-alpha-demo.pdf`), not a generic `responses.pdf`. A blob download must
 * set `anchor.download` explicitly (the server's Content-Disposition is lost through the object URL),
 * so we slugify here. Falls back to `responses` when the title is empty/untitled.
 */
function downloadFilename(title: string | undefined): string {
  return `${slugify(title ?? '') || 'responses'}.pdf`;
}

/** Restrained fade-and-rise, matched to the intro splash so the run's bookends feel of a piece. */
const REVEAL =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500';

export interface SessionCompleteProps {
  /** The session to export. */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions (cookie carries auth). */
  accessToken?: string;
  /** Number of answers captured, or null when unknown. */
  answeredCount: number | null;
  /** The session's raw support reference; shown so the respondent can quote it later. */
  refRaw?: string | null;
  /**
   * The last-settled answer-panel view, used only to source the "while we prepare your report"
   * cycler — short echoes of the positions the respondent shared. Null/omitted simply hides the
   * cycler (the preparing state falls back to its plain caption).
   */
  captured?: AnswerPanelView | null;
  className?: string;
}

export function SessionComplete({
  sessionId,
  accessToken,
  answeredCount,
  refRaw,
  captured,
  className,
}: SessionCompleteProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);
  // Full-page ("A4") preview of the finished report, opened from the report toolbar's expand control.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Guard against a double-click kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  // Respondent report view (polls while insights generate). When no report is configured the view
  // is `enabled: false` and the screen keeps its default responses-PDF download (F7.4 behaviour).
  const { view, loaded, timedOut, retry, notify } = useRespondentReport(sessionId, accessToken);
  const reportEnabled = view?.enabled ?? false;
  // In an AI report mode the downloaded PDF's headline IS the generated report, so hold the button
  // until the report is actually ready — offering a "download" mid-generation would hand the
  // respondent a PDF with no report in it. Raw/disabled modes download the answers PDF immediately.
  const reportIsAiMode = reportEnabled && isAiRespondentReportMode(view!.mode);
  const reportReady = view?.insights?.status === 'ready';
  // Hold the download button until the view resolves so a `download: false` config never flashes a
  // clickable button in the gap before the first fetch settles. No report configured → default on.
  const showDownload = loaded
    ? reportEnabled
      ? view!.download && (!reportIsAiMode || reportReady)
      : true
    : false;
  // Both AI modes (raw_plus_insights, narrative) render their generated content here; the
  // completion screen never lists raw answers, so a narrative report already shows woven-only.
  const showInsights =
    reportEnabled &&
    view!.onScreen &&
    isAiRespondentReportMode(view!.mode) &&
    view!.insights !== null;

  const sharedSnippets = useMemo(() => extractSharedSnippets(captured ?? null), [captured]);

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
        anchor.download = downloadFilename(view?.questionnaireTitle);
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
  }, [sessionId, accessToken, view?.questionnaireTitle]);

  return (
    // `m-auto` (not `items-center`) centres the card when it fits yet lets a too-tall card scroll
    // from its top instead of clipping — the card itself is capped at `max-h-full` and scrolls within.
    <div className={cn('flex h-full min-h-0 overflow-y-auto p-6', className)}>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'bg-card m-auto flex max-h-full min-h-0 flex-col rounded-2xl border text-center',
          REVEAL,
          // When the report is present, commit real vertical estate to it: widen the card and give it
          // a tall floor (capped by `max-h-full`, then the report region scrolls) so the generation
          // updates and the finished text aren't squeezed into a two-line sliver.
          showInsights ? 'min-h-[min(42rem,100%)] w-full max-w-2xl' : 'max-w-md'
        )}
      >
        {/* Celebratory header — pinned, so it stays the "moment" while a long report scrolls below.
            Trimmed tighter when a report follows, so the header stays a greeting, not the whole card. */}
        <div
          className={cn(
            'relative flex shrink-0 flex-col items-center px-8',
            showInsights ? 'gap-3 border-b pt-7 pb-5' : 'gap-4 pt-10 pb-4'
          )}
        >
          {/* With a report present the footer is reserved for downloads, so the support reference rides
              in the header's top corner instead — quiet, out of the way, still one tap to copy. */}
          {showInsights && refRaw && (
            <SessionRefChip refRaw={refRaw} className="absolute top-4 right-4 text-[11px]" />
          )}
          <span
            className={cn(
              'flex items-center justify-center rounded-full',
              showInsights ? 'h-11 w-11' : 'h-14 w-14'
            )}
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 14%, transparent)',
              color: 'var(--app-accent-color, var(--color-primary))',
            }}
          >
            <CheckCircle2 className={cn(showInsights ? 'h-6 w-6' : 'h-7 w-7')} aria-hidden="true" />
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
        </div>

        {showInsights && view?.insights && (
          <div className="flex min-h-0 flex-auto flex-col">
            {/* Report toolbar — pinned above the scroll (clear of its fade mask) once the report lands,
                giving the section a title and the expand-to-full-page control. Hidden while the report
                is still preparing/failed, where there's nothing yet to expand. */}
            {reportReady && (
              <div className="flex shrink-0 items-center justify-between gap-3 px-8 pt-4 pb-1">
                <p className="text-muted-foreground/70 text-[11px] font-semibold tracking-wide uppercase">
                  Your personalised report
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground -mr-2 h-7 gap-1.5 px-2 text-xs"
                  onClick={() => setPreviewOpen(true)}
                >
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Expand
                </Button>
              </div>
            )}
            {/* The one region that scrolls. `flex-auto` sizes it to its content when the card fits and
                lets it shrink-and-scroll once the card hits `max-h-full`; the mask softens both edges so
                clipped text reads as "more below/above" rather than an abrupt cut. Padded ≥ the mask
                width so resting text is never faded — only text scrolling under the edge is. */}
            <div
              className="min-h-0 flex-auto [scrollbar-width:thin] overflow-y-auto overscroll-contain px-8 py-4 text-left"
              style={{
                maskImage:
                  'linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%)',
              }}
            >
              <ReportInsights
                insights={view.insights}
                snippets={sharedSnippets}
                timedOut={timedOut}
                onRetry={retry}
                onNotify={notify}
              />
            </div>
          </div>
        )}

        {/* Actions — pinned footer, so the primary download stays reachable past a long report. Kept
            lean when a report is present (the reference has moved to the header), so it doesn't steal
            vertical space from the report itself. */}
        <div
          className={cn(
            'flex shrink-0 flex-col items-center px-8',
            showInsights ? 'gap-3 border-t pt-4 pb-6' : 'gap-4 pt-0 pb-10'
          )}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
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
            {/* The conversation record is always available once submitted — a completed session
                always has a transcript, independent of the responses-report config above. */}
            <TranscriptDownload sessionId={sessionId} accessToken={accessToken} variant="outline" />
          </div>
          {error && (
            <p className="text-destructive text-xs" role="alert">
              Couldn&rsquo;t prepare your PDF. Please try again.
            </p>
          )}

          {/* Without a report the header stays compact, so the reference keeps its calm footer spot. */}
          {!showInsights && refRaw && (
            <div className="mt-1 border-t pt-3">
              <SessionRefChip refRaw={refRaw} />
            </div>
          )}
        </div>
      </div>

      {reportReady && view?.insights?.content && (
        <ReportPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          title={view.questionnaireTitle}
          header={view.header}
          content={view.insights.content}
          formatted={view.insights.formatted}
          completionPct={view.insights.completionPct}
        />
      )}
    </div>
  );
}

/**
 * Full-page ("A4") preview of the finished report, opened from the completion screen's expand control.
 * Lifts the report out of the cramped completion card onto a paper-styled sheet — the on-screen
 * approximation of the downloadable PDF — so the respondent can read it comfortably before saving it.
 * The dialog fills most of the viewport; the sheet scrolls within a muted "desk" backdrop.
 */
function ReportPreviewDialog({
  open,
  onOpenChange,
  title,
  header,
  content,
  formatted,
  completionPct,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  header?: RespondentReportHeader | null;
  content: RespondentReportContent;
  formatted: boolean;
  completionPct: number | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-muted/40 flex h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-[920px] flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="bg-background flex-row items-center justify-between space-y-0 border-b px-5 py-3 text-left">
          <DialogTitle className="text-sm font-semibold">Report preview</DialogTitle>
          <DialogDescription className="sr-only">
            A full-page preview of your personalised report, laid out as it appears in the PDF.
          </DialogDescription>
        </DialogHeader>
        {/* Muted "desk" that the paper sits on; the sheet scrolls within it. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-8">
          <div className="mx-auto w-full max-w-[210mm] rounded-sm bg-white px-[9%] py-[8%] text-neutral-900 shadow-xl ring-1 ring-black/5 sm:px-[12%] sm:py-[10%]">
            <ReportPaperHeader title={title} header={header ?? null} />
            <ReportBody
              content={content}
              formatted={formatted}
              completionPct={completionPct}
              variant="paper"
              animate={false}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Format an ISO timestamp as a readable date, or null when absent/unparseable (matches the PDF). */
function formatHeaderDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The paper masthead for the A4 preview — the on-screen twin of the PDF's branded header: the demo
 * client's logo (when configured), the questionnaire title, the same Version/Ref/Goal/Audience/
 * Respondent/Completed metadata rows, and the accent-coloured rule beneath. Falls back gracefully:
 * no `header` → just the title; no logo → no image (as the PDF does).
 */
function ReportPaperHeader({
  title,
  header,
}: {
  title?: string;
  header: RespondentReportHeader | null;
}) {
  const completed = formatHeaderDate(header?.completedAt ?? null);
  return (
    <div
      className="mb-7 border-b-2 pb-5"
      style={{ borderBottomColor: header?.accentColor ?? '#e5e7eb' }}
    >
      {header?.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- external brand logo (arbitrary host); not a Next-optimisable asset.
        <img
          src={header.logoUrl}
          alt=""
          className="mb-4 h-8 max-w-[55%] object-contain object-left"
        />
      )}
      {title && (
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-balance text-neutral-900">
          {title}
        </h1>
      )}
      {header && (
        <div className="space-y-0.5">
          <MetaRow label="Version">{header.versionNumber}</MetaRow>
          {header.ref && <MetaRow label="Ref:">{formatSessionRef(header.ref)}</MetaRow>}
          {header.goal && <MetaRow label="Goal:">{header.goal}</MetaRow>}
          {header.audienceSummary && <MetaRow label="Audience:">{header.audienceSummary}</MetaRow>}
          <MetaRow label="Respondent:">{header.respondentLabel}</MetaRow>
          {completed && <MetaRow label="Completed:">{completed}</MetaRow>}
        </div>
      )}
    </div>
  );
}

/** One label + value line in the paper masthead's metadata block. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-neutral-500">
      <span className="font-semibold text-neutral-600">{label} </span>
      {children}
    </p>
  );
}

/** The AI insights section on the completion screen — preparing / ready / failed states. */
function ReportInsights({
  insights,
  snippets,
  timedOut,
  onRetry,
  onNotify,
}: {
  insights: {
    status: 'queued' | 'processing' | 'ready' | 'failed';
    started: boolean;
    content: RespondentReportContent | null;
    formatted: boolean;
    completionPct: number | null;
    generatedAt: string | null;
    error: string | null;
    notifyRequested: boolean;
  };
  snippets: SharedSnippet[];
  timedOut: boolean;
  onRetry: () => void;
  onNotify: (email: string) => Promise<boolean>;
}) {
  if (insights.status === 'failed') {
    // A terminal failure — offer a single re-try (re-queues + kicks the worker) rather than
    // stranding the respondent, and keep the calm tone.
    return (
      <div className="flex w-full flex-col items-center gap-3 text-center">
        <p className="text-muted-foreground text-sm text-balance" role="status">
          We couldn&rsquo;t prepare your personalised insights this time. Your responses were saved.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (insights.status !== 'ready' || !insights.content) {
    // Generation outran the poll window — offer a calm retry + "email me when ready" instead of an
    // endless spinner.
    if (timedOut) {
      return (
        <div className="flex w-full flex-col items-center gap-4 text-center">
          <p className="text-muted-foreground text-sm text-balance">
            Your personalised report is taking a little longer than usual. Your responses are safely
            saved — check again in a moment, or leave your email and we&rsquo;ll send it when
            it&rsquo;s ready.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Check again
          </Button>
          <NotifyWhenReady onNotify={onNotify} alreadyRequested={insights.notifyRequested} />
        </div>
      );
    }
    // Distinguish "not started yet" (no row) from "generating" (row queued/processing).
    return <PreparingReport snippets={snippets} starting={!insights.started} />;
  }

  return (
    <ReportBody
      content={insights.content}
      formatted={insights.formatted}
      completionPct={insights.completionPct}
    />
  );
}

/**
 * The report itself — caveat, summary, titled sections, and next actions — shared by the on-screen
 * completion card (`variant="screen"`) and the full-page A4 preview (`variant="paper"`). Only the
 * typographic scale and colour differ between the two: `screen` inherits theme tokens (works on the
 * card in light/dark); `paper` fixes dark-on-white print colours and a larger, more readable scale.
 */
function ReportBody({
  content,
  formatted,
  completionPct,
  variant = 'screen',
  animate = true,
}: {
  content: RespondentReportContent;
  formatted: boolean;
  completionPct: number | null;
  variant?: 'screen' | 'paper';
  animate?: boolean;
}) {
  const { summary, sections, actions } = content;
  const paper = variant === 'paper';
  // Formatter-produced reports are pre-laid-out — honour their paragraphs verbatim (skip the
  // deterministic sentence re-grouping, which would re-chop deliberate paragraphs).
  const trust = { trustParagraphs: formatted };
  // Deterministic caveat for a report generated from a partially-complete questionnaire.
  const caveat = partialReportCaveat(completionPct);
  // Stagger the report in as it lands so it resolves gracefully out of the preparing state. The paper
  // preview is already-settled content, so it opts out (`animate={false}`) — no re-stagger on open.
  let step = 0;
  const reveal = animate ? REVEAL : '';
  const delay = () =>
    animate
      ? { animationDelay: `${step++ * 80}ms`, animationFillMode: 'both' as const }
      : undefined;

  const bodyText = paper
    ? 'text-[15px] leading-7 whitespace-pre-line text-neutral-700'
    : 'text-muted-foreground text-sm leading-relaxed whitespace-pre-line';
  const heading = paper
    ? 'text-base font-semibold text-neutral-900'
    : 'text-foreground text-sm font-semibold';

  return (
    <div className={cn('text-left', paper ? 'space-y-6' : 'w-full space-y-4')}>
      {caveat && (
        <p
          className={cn(
            'border-l-2 pl-3 italic',
            paper
              ? 'border-neutral-300 text-[13px] leading-relaxed text-neutral-500'
              : 'text-muted-foreground text-xs leading-relaxed'
          )}
          role="note"
        >
          {caveat}
        </p>
      )}
      <div className={cn(paper ? 'space-y-3' : 'space-y-2', reveal)} style={delay()}>
        {splitReportParagraphs(summary, trust).map((paragraph, i) => (
          // `whitespace-pre-line`: a preserved multi-line block (e.g. a bullet run the model wrote as
          // consecutive `- …` lines) keeps its newlines on screen, matching the PDF's <Text>.
          <p
            key={i}
            className={cn(
              'whitespace-pre-line',
              paper
                ? 'text-[15px] leading-7 text-neutral-800'
                : 'text-foreground text-sm leading-relaxed'
            )}
          >
            {paragraph}
          </p>
        ))}
      </div>
      {sections.map((section, i) => (
        <div key={i} className={cn(paper ? 'space-y-2' : 'space-y-1.5', reveal)} style={delay()}>
          <h2 className={heading}>{section.heading}</h2>
          {splitReportParagraphs(section.body, trust).map((paragraph, j) => (
            <p key={j} className={bodyText}>
              {paragraph}
            </p>
          ))}
        </div>
      ))}
      {actions.length > 0 && (
        <div className={cn(paper ? 'space-y-2' : 'space-y-1', reveal)} style={delay()}>
          <h2 className={heading}>What you can do next</h2>
          <ul
            className={cn(
              'list-disc space-y-1 pl-5',
              paper ? 'text-[15px] leading-7 text-neutral-700' : 'text-muted-foreground text-sm'
            )}
          >
            {actions.map((action, i) => (
              <li key={i}>{action}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "Email me when it's ready" — shown in the timeout fallback. A calm single-field capture (no-login
 * respondents have no account email), posting to the notify endpoint. Once accepted it swaps to a
 * quiet confirmation. Best-effort: a rejected email shows an inline hint, never a blocking error.
 */
function NotifyWhenReady({
  onNotify,
  alreadyRequested,
}: {
  onNotify: (email: string) => Promise<boolean>;
  alreadyRequested: boolean;
}) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(alreadyRequested);
  const [error, setError] = useState(false);

  // Sync when polling later reports a notify request (e.g. submitted from another tab) — the
  // useState initializer only runs on mount, so without this the form would re-show after a poll.
  useEffect(() => {
    if (alreadyRequested) setDone(true);
  }, [alreadyRequested]);

  if (done) {
    return (
      <p className="text-muted-foreground text-xs text-balance" role="status">
        We&rsquo;ll email you when your report is ready.
      </p>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || email.trim() === '') return;
    setSubmitting(true);
    setError(false);
    void onNotify(email.trim())
      .then((ok) => (ok ? setDone(true) : setError(true)))
      .catch(() => setError(true))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-xs flex-col items-center gap-2">
      <div className="flex w-full items-center gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address for your report"
          className="h-9 text-sm"
        />
        <Button type="submit" variant="outline" size="sm" disabled={submitting}>
          {submitting ? 'Saving…' : 'Email me'}
        </Button>
      </div>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          Couldn&rsquo;t save your email. Please try again.
        </p>
      )}
    </form>
  );
}

/**
 * The "preparing your report" state. Beyond the spinner caption, it gently cycles the positions the
 * respondent shared (their own words, echoed back) so the wait reads as personal rather than dead
 * air. Cross-fades one at a time when motion is allowed; under `prefers-reduced-motion` it shows a
 * short static list instead (no auto-advancing content).
 */
function PreparingReport({
  snippets,
  starting = false,
}: {
  snippets: SharedSnippet[];
  /** No report row exists yet (just submitted) — read as "Starting…" rather than "Preparing…". */
  starting?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reducedMotion || snippets.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % snippets.length), 3200);
    return () => clearInterval(id);
  }, [reducedMotion, snippets.length]);

  const caption = (
    <div
      className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {starting ? 'Starting your personalised report…' : 'Preparing your personalised report…'}
    </div>
  );

  if (snippets.length === 0) {
    return <div className="w-full">{caption}</div>;
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {caption}
      <div className="w-full">
        <p className="text-muted-foreground/70 mb-2 text-center text-[11px] font-medium tracking-wide uppercase">
          In the meantime, here&rsquo;s what you shared
        </p>
        {reducedMotion ? (
          <ul className="mx-auto flex max-w-md flex-col gap-2.5">
            {snippets.slice(0, 3).map((s, i) => (
              <li key={i} className="text-center">
                <SharedSnippetBody snippet={s} />
              </li>
            ))}
          </ul>
        ) : (
          // Fixed height so each cross-fade swaps in place without nudging the layout; `overflow-hidden`
          // plus the clamped body keep a long paraphrase inside the box rather than spilling over the
          // caption above. The modulo clamps `index` into range even if `snippets` shrank since the
          // interval last advanced.
          <div className="relative mx-auto flex h-24 max-w-md items-center justify-center overflow-hidden">
            <div
              key={index}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700"
            >
              <SharedSnippetBody snippet={snippets[index % snippets.length]} clamp />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One shared-position line: a small accent label over the respondent's paraphrased position. In the
 * cross-fade cycler the body is `clamp`ed to a few lines so a long paraphrase can't outgrow the
 * fixed-height slot and overlap the caption; the reduced-motion list leaves it unclamped (it flows).
 */
function SharedSnippetBody({
  snippet,
  clamp = false,
}: {
  snippet: SharedSnippet;
  clamp?: boolean;
}) {
  return (
    <>
      <p className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: ACCENT }}>
        {snippet.label}
      </p>
      <p
        className={cn(
          'text-foreground/90 mt-0.5 text-sm leading-relaxed text-balance',
          clamp && 'line-clamp-3'
        )}
      >
        {snippet.text}
      </p>
    </>
  );
}

/** A short echo of one position the respondent shared (label + their paraphrased answer). */
interface SharedSnippet {
  label: string;
  text: string;
}

/** Maximum positions to cycle — enough to feel personal without dragging the wait out. */
const MAX_SNIPPETS = 10;

/**
 * Distil the answer panel into short shared-position echoes. Prefers the data-slot paraphrases (the
 * agent's restatement of the respondent's position — already respondent-facing prose); falls back to
 * answered question slots when the version isn't in data-slot mode. Returns at most {@link MAX_SNIPPETS}.
 */
function extractSharedSnippets(view: AnswerPanelView | null): SharedSnippet[] {
  if (!view) return [];

  if (view.dataSlotGroups) {
    const out: SharedSnippet[] = [];
    for (const group of view.dataSlotGroups) {
      for (const slot of group.slots) {
        if (!slot.filled || !slot.paraphrase) continue;
        out.push({ label: slot.name, text: slot.paraphrase });
        if (out.length >= MAX_SNIPPETS) return out;
      }
    }
    return out;
  }

  const out: SharedSnippet[] = [];
  for (const section of view.sections) {
    for (const slot of section.slots) {
      if (!slot.answered) continue;
      const text = snippetTextForValue(slot.value);
      if (text === null) continue;
      out.push({ label: slot.prompt, text });
      if (out.length >= MAX_SNIPPETS) return out;
    }
  }
  return out;
}

/**
 * Render a captured answer value for the cycler, or `null` to skip it. Delegates the actual string
 * shaping to the shared panel {@link formatAnswerValue} (booleans → Yes/No, arrays comma-joined), but
 * skips shapes that don't read as the respondent's own words here — bare objects (the shared
 * formatter would JSON them) and empties (its `—` placeholder). Arrays are kept; their elements
 * format through the shared helper.
 */
function snippetTextForValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return null;
  const text = formatAnswerValue(value).trim();
  return text === '' || text === '—' ? null : text;
}
