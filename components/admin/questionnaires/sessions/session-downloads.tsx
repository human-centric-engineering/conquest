'use client';

/**
 * SessionDownloads — the admin's per-session takeaways on the session viewer (P8).
 *
 * Gives an admin the same takeaways a respondent gets on the completion screen, for any
 * session they're viewing:
 *  - **Download report (PDF)** — the answers/results export (embeds the AI report when ready),
 *    via the F7.4 admin route.
 *  - **Transcript** — the verbatim conversation as a branded PDF, plain text, or copied
 *    straight to the clipboard.
 *
 * All hit admin-guarded routes nested under the questionnaire, so the admin session cookie
 * authorises them (`credentials: 'same-origin'`) — no `X-Session-Token` (that's the respondent
 * surface). The file downloads honour the server's `Content-Disposition` filename, the same
 * pattern as the analytics {@link ExportButtons}; "Copy" reuses the plain-text route but writes
 * the body to the clipboard with a brief confirmation. Anonymous-mode redaction is applied
 * server-side, so an anonymous session's files carry no respondent identity.
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

export interface SessionDownloadsProps {
  questionnaireId: string;
  sessionId: string;
  className?: string;
}

/** Which action is in flight — drives the per-control busy state. */
type DownloadKind = 'report' | 'transcript-pdf' | 'transcript-txt' | 'transcript-copy';
/** How long the "Copied" confirmation stays before reverting to the idle label. */
const COPIED_FEEDBACK_MS = 2_000;

/** Extract a `filename="…"` from a `Content-Disposition` header, or null when absent. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? null;
}

export function SessionDownloads({ questionnaireId, sessionId, className }: SessionDownloadsProps) {
  const [busy, setBusy] = useState<DownloadKind | null>(null);
  // The action that last failed (drives the inline message), or null when fine.
  const [error, setError] = useState<DownloadKind | null>(null);
  const [copied, setCopied] = useState(false);
  // Guard against a double-trigger kicking off two concurrent renders.
  const inFlightRef = useRef(false);

  // Auto-clear the "Copied" confirmation after a short beat.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const download = useCallback((kind: DownloadKind, url: string, fallbackName: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(kind);
    setError(null);

    void fetch(url, { method: 'GET', credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const filename =
          filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      })
      .catch(() => setError(kind))
      .finally(() => {
        inFlightRef.current = false;
        setBusy(null);
      });
  }, []);

  const copyTranscript = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy('transcript-copy');
    setError(null);
    setCopied(false);

    void fetch(API.APP.QUESTIONNAIRES.sessionTranscriptText(questionnaireId, sessionId), {
      method: 'GET',
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        setCopied(true);
      })
      .catch(() => setError('transcript-copy'))
      .finally(() => {
        inFlightRef.current = false;
        setBusy(null);
      });
  }, [questionnaireId, sessionId]);

  const downloading = busy !== null;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={downloading}
        onClick={() =>
          download(
            'report',
            API.APP.QUESTIONNAIRES.sessionExportPdf(questionnaireId, sessionId),
            'report.pdf'
          )
        }
      >
        {busy === 'report' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {busy === 'report' ? 'Preparing…' : 'Download report (PDF)'}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={downloading}>
            {busy === 'transcript-pdf' ||
            busy === 'transcript-txt' ||
            busy === 'transcript-copy' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Transcript'}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => copyTranscript()}>
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
            Copy to clipboard
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              download(
                'transcript-pdf',
                API.APP.QUESTIONNAIRES.sessionTranscriptPdf(questionnaireId, sessionId),
                'transcript.pdf'
              )
            }
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            Themed PDF
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              download(
                'transcript-txt',
                API.APP.QUESTIONNAIRES.sessionTranscriptText(questionnaireId, sessionId),
                'transcript.txt'
              )
            }
          >
            <FileType2 className="h-4 w-4" aria-hidden="true" />
            Plain text
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error === 'transcript-copy'
            ? 'Couldn’t copy. Try again.'
            : 'Couldn’t download. Try again.'}
        </span>
      )}
    </span>
  );
}
