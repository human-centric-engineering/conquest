'use client';

/**
 * NewQuestionnaireMenu — the unified "New questionnaire" entry point on the
 * questionnaires list page.
 *
 * Replaces the standalone upload button with a split dropdown offering the two
 * ways to create a questionnaire:
 *   - **Upload document** — opens the existing {@link UploadQuestionnaireDialog}
 *     (driven in controlled mode so it opens from a menu item, not its own button).
 *   - **Describe your goal** — routes to the Compose Studio, where the admin types
 *     a brief and watches the questionnaire build (generative authoring).
 *
 * The "Describe your goal" item only renders when generative authoring is enabled
 * (the parent passes `generativeAuthoringEnabled`); with it off, the menu still
 * works as an upload-only entry point, so a fork can suppress the surface without
 * touching this component.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, FileUp, Plus, Sparkles, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UploadQuestionnaireDialog } from '@/components/admin/questionnaires/upload-questionnaire-dialog';
import { ImportDefinitionDialog } from '@/components/admin/questionnaires/import-definition-dialog';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

export interface NewQuestionnaireMenuProps {
  demoClientOptions?: AttributedDemoClient[];
  /** When false, the "Describe your goal" item is hidden. Callers pass `true` today. */
  generativeAuthoringEnabled?: boolean;
}

export function NewQuestionnaireMenu({
  demoClientOptions = [],
  generativeAuthoringEnabled = false,
}: NewQuestionnaireMenuProps) {
  const router = useRouter();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus className="mr-1.5 h-4 w-4" />
            New questionnaire
            <ChevronDown className="ml-1.5 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            <div className="flex flex-col">
              <span>Upload document</span>
              <span className="text-muted-foreground text-xs">
                Extract structure from a PDF, DOCX, XLSX, MD, or TXT
              </span>
            </div>
          </DropdownMenuItem>
          {generativeAuthoringEnabled && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push('/admin/questionnaires/compose')}>
                <Sparkles className="mr-2 h-4 w-4" />
                <div className="flex flex-col">
                  <span>Describe your goal</span>
                  <span className="text-muted-foreground text-xs">
                    Compose a questionnaire from a brief with AI
                  </span>
                </div>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <FileUp className="mr-2 h-4 w-4" />
            <div className="flex flex-col">
              <span>Import definition</span>
              <span className="text-muted-foreground text-xs">
                Create from an exported questionnaire definition (JSON)
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled — opened by the "Upload document" item; its own trigger is hidden. */}
      <UploadQuestionnaireDialog
        demoClientOptions={demoClientOptions}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        showTrigger={false}
      />

      {/* Controlled — opened by the "Import definition" item. */}
      <ImportDefinitionDialog
        demoClientOptions={demoClientOptions}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </>
  );
}
