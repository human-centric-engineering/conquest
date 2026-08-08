'use client';

/**
 * The authoritative definitions document card (P16).
 *
 * An optional upload — the admin's own glossary, handbook, or programme guide. When attached, the
 * Glossary Analyst treats it as AUTHORITATIVE: it prefers a definition drawn from the document
 * over anything it infers, and quotes the supporting span so the admin can accept it without
 * re-reading the source.
 *
 * Uploading forks a launched version (it is a durable authoring change, unlike a proposal), so it
 * goes through `authoringMutate`'s fork-confirm protocol like every other write on this surface.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import {
  authoringMutate,
  AuthoringError,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';
import type { GlossaryDocumentView } from '@/lib/app/questionnaire/glossary';

/** File types `parseDocument` can read. Deliberately excludes .xlsx, which it cannot. */
const ACCEPT = '.pdf,.docx,.md,.txt';

export interface GlossaryDocumentCardProps {
  questionnaireId: string;
  versionId: string;
  document: GlossaryDocumentView | null;
  /** Disabled while an analysis is running — the document is that run's input. */
  disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GlossaryDocumentCard({
  questionnaireId,
  versionId,
  document,
  disabled = false,
}: GlossaryDocumentCardProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authoringMutate<{ document: GlossaryDocumentView; truncated: boolean }>(
        'POST',
        API.APP.QUESTIONNAIRES.versionGlossaryDocument(questionnaireId, versionId),
        form
      );
      if (res.meta?.forked) {
        router.push(`/admin/questionnaires/${questionnaireId}/v/${res.meta.versionId}/definitions`);
        return;
      }
      setNotice(
        res.data.truncated
          ? `Attached “${res.data.document.fileName}” — it was long, so only the first part will be used.`
          : `Attached “${res.data.document.fileName}”. Re-run the analysis to use it.`
      );
      router.refresh();
    } catch (err) {
      if (err instanceof ForkCancelledError) return;
      setError(err instanceof AuthoringError ? err.message : 'Could not attach that document.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ ok: true }>(
        'DELETE',
        API.APP.QUESTIONNAIRES.versionGlossaryDocument(questionnaireId, versionId)
      );
      if (res.meta?.forked) {
        router.push(`/admin/questionnaires/${questionnaireId}/v/${res.meta.versionId}/definitions`);
        return;
      }
      setNotice('Document removed. Definitions already drawn from it are kept.');
      router.refresh();
    } catch (err) {
      if (err instanceof ForkCancelledError) return;
      setError(err instanceof AuthoringError ? err.message : 'Could not remove that document.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-muted/30 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            Definitions document{' '}
            <FieldHelp title="Definitions document">
              Optional. Your own glossary, handbook, or programme guide. When attached, the analysis
              treats it as authoritative: it prefers a definition taken from your document over one
              it infers, and shows you the supporting quote. Accepts PDF, Word, Markdown or plain
              text. One per version — uploading again replaces it.
            </FieldHelp>
          </h3>
          {document ? (
            <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">{document.fileName}</span>
              <span>
                · {formatBytes(document.byteSize)} · {document.textLength.toLocaleString()}{' '}
                characters of text
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground mt-1 text-sm">
              None attached — definitions will be inferred from the questionnaire alone.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || disabled}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            {document ? 'Replace' : 'Attach a document'}
          </Button>
          {document && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || disabled}
              aria-label="Remove definitions document"
              onClick={() => void remove()}
            >
              <Trash2 className="text-destructive h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      {notice && <p className="text-muted-foreground mt-2 text-sm">{notice}</p>}
    </div>
  );
}
