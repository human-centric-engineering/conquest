'use client';

/**
 * TranscriptDownload — respondent download of the chat transcript (F7.6).
 *
 * A quiet dropdown that lets the respondent take their conversation away as a branded PDF,
 * plain text, or copied straight to the clipboard. Lives on the {@link SessionLifecycleBar}
 * (so it's available throughout the conversation, beside the support-reference chip) and on
 * the {@link SessionComplete} screen.
 *
 * Like the F7.4 responses download, each action must `fetch` (not a plain `<a download>`) so
 * it can send the anonymous `X-Session-Token` header — a no-login respondent has no cookie,
 * only the client-held token. The two download formats save the blob via an object-URL,
 * honouring the server's `Content-Disposition` filename when present; "Copy" reuses the same
 * plain-text endpoint but writes the body to the clipboard instead, flashing a brief
 * "Copied" confirmation. A transient error line appears on failure, keeping the calm tone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Download,
  FileText,
  FileType2,
  Loader2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { API } from '@/lib/api/endpoints';

export interface TranscriptDownloadProps {
  /** The session to export. */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions (cookie carries auth). */
  accessToken?: string;
  /** Trigger styling — `ghost` on the lifecycle strip, `outline` on the completion screen. */
  variant?: 'ghost' | 'outline';
  className?: string;
}

type TranscriptFormat = 'pdf' | 'txt';
/** Menu actions: the two file downloads plus copy-to-clipboard (reuses the txt endpoint). */
type TranscriptAction = TranscriptFormat | 'copy';
/** How long the "Copied" confirmation stays before reverting to the idle label. */
const COPIED_FEEDBACK_MS = 2_000;

/** Extract a `filename="…"` from a `Content-Disposition` header, or null when absent. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? null;
}

export function TranscriptDownload({
  sessionId,
  accessToken,
  variant = 'ghost',
  className,
}: TranscriptDownloadProps) {
  const [busy, setBusy] = useState<TranscriptAction | null>(null);
  // The action that last failed (drives the inline message), or null when fine.
  const [error, setError] = useState<TranscriptAction | null>(null);
  const [copied, setCopied] = useState(false);
  // Guard against a double-trigger kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  // Auto-clear the "Copied" confirmation after a short beat.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const download = useCallback(
    (format: TranscriptFormat) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(format);
      setError(null);

      const url =
        format === 'pdf'
          ? API.APP.QUESTIONNAIRE_SESSIONS.transcriptPdf(sessionId)
          : API.APP.QUESTIONNAIRE_SESSIONS.transcriptText(sessionId);
      const headers: Record<string, string> = {};
      if (accessToken) headers['X-Session-Token'] = accessToken;

      void fetch(url, { method: 'GET', credentials: 'include', headers })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const filename =
            filenameFromDisposition(res.headers.get('content-disposition')) ??
            `transcript.${format}`;
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = filename;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(objectUrl);
        })
        .catch(() => setError(format))
        .finally(() => {
          inFlightRef.current = false;
          setBusy(null);
        });
    },
    [sessionId, accessToken]
  );

  const copy = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy('copy');
    setError(null);
    setCopied(false);

    const headers: Record<string, string> = {};
    if (accessToken) headers['X-Session-Token'] = accessToken;

    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.transcriptText(sessionId), {
      method: 'GET',
      credentials: 'include',
      headers,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        setCopied(true);
      })
      .catch(() => setError('copy'))
      .finally(() => {
        inFlightRef.current = false;
        setBusy(null);
      });
  }, [sessionId, accessToken]);

  const downloading = busy !== null;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant={variant} size="sm" disabled={downloading}>
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {downloading ? 'Preparing…' : copied ? 'Copied' : 'Transcript'}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => copy()}>
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
            Copy to clipboard
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download('pdf')}>
            <FileText className="h-4 w-4" aria-hidden="true" />
            Themed PDF
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download('txt')}>
            <FileType2 className="h-4 w-4" aria-hidden="true" />
            Plain text
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error === 'copy' ? 'Couldn’t copy. Try again.' : 'Couldn’t download. Try again.'}
        </span>
      )}
    </span>
  );
}
