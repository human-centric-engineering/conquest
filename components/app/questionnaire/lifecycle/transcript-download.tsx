'use client';

/**
 * TranscriptDownload — respondent download of the chat transcript (F7.6).
 *
 * A quiet dropdown that lets the respondent take their conversation away as a branded PDF
 * or plain text. Lives on the {@link SessionLifecycleBar} (so it's available throughout the
 * conversation, beside the support-reference chip) and on the {@link SessionComplete} screen.
 *
 * Like the F7.4 responses download, each format must `fetch` (not a plain `<a download>`) so
 * it can send the anonymous `X-Session-Token` header — a no-login respondent has no cookie,
 * only the client-held token. The blob is saved via an object-URL, honouring the server's
 * `Content-Disposition` filename when present. A transient error line appears on failure,
 * keeping the calm tone.
 */

import { useCallback, useRef, useState } from 'react';
import { ChevronDown, Download, FileText, FileType2, Loader2 } from 'lucide-react';

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
  const [busy, setBusy] = useState<TranscriptFormat | null>(null);
  const [error, setError] = useState(false);
  // Guard against a double-trigger kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  const download = useCallback(
    (format: TranscriptFormat) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(format);
      setError(false);

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
        .catch(() => setError(true))
        .finally(() => {
          inFlightRef.current = false;
          setBusy(null);
        });
    },
    [sessionId, accessToken]
  );

  const downloading = busy !== null;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant={variant} size="sm" disabled={downloading}>
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {downloading ? 'Preparing…' : 'Transcript'}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
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
          Couldn&rsquo;t download. Try again.
        </span>
      )}
    </span>
  );
}
