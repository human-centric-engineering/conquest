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
import { CheckCircle2, Download, Loader2 } from 'lucide-react';

import { cn, slugify } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';
import { TranscriptDownload } from '@/components/app/questionnaire/lifecycle/transcript-download';
import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import { API } from '@/lib/api/endpoints';
import { useRespondentReport } from '@/lib/hooks/use-respondent-report';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';
import {
  splitReportParagraphs,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';
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
  // Guard against a double-click kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  // Respondent report view (polls while insights generate). When no report is configured the view
  // is `enabled: false` and the screen keeps its default responses-PDF download (F7.4 behaviour).
  const { view, loaded, timedOut, retry, notify } = useRespondentReport(sessionId, accessToken);
  const reportEnabled = view?.enabled ?? false;
  // Hold the download button until the view resolves so a `download: false` config never flashes a
  // clickable button in the gap before the first fetch settles. No report configured → default on.
  const showDownload = loaded ? (reportEnabled ? view!.download : true) : false;
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
          showInsights ? 'w-full max-w-2xl' : 'max-w-md'
        )}
      >
        {/* Celebratory header — pinned, so it stays the "moment" while a long report scrolls below. */}
        <div
          className={cn(
            'flex shrink-0 flex-col items-center gap-4 px-8 pt-10',
            showInsights ? 'border-b pb-6' : 'pb-4'
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
        </div>

        {showInsights && view?.insights && (
          // The one region that scrolls. `flex-auto` sizes it to its content when the card fits and
          // lets it shrink-and-scroll once the card hits `max-h-full`; the mask softens both edges so
          // clipped text reads as "more below/above" rather than an abrupt cut. Padded ≥ the mask
          // width so resting text is never faded — only text scrolling under the edge is.
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
        )}

        {/* Actions + reference — pinned footer, so the primary download stays reachable past a long report. */}
        <div
          className={cn(
            'flex shrink-0 flex-col items-center gap-4 px-8 pb-10',
            showInsights ? 'border-t pt-6' : 'pt-0'
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

          {refRaw && (
            <div className="mt-1 border-t pt-3">
              <SessionRefChip refRaw={refRaw} />
            </div>
          )}
        </div>
      </div>
    </div>
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

  const { summary, sections, actions } = insights.content;
  // Stagger the report in as it lands so it resolves gracefully out of the preparing state.
  let step = 0;
  const delay = () => ({ animationDelay: `${step++ * 80}ms`, animationFillMode: 'both' as const });
  return (
    <div className="w-full space-y-4 text-left">
      <div className={cn('space-y-2', REVEAL)} style={delay()}>
        {splitReportParagraphs(summary).map((paragraph, i) => (
          // `whitespace-pre-line`: a preserved multi-line block (e.g. a bullet run the model wrote as
          // consecutive `- …` lines) keeps its newlines on screen, matching the PDF's <Text>.
          <p key={i} className="text-foreground text-sm leading-relaxed whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
      {sections.map((section, i) => (
        <div key={i} className={cn('space-y-1.5', REVEAL)} style={delay()}>
          <h2 className="text-foreground text-sm font-semibold">{section.heading}</h2>
          {splitReportParagraphs(section.body).map((paragraph, j) => (
            <p
              key={j}
              className="text-muted-foreground text-sm leading-relaxed whitespace-pre-line"
            >
              {paragraph}
            </p>
          ))}
        </div>
      ))}
      {actions.length > 0 && (
        <div className={cn('space-y-1', REVEAL)} style={delay()}>
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
          // Fixed height so each cross-fade swaps in place without nudging the layout. The modulo
          // clamps `index` into range even if `snippets` shrank since the interval last advanced.
          <div className="relative mx-auto flex h-16 max-w-md items-center justify-center">
            <div
              key={index}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700"
            >
              <SharedSnippetBody snippet={snippets[index % snippets.length]} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One shared-position line: a small accent label over the respondent's paraphrased position. */
function SharedSnippetBody({ snippet }: { snippet: SharedSnippet }) {
  return (
    <>
      <p className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: ACCENT }}>
        {snippet.label}
      </p>
      <p className="text-foreground/90 mt-0.5 text-sm leading-relaxed text-balance">
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
