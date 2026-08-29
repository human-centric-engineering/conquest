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
 * Multipart request / SSE response, so it `fetch`es a `FormData` body and reads the
 * stream directly (the JSON `authoringMutate` runner doesn't fit). It posts to
 * `POST …/versions/:vid/reingest/stream` — the same streaming pipeline the new-upload
 * dialog uses — so the admin sees the REAL phases (extracting, with a rising
 * "N questions so far" count → verifying → repairing → saving) rather than a scripted
 * ticker. On the terminal `done` event it `router.refresh()`es the detail page so the
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
import { ExtractionProgress } from '@/components/admin/questionnaires/status-ticker';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { UPLOAD_ACCEPT_ATTR } from '@/lib/app/questionnaire/constants';

/** Allowed upload extensions — DERIVED from the server's list, never a hand-kept copy. */
const ACCEPT = UPLOAD_ACCEPT_ATTR;

interface ReingestResult {
  sectionCount: number;
  questionCount: number;
  changeCount: number;
  deduped: boolean;
  /**
   * What the Routing Analyst proposed during this upload (F17.22 Phase 2), when the candidacy
   * check flagged the document and the run succeeded. Reported here because this dialog is the
   * only place the admin is still standing when it finishes — otherwise a proposal that cost a
   * real model call would be waiting on a tab nothing told them to open.
   */
  scopeProposal?: { topicCount: number; conditionalCount: number };
}

/** Narrow the `done` frame's optional proposal block — SSE data is `unknown` at this seam. */
function isScopeProposal(
  value: unknown
): value is { topicCount: number; conditionalCount: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { topicCount?: unknown }).topicCount === 'number' &&
    typeof (value as { conditionalCount?: unknown }).conditionalCount === 'number'
  );
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
  const instructionsId = useId();
  const requiredModeName = useId();
  const tablesId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [instructions, setInstructions] = useState('');
  /**
   * How the rebuilt questions are marked required. Defaults to `'all'`, matching the upload
   * dialog, because a re-ingest rebuilds the whole question graph and so faces exactly the same
   * question a first ingest does.
   *
   * There is no "keep what this version had" option: the new extraction mints new question keys,
   * so hand-tuned per-question flags have nothing to carry over onto. Saying so in the help text
   * is the honest version — the flags were being discarded either way, silently, and written back
   * as all-optional.
   */
  const [requiredMode, setRequiredMode] = useState<'all' | 'source'>('all');
  // On by default — the table pass self-detects (merges only when tables are found). Override.
  const [extractTables, setExtractTables] = useState(true);
  const [busy, setBusy] = useState(false);
  // The latest REAL phase message streamed from the re-ingest route (extracting →
  // verifying → repairing → saving). Rendered live — no scripted ticker.
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReingestResult | null>(null);

  function reset() {
    setGoal('');
    setInstructions('');
    setRequiredMode('all');
    setExtractTables(true);
    setError(null);
    setResult(null);
    setBusy(false);
    setPhase('');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a document to upload.');
      return;
    }

    setPhase('');
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.set('file', file);
      const trimmedGoal = goal.trim();
      if (trimmedGoal.length > 0) body.set('goal', trimmedGoal);
      const trimmedInstructions = instructions.trim();
      if (trimmedInstructions.length > 0) body.set('instructions', trimmedInstructions);
      body.set('requiredMode', requiredMode);
      // Always send the explicit value — the server defaults to on, so unchecking must
      // send 'false' to override rather than just omitting the field.
      body.set('extractTables', String(extractTables));

      // Multipart request, SSE response — extraction can outrun a synchronous request's
      // idle timeout on a multi-page PDF, so the server streams the work and reports its
      // real phases. Do NOT set Content-Type; the browser adds the multipart boundary.
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionReingestStream(questionnaireId, versionId),
        { method: 'POST', credentials: 'same-origin', body }
      );

      // A non-2xx (rate limit, scope-404, non-draft 409, upload guard) returns the JSON
      // error envelope, not a stream — surface its message.
      if (!res.ok || !res.body) {
        let message = 'Re-ingest failed. Please try again.';
        try {
          const parsed = await parseApiResponse<ReingestResult>(res);
          if (!parsed.success) message = parsed.error.message;
        } catch {
          // Non-JSON body — keep the default message.
        }
        setError(message);
        setBusy(false);
        return;
      }

      // Consume the event stream: `done` carries the new counts (or the dedup no-op),
      // `error` a message.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done: ReingestResult | null = null;
      let streamError: string | null = null;

      streamLoop: while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            if (parsed.type === 'phase' && typeof parsed.data.message === 'string') {
              // Real progress — the actual phase (extracting / verifying / repairing / saving).
              setPhase(parsed.data.message);
            } else if (parsed.type === 'done') {
              done = {
                sectionCount: Number(parsed.data.sectionCount ?? 0),
                questionCount: Number(parsed.data.questionCount ?? 0),
                changeCount: Number(parsed.data.changeCount ?? 0),
                deduped: parsed.data.deduped === true,
                ...(isScopeProposal(parsed.data.conditionalTopicsProposal)
                  ? { scopeProposal: parsed.data.conditionalTopicsProposal }
                  : {}),
              };
            } else if (parsed.type === 'error') {
              streamError =
                typeof parsed.data.message === 'string'
                  ? parsed.data.message
                  : 'Re-ingest failed. Please try again.';
              break streamLoop;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError || !done) {
        setError(streamError ?? 'Re-ingest failed. Please try again.');
        return;
      }
      setResult(done);
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
            {result.scopeProposal && (
              <p className="text-muted-foreground">
                The document describes routing, so AI proposed{' '}
                <strong>{result.scopeProposal.topicCount}</strong> topic
                {result.scopeProposal.topicCount === 1 ? '' : 's'}
                {result.scopeProposal.conditionalCount > 0 ? (
                  <>
                    , <strong>{result.scopeProposal.conditionalCount}</strong> of them conditional
                  </>
                ) : null}
                . Nothing is live — review them on the <strong>Conditional topics</strong> tab.
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
                  A <code>.pdf</code>, <code>.docx</code>, <code>.md</code>, <code>.txt</code>,{' '}
                  <code>.csv</code>, or <code>.xlsx</code> file (max 25 MB). The extractor re-reads
                  it from scratch and rebuilds this draft’s sections and questions.
                </FieldHelp>
              </Label>
              <Input
                id={fileInputId}
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                disabled={busy}
                required
                className="text-muted-foreground file:border-input file:bg-muted file:text-foreground hover:file:bg-accent cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border file:px-2.5 file:py-0.5"
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

            <div className="space-y-1.5">
              <Label htmlFor={instructionsId}>
                Extraction instructions{' '}
                <FieldHelp title="Extraction instructions">
                  Optional free-text guidance for the extractor agent — e.g. “the questions are in
                  the Activities tab” or “replace ‘HPE’ with ‘our organisation’”. Steers extraction;
                  doesn’t suppress inference.
                </FieldHelp>
              </Label>
              <Textarea
                id={instructionsId}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={busy}
                rows={3}
                placeholder="e.g. Skip the cover page and table of contents. Treat each numbered heading as a section. Replace the client's name with 'our organisation'."
              />
            </div>

            <fieldset className="space-y-2 border-t pt-4">
              <legend className="flex items-center gap-1 text-sm font-medium">
                Required fields{' '}
                <FieldHelp title="Required fields">
                  <p>
                    Replacing the structure rebuilds every question from the new document, so
                    anything you marked required by hand on this draft is rebuilt too. This chooses
                    what the rebuilt questions start as.
                  </p>
                  <p className="mt-2">
                    <strong>Make all fields required</strong> marks every question mandatory.{' '}
                    <strong>Use the document’s required markers</strong> keeps only the questions
                    the new document explicitly flags (an asterisk, “(required)”, “mandatory”)
                    required. You can change any question afterwards in the editor.
                  </p>
                </FieldHelp>
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={requiredModeName}
                  value="all"
                  checked={requiredMode === 'all'}
                  onChange={() => setRequiredMode('all')}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span>
                  Make all fields required <span className="text-muted-foreground">(default)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={requiredModeName}
                  value="source"
                  checked={requiredMode === 'source'}
                  onChange={() => setRequiredMode('source')}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span>
                  Use the document’s required markers
                  <span className="text-muted-foreground block text-xs">
                    Only fields the document marks as required stay required; others become
                    optional.
                  </span>
                </span>
              </label>
            </fieldset>

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
                On by default. Rating grids, 1–5 scales, and option lists are usually tables in a
                PDF, so parsing tabular layout into text rows lets the extractor read them
                correctly. It only affects PDFs and is applied only where tables are actually found
                — untick it to force it off.
              </FieldHelp>
            </div>

            {busy && <ExtractionProgress message={phase} />}
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
