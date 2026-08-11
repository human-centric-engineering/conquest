'use client';

/**
 * QuestionnairePackButton — the "Questionnaire pack" CTA in the workspace header, so the branded
 * pack is reachable from ANY tab rather than only from the Structure tab's Export / download menu.
 *
 * The pack (title, questions, data slots, definitions, experience setup, optionally evaluation
 * findings — PDF/CSV/Markdown) is a share-facing deliverable in its own right, not a variant of the
 * brand-free instrument export, so it gets header billing beside Preview and Duplicate. It opens
 * the same {@link PackExportDialog} the Export menu opens; that menu item stays as the secondary
 * path for admins who look for downloads under "Export / download".
 *
 * `secondary` rather than `outline` (its header neighbours) to carry more weight without claiming
 * the primary slot that per-tab CTAs like Edit and Launch use.
 *
 * The caller decides whether to render it — the pack needs a parsed structure, so the workspace
 * layout gates on the version graph being present, the same way it gates Preview.
 */

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PackExportDialog } from '@/components/admin/questionnaires/pack-export-dialog';
import { cn } from '@/lib/utils';

export interface QuestionnairePackButtonProps {
  questionnaireId: string;
  versionId: string;
  className?: string;
}

export function QuestionnairePackButton({
  questionnaireId,
  versionId,
  className,
}: QuestionnairePackButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn('shrink-0', className)}
        onClick={() => setOpen(true)}
        title="Download a branded, shareable pack — questions, data slots, definitions & experience setup"
      >
        <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Questionnaire pack
      </Button>

      <PackExportDialog
        open={open}
        onOpenChange={setOpen}
        questionnaireId={questionnaireId}
        versionId={versionId}
      />
    </>
  );
}
