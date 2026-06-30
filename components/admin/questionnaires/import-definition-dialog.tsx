'use client';

/**
 * ImportDefinitionDialog — create a new questionnaire from an exported definition file (F14.9).
 *
 * Reads a definition export (the JSON written by "Export definition (JSON)"), previews what it
 * carries, and POSTs it to `POST /api/v1/app/questionnaires/import`, which persists it as a
 * brand-new draft questionnaire and returns the new ids. The dialog then routes to the new draft's
 * Structure editor. Import is always create-only — it never overwrites existing work.
 *
 * The file is parsed + validated client-side ({@link parseDefinitionImport}) only to preview counts
 * and reject an obviously-wrong file early; the server re-validates the same way (it's the real
 * boundary). Mirrors the UX of {@link file://./config-import-export.tsx}, driven in controlled mode
 * from the "New questionnaire" menu.
 */

import { useEffect, useRef, useState } from 'react';
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
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parseDefinitionImport } from '@/lib/app/questionnaire/authoring';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

/** Max import file size — a definition is small; anything larger is almost certainly the wrong file. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Sentinel for "no demo client" on the attribution select (Radix forbids empty values). */
const NO_CLIENT = '__none__';

interface ImportResult {
  questionnaireId: string;
  versionId: string;
  sectionCount: number;
  questionCount: number;
  dataSlotCount: number;
}

/** What the staged file carries, for the confirm preview. */
interface Preview {
  fileName: string;
  text: string;
  title: string;
  sectionCount: number;
  questionCount: number;
  dataSlotCount: number;
  hasScoring: boolean;
}

export interface ImportDefinitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * DEMO-ONLY (F2.5.1): active demo clients available to attribute the imported
   * questionnaire to. Omitted/empty hides the attribution picker entirely (a fork
   * that strips demo tenancy, or a deployment with no clients yet).
   */
  demoClientOptions?: AttributedDemoClient[];
}

export function ImportDefinitionDialog({
  open,
  onOpenChange,
  demoClientOptions = [],
}: ImportDefinitionDialogProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [demoClientId, setDemoClientId] = useState<string>(NO_CLIENT);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Reset staged state whenever the dialog closes, so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setDemoClientId(NO_CLIENT);
      setError(null);
      setImporting(false);
    }
  }, [open]);

  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    setError(null);
    setPreview(null);

    if (file.size > MAX_IMPORT_BYTES) {
      setError('That file is too large to be a questionnaire definition.');
      return;
    }

    try {
      const text = await file.text();
      const envelope = parseDefinitionImport(text);
      const questionCount = envelope.version.sections.reduce(
        (sum, s) => sum + s.questions.length,
        0
      );
      setPreview({
        fileName: file.name,
        text,
        title: envelope.questionnaire.title,
        sectionCount: envelope.version.sections.length,
        questionCount,
        dataSlotCount: envelope.version.dataSlots?.length ?? 0,
        hasScoring: Boolean(envelope.version.scoringSchema),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    }
  }

  async function handleImport() {
    if (!preview) return;
    setImporting(true);
    setError(null);
    try {
      // The body is the definition file itself; attribution travels as a query param.
      const url =
        demoClientId === NO_CLIENT
          ? API.APP.QUESTIONNAIRES.definitionImport
          : `${API.APP.QUESTIONNAIRES.definitionImport}?demoClientId=${encodeURIComponent(demoClientId)}`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: preview.text,
      });
      const parsed = await parseApiResponse<ImportResult>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        setImporting(false);
        return;
      }
      // Land on the new draft's Structure editor (edit mode). Keep importing=true through navigation.
      onOpenChange(false);
      router.push(
        `/admin/questionnaires/${parsed.data.questionnaireId}/v/${parsed.data.versionId}/structure?edit=1`
      );
    } catch {
      setError('Import failed. Please try again.');
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import definition</DialogTitle>
          <DialogDescription>
            Create a brand-new questionnaire from an exported definition file. This never changes
            any existing questionnaire.{' '}
            <FieldHelp title="Import definition">
              <p>
                Pick a JSON file written by <strong>Export definition</strong> on a questionnaire’s
                Structure tab. It carries the full design — sections, questions, tags, settings,
                data slots, and scoring — and is imported as a fresh draft you own.
              </p>
              <p className="mt-2">
                Embeddings are regenerated after import, so the new questionnaire is ready to launch
                once you’ve reviewed it.
              </p>
            </FieldHelp>
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleFilePicked(e)}
        />

        {!preview && (
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <Upload className="mr-1.5 h-4 w-4" />
            Choose definition file
          </Button>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        {preview && (
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">File:</span>{' '}
              <span className="font-medium break-all">{preview.fileName}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Title:</span>{' '}
              <span className="font-medium">{preview.title}</span>
            </p>
            <p className="text-muted-foreground">
              {preview.sectionCount} section{preview.sectionCount === 1 ? '' : 's'} ·{' '}
              {preview.questionCount} question{preview.questionCount === 1 ? '' : 's'}
              {preview.dataSlotCount > 0
                ? ` · ${preview.dataSlotCount} data slot${preview.dataSlotCount === 1 ? '' : 's'}`
                : ''}
              {preview.hasScoring ? ' · scoring schema' : ''}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              Choose a different file
            </Button>
          </div>
        )}

        {/* DEMO-ONLY (F2.5.1): optional attribution. Hidden when there are no active clients. */}
        {demoClientOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="import-demo-client">
              Demo client{' '}
              <FieldHelp title="Demo-client attribution">
                Optional. Attribute the imported questionnaire to a demo client so its respondent
                surface and invitations wear that brand. “None” is a generic demo. You can change
                this later from the questionnaire’s Settings tab.
              </FieldHelp>
            </Label>
            <Select value={demoClientId} onValueChange={setDemoClientId} disabled={importing}>
              <SelectTrigger id="import-demo-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CLIENT}>None (generic demo)</SelectItem>
                {demoClientOptions.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleImport()}
            disabled={!preview || importing}
          >
            {importing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Import as new questionnaire
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
