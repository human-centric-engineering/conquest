'use client';

/**
 * DefinitionExportMenu — the "Export / download" dropdown on the Structure tab (F14.9).
 *
 * Surfaces two distinct artifacts for a version:
 *   - **Export definition (JSON)** — the full design-time definition (structure + settings + data
 *     slots + scoring), a portable file importable via the "New questionnaire → Import definition"
 *     menu to clone the questionnaire elsewhere.
 *   - **Download instrument (PDF / text / CSV)** — the *blank* questionnaire (its questions, for
 *     human review or paper distribution), with no respondent data.
 *
 * Both are authenticated same-origin GET routes that respond with `Content-Disposition: attachment`,
 * so a plain `<a download>` is enough — the browser saves the file. (Respondent *results* live behind
 * the separate Analytics export.)
 */

import { ChevronDown, Download, FileJson, FileSpreadsheet, FileText, FileType } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { API } from '@/lib/api/endpoints';

export interface DefinitionExportMenuProps {
  questionnaireId: string;
  versionId: string;
}

export function DefinitionExportMenu({ questionnaireId, versionId }: DefinitionExportMenuProps) {
  const definitionUrl = API.APP.QUESTIONNAIRES.versionDefinition(questionnaireId, versionId);
  const instrumentUrl = API.APP.QUESTIONNAIRES.versionInstrument(questionnaireId, versionId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="mr-1.5 h-4 w-4" />
          Export / download
          <ChevronDown className="ml-1.5 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal">
          <span className="font-medium">Definition</span>
          <span className="text-muted-foreground block text-xs">
            The whole questionnaire (structure, settings, data slots, scoring) as a portable file —
            re-import it to clone this questionnaire.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={definitionUrl} download>
            <FileJson className="mr-2 h-4 w-4" />
            Export definition (JSON)
          </a>
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
  );
}
