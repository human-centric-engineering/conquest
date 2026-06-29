'use client';

/**
 * DefinitionExportMenu — the "Export / download" dropdown on the Structure tab (F14.9).
 *
 * Surfaces the portability actions for a version in one place:
 *   - **Export definition (JSON)** — the full design-time definition (structure + settings + data
 *     slots + scoring), a portable file importable elsewhere.
 *   - **Import definition (JSON)** — create a brand-new questionnaire from a previously-exported
 *     definition file (opens {@link ImportDefinitionDialog}; same dialog as "New questionnaire →
 *     Import definition"). Surfaced here so export and its inverse sit together.
 *   - **Duplicate this questionnaire** — make a plain copy of the current version (structure +
 *     settings + data slots + scoring, no respondent data) without leaving for a file round-trip.
 *   - **Download instrument (PDF / text / CSV)** — the *blank* questionnaire (its questions, for
 *     human review or paper distribution), with no respondent data.
 *
 * The export / download links are authenticated same-origin GET routes that respond with
 * `Content-Disposition: attachment`, so a plain `<a download>` is enough. (Respondent *results*
 * live behind the separate Analytics export.)
 */

import { useState } from 'react';
import {
  ChevronDown,
  Copy,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileUp,
  Loader2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ImportDefinitionDialog } from '@/components/admin/questionnaires/import-definition-dialog';
import { API } from '@/lib/api/endpoints';
import { useDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';

export interface DefinitionExportMenuProps {
  questionnaireId: string;
  versionId: string;
}

export function DefinitionExportMenu({ questionnaireId, versionId }: DefinitionExportMenuProps) {
  const definitionUrl = API.APP.QUESTIONNAIRES.versionDefinition(questionnaireId, versionId);
  const instrumentUrl = API.APP.QUESTIONNAIRES.versionInstrument(questionnaireId, versionId);

  const [importOpen, setImportOpen] = useState(false);
  const { duplicate, isDuplicating, error } = useDuplicateQuestionnaire();

  return (
    <div className="flex flex-col items-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isDuplicating}>
            {isDuplicating ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-4 w-4" />
            )}
            Export / download
            <ChevronDown className="ml-1.5 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="font-normal">
            <span className="font-medium">Definition</span>
            <span className="text-muted-foreground block text-xs">
              The whole questionnaire (structure, settings, data slots, scoring) as a portable file
              — re-import it to clone this questionnaire.
            </span>
          </DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <a href={definitionUrl} download>
              <FileJson className="mr-2 h-4 w-4" />
              Export definition (JSON)
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <FileUp className="mr-2 h-4 w-4" />
            Import definition (JSON)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void duplicate(questionnaireId)}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate this questionnaire
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel className="font-normal">
            <span className="font-medium">Blank instrument</span>
            <span className="text-muted-foreground block text-xs">
              The questions only, for review or printing — no respondent answers.
            </span>
          </DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <a href={`${instrumentUrl}?format=pdf`} download>
              <FileType className="mr-2 h-4 w-4" />
              Download instrument (PDF)
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`${instrumentUrl}?format=text`} download>
              <FileText className="mr-2 h-4 w-4" />
              Download instrument (text)
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`${instrumentUrl}?format=csv`} download>
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              Download instrument (CSV)
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && <span className="text-destructive mt-1 text-xs">{error}</span>}

      {/* Controlled — opened by the "Import definition" item. */}
      <ImportDefinitionDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
