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
import { CheckCircle2, Download } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { API } from '@/lib/api/endpoints';

export interface SessionCompleteProps {
  /** The session to export. */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions (cookie carries auth). */
  accessToken?: string;
  /** Number of answers captured, or null when unknown. */
  answeredCount: number | null;
  className?: string;
}

export function SessionComplete({
  sessionId,
  accessToken,
  answeredCount,
  className,
}: SessionCompleteProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);
  // Guard against a double-click kicking off two concurrent renders.
  const inFlightRef = useRef(false);

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
        className="bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border px-8 py-10 text-center"
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
        {error && (
          <p className="text-destructive text-xs" role="alert">
            Couldn&rsquo;t prepare your PDF. Please try again.
          </p>
        )}
      </div>
    </div>
  );
}
