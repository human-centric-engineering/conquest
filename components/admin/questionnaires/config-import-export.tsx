'use client';

/**
 * ConfigImportExport — "Import / export settings" toolbar on the Settings tab.
 *
 * Export downloads the version's resolved run-time configuration as a portable JSON envelope
 * (see {@link buildSettingsExport}); Import reads such a file and PATCHes the whole config back
 * through the same endpoint the Save button uses — so fork-on-launch, the error banner, and the
 * refetch/resync all behave identically to a normal save. The server's `updateConfigSchema` is the
 * real validator; the client only shapes the file and confirms before overwriting.
 *
 * Importing overwrites ALL settings (including any unsaved edits in the form), so it goes through a
 * confirm dialog that previews what the file carries before applying.
 */

import { useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import {
  buildSettingsExport,
  parseSettingsImport,
  type SettingsImport,
} from '@/lib/app/questionnaire/authoring';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

/** Max import file size — settings are tiny; anything larger is almost certainly the wrong file. */
const MAX_IMPORT_BYTES = 1 * 1024 * 1024; // 1 MB

export function ConfigImportExport({
  questionnaireId,
  versionId,
  config,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  config: ConfigView;
  run: RunMutation;
  busy: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState<{ data: SettingsImport; fileName: string } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Reset the staged file whenever the dialog closes, so a re-open starts clean.
  useEffect(() => {
    if (!dialogOpen) {
      setPending(null);
      setParseError(null);
      setApplying(false);
    }
  }, [dialogOpen]);

  function handleExport() {
    const envelope = buildSettingsExport(config, new Date().toISOString());
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'questionnaire-settings.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later by clearing the input value.
    event.target.value = '';
    if (!file) return;

    setParseError(null);
    setPending(null);

    if (file.size > MAX_IMPORT_BYTES) {
      setParseError('That file is too large to be a settings export.');
      setDialogOpen(true);
      return;
    }

    try {
      const text = await file.text();
      const data = parseSettingsImport(text);
      setPending({ data, fileName: file.name });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read that file.');
    }
    setDialogOpen(true);
  }

  async function handleApply() {
    if (!pending) return;
    setApplying(true);
    const ok = await run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionConfig(questionnaireId, versionId),
      pending.data.config,
    ]);
    setApplying(false);
    if (ok) {
      setDialogOpen(false);
    } else {
      // The runner surfaces the server's specific message in the panel's banner above the form.
      setParseError(
        'Import failed — the settings in this file were rejected (see the error above).'
      );
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground mr-auto text-xs font-medium">
        Import / export settings{' '}
        <FieldHelp title="Import / export settings">
          <p>
            <strong>Export</strong> downloads every setting on this tab as a JSON file — a portable
            snapshot you can keep as a backup or reuse on another questionnaire version.
          </p>
          <p className="mt-2">
            <strong>Import</strong> reads such a file and replaces <em>all</em> settings here with
            its contents (including any unsaved changes), then saves — exactly as if you&apos;d
            edited every field and pressed Save. You&apos;ll see a confirmation first. Importing
            into a launched version saves the changes to a new draft, the same as any other edit.
          </p>
        </FieldHelp>
      </span>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => void handleFilePicked(e)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
      >
        <Upload className="mr-1 h-4 w-4" /> Import
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={handleExport} disabled={busy}>
        <Download className="mr-1 h-4 w-4" /> Export
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import settings</DialogTitle>
            <DialogDescription>
              This replaces every setting on this tab — including any unsaved changes — with the
              contents of the file, then saves.
            </DialogDescription>
          </DialogHeader>

          {parseError && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
              {parseError}
            </div>
          )}

          {pending && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">File:</span>{' '}
                <span className="font-medium break-all">{pending.fileName}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Settings found:</span>{' '}
                <span className="font-medium">{pending.data.keyCount}</span>
              </p>
              {pending.data.unknownKeys.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  {pending.data.unknownKeys.length} unrecognised field
                  {pending.data.unknownKeys.length === 1 ? '' : 's'} in the file will be ignored.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(false)}
              disabled={applying}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleApply()}
              disabled={!pending || applying || busy}
            >
              {applying ? 'Importing…' : 'Import & save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
