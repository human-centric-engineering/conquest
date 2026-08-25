'use client';

/**
 * Supporting documents — the companions the Routing Analyst reads beside the instrument (F17.29).
 *
 * An instrument does not always arrive as one file. A question bank plus a separate routing memo
 * was previously impossible to express: the only way to put a second document on a version was a
 * re-ingest, which replaces the structure extracted from the first. So the analyst read the memo
 * and lost the questions, or read the questions and never saw the routing rules it exists to find.
 *
 * Attaching here changes nothing about the questionnaire — no question, no section, no setting.
 * The document is parsed to text and kept beside the instrument for the next analyst run.
 *
 * It is an authoring write all the same (it changes what the analyst will propose), so it goes
 * through `authoringMutate`'s fork-confirm protocol like every other write on this surface.
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
import { MAX_SUPPLEMENTARY_DOCUMENTS } from '@/lib/app/questionnaire/constants';
import type { SourceDocumentView } from '@/lib/app/questionnaire/ingestion/source-documents';

/** File types `parseDocument` can read, plus the workbook flattener's `.xlsx`. */
const ACCEPT = '.pdf,.docx,.md,.txt,.csv,.xlsx';

export interface SupportingDocumentsCardProps {
  questionnaireId: string;
  versionId: string;
  /** Every document on the version — both the instrument and its companions. */
  documents: SourceDocumentView[];
  /** Disabled while another write on this tab is in flight. */
  disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SupportingDocumentsCard({
  questionnaireId,
  versionId,
  documents,
  disabled = false,
}: SupportingDocumentsCardProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The instrument is the NEWEST primary row: a re-ingest appends rather than replaces, and the
  // superseded upload describes a questionnaire that is no longer this one. `documents` arrives
  // newest-first, so the first primary in the list is that row.
  const instrument = documents.find((document) => document.role === 'primary') ?? null;
  const supporting = documents.filter((document) => document.role === 'supplementary');
  const full = supporting.length >= MAX_SUPPLEMENTARY_DOCUMENTS;

  const afterFork = (versionIdAfter: string): void => {
    const search = typeof window === 'undefined' ? '' : window.location.search;
    router.push(`/admin/questionnaires/${questionnaireId}/v/${versionIdAfter}/topics${search}`);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authoringMutate<{ documents: SourceDocumentView[] }>(
        'POST',
        API.APP.QUESTIONNAIRES.versionDocuments(questionnaireId, versionId),
        form
      );
      if (res.meta?.forked) {
        afterFork(res.meta.versionId);
        return;
      }
      setNotice(`Attached “${file.name}”. Run the AI proposal again to use it.`);
      router.refresh();
    } catch (err) {
      if (err instanceof ForkCancelledError) return;
      setError(err instanceof AuthoringError ? err.message : 'Could not attach that document.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (document: SourceDocumentView) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ documents: SourceDocumentView[] }>(
        'DELETE',
        API.APP.QUESTIONNAIRES.versionDocument(questionnaireId, versionId, document.id)
      );
      if (res.meta?.forked) {
        afterFork(res.meta.versionId);
        return;
      }
      setNotice(`Removed “${document.fileName}”. Topics already written from it are kept.`);
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
            Documents the AI reads{' '}
            <FieldHelp title="Documents the AI reads">
              The questionnaire you uploaded, plus anything else you attach here. Attach a
              supporting document when the rules about who gets asked what came as their own file —
              a routing memo, an eligibility appendix, a facilitator&rsquo;s guide. Nothing about
              the questionnaire changes: no question is added, edited or removed. Only the AI
              proposal reads these, and only when you run it. Up to {MAX_SUPPLEMENTARY_DOCUMENTS}{' '}
              supporting documents.
            </FieldHelp>
          </h3>

          <ul className="mt-2 space-y-1.5">
            {instrument ? (
              <li className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="text-foreground font-medium">{instrument.fileName}</span>
                <span>
                  · the questionnaire itself · {formatBytes(instrument.byteSize)} ·{' '}
                  {instrument.characterCount.toLocaleString()} characters
                </span>
              </li>
            ) : (
              <li className="text-muted-foreground text-sm">
                This version was not built from an uploaded document, so the AI has only the
                questions to read.
              </li>
            )}

            {supporting.map((document) => (
              <li key={document.id} className="flex items-center gap-1.5 text-sm">
                <FileText className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">{document.fileName}</span>
                <span className="text-muted-foreground">
                  · supporting · {formatBytes(document.byteSize)} ·{' '}
                  {document.characterCount.toLocaleString()} characters
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  disabled={busy || disabled}
                  aria-label={`Remove ${document.fileName}`}
                  onClick={() => void remove(document)}
                >
                  <Trash2 className="text-destructive h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
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
            disabled={busy || disabled || full}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            Attach a supporting document
          </Button>
        </div>
      </div>

      {full && (
        <p className="text-muted-foreground mt-2 text-sm">
          That is the limit of {MAX_SUPPLEMENTARY_DOCUMENTS}. Remove one to attach another.
        </p>
      )}
      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      {notice && <p className="text-muted-foreground mt-2 text-sm">{notice}</p>}
    </div>
  );
}
