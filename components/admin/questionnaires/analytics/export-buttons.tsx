'use client';

/**
 * Result-export buttons for the analytics page (F8.2).
 *
 * Two buttons — CSV and JSON — that download the **completed-session** results for the
 * selected version through the F8.2 export route, carrying the same date/tag filter the
 * page is showing (so the export matches the view). Blob download via the server-supplied
 * `Content-Disposition` filename, mirroring the orchestration agents export.
 *
 * Anonymous-mode versions omit respondent identity and per-turn transcripts from both
 * formats — surfaced to the admin via the inline note + FieldHelp.
 */

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import type { ResultsExportFormat } from '@/lib/app/questionnaire/export/results-query';

export interface ExportButtonsProps {
  questionnaireId: string;
  versionId: string;
  /** The shared analytics filter query string (`?from=…&to=…&tagIds=…`) or `''`. */
  query: string;
}

export function ExportButtons({ questionnaireId, versionId, query }: ExportButtonsProps) {
  const [busy, setBusy] = useState<ResultsExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async (format: ResultsExportFormat) => {
      setBusy(format);
      setError(null);
      try {
        const base = API.APP.QUESTIONNAIRES.versionExport(questionnaireId, versionId);
        const url = `${base}${query ? `${query}&` : '?'}format=${format}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.status === 429) throw new Error('Too many exports — wait a minute and retry.');
        if (!res.ok) throw new Error('Export failed. Try again in a moment.');

        const disposition = res.headers.get('Content-Disposition') ?? '';
        const match = /filename="?([^";]+)"?/i.exec(disposition);
        const filename = match?.[1] ?? `results-${new Date().toISOString().slice(0, 10)}.${format}`;

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed. Try again in a moment.');
      } finally {
        setBusy(null);
      }
    },
    [questionnaireId, versionId, query]
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          Export completed sessions
          <FieldHelp title="Result exports">
            Downloads this version&rsquo;s completed sessions, filtered by the date window and tags
            above. CSV is one row per session × question; JSON is the full session graph (answers,
            provenance, and turns). Anonymous-mode versions omit respondent identity and per-turn
            transcripts from both formats.
          </FieldHelp>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void download('csv')}
        >
          {busy === 'csv' ? 'Exporting…' : 'Export CSV'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void download('json')}
        >
          {busy === 'json' ? 'Exporting…' : 'Export JSON'}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
