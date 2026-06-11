'use client';

/**
 * ReingestDialog (F2.4) — the admin trigger for re-ingesting a draft version.
 *
 * Uploads a *replacement* source document against an existing draft and replaces
 * that draft's extracted structure + editorial change log with a fresh
 * extraction. **Destructive** of manual edits and tag assignments on the draft —
 * the dialog states that plainly and the submit button is the confirm. An
 * identical re-upload (same SHA-256) short-circuits server-side to a no-op, which
 * the dialog surfaces as "nothing changed".
 *
 * Multipart, so it `fetch`es a `FormData` body directly (the JSON `authoringMutate`
 * runner doesn't fit). On success it `router.refresh()`es the detail page so the
 * new structure renders.
 */

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { StatusTicker, REINGEST_MESSAGES } from '@/components/admin/questionnaires/status-ticker';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';

/** Allowed upload extensions — mirrors the server's `ALLOWED_EXTENSIONS`. */
const ACCEPT = '.pdf,.docx,.md,.txt';

interface ReingestResult {
  sectionCount: number;
  questionCount: number;
  changeCount: number;
  deduped: boolean;
}

export interface ReingestDialogProps {
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
}

export function ReingestDialog({ questionnaireId, versionId, versionNumber }: ReingestDialogProps) {
  const router = useRouter();
  const fileInputId = useId();
  const goalId = useId();
  const tablesId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [extractTables, setExtractTables] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReingestResult | null>(null);

  function reset() {
    setGoal('');
    setExtractTables(false);
    setError(null);
    setResult(null);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a document to upload.');
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.set('file', file);
      const trimmedGoal = goal.trim();
      if (trimmedGoal.length > 0) body.set('goal', trimmedGoal);
      if (extractTables) body.set('extractTables', 'true');

      // Multipart — do NOT set Content-Type; the browser adds the boundary.
      const res = await fetch(API.APP.QUESTIONNAIRES.versionReingest(questionnaireId, versionId), {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      const parsed = await parseApiResponse<ReingestResult>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setResult(parsed.data);
      // Refresh the detail page so the replaced structure renders behind the dialog.
      router.refresh();
    } catch {
      setError('Re-ingest failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="mr-1.5 h-4 w-4" />
          Re-ingest
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-ingest v{versionNumber}</DialogTitle>
          <DialogDescription>
            Upload a replacement document to re-extract this draft. This{' '}
            <strong>replaces the structure, extraction change log, and tags</strong> of v
            {versionNumber} — manual edits to this draft will be lost. An identical document makes
            no changes.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm">
            {result.deduped ? (
              <p>This document is identical to the version’s current source — nothing changed.</p>
            ) : (
              <p>
                Re-ingested: <strong>{result.sectionCount}</strong> section
                {result.sectionCount === 1 ? '' : 's'}, <strong>{result.questionCount}</strong>{' '}
                question{result.questionCount === 1 ? '' : 's'},{' '}
                <strong>{result.changeCount}</strong> extraction change
                {result.changeCount === 1 ? '' : 's'}.
              </p>
            )}
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={fileInputId}>
                Replacement document{' '}
                <FieldHelp title="Replacement document">
                  A <code>.pdf</code>, <code>.docx</code>, <code>.md</code>, or <code>.txt</code>{' '}
                  file (max 25 MB). The extractor re-reads it from scratch and rebuilds this draft’s
                  sections and questions.
                </FieldHelp>
              </Label>
              <Input
                id={fileInputId}
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                disabled={busy}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={goalId}>
                Goal override{' '}
                <FieldHelp title="Goal override">
                  Optional. When set, this goal wins over whatever the extractor infers. Leave blank
                  to keep the inferred goal — or the version’s existing goal if the new extraction
                  doesn’t infer one.
                </FieldHelp>
              </Label>
              <Textarea
                id={goalId}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                disabled={busy}
                rows={2}
                placeholder="Leave blank to use the inferred goal"
              />
            </div>

            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={tablesId}
                checked={extractTables}
                onCheckedChange={setExtractTables}
                disabled={busy}
              />
              <Label htmlFor={tablesId} className="font-normal">
                Extract tables from PDF
              </Label>
              <FieldHelp title="Extract tables from PDF">
                Parse tabular layout in PDFs into text rows before extraction. Slower; only helps
                when the document’s questions live in tables.
              </FieldHelp>
            </div>

            {busy && <StatusTicker messages={REINGEST_MESSAGES} />}
            {error && <p className="text-destructive text-sm">{error}</p>}

            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={busy}>
                {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Replace structure
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
