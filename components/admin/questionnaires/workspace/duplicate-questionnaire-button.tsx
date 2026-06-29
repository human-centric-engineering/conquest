'use client';

/**
 * "Duplicate" button for the questionnaire workspace header.
 *
 * Makes a plain copy of the questionnaire's current version — structure, settings,
 * data slots, and scoring (no respondent data) — into a new draft and navigates to
 * it. Shares the {@link useDuplicateQuestionnaire} hook with the list-row and
 * Export-menu affordances. Reachable from every workspace tab via the shared header.
 */

import { Copy, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';

export interface DuplicateQuestionnaireButtonProps {
  questionnaireId: string;
}

export function DuplicateQuestionnaireButton({
  questionnaireId,
}: DuplicateQuestionnaireButtonProps) {
  const { duplicate, isDuplicating, error } = useDuplicateQuestionnaire();

  return (
    <div className="flex flex-col items-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isDuplicating}
        onClick={() => void duplicate(questionnaireId)}
        title="Make a copy of this questionnaire and all its settings"
      >
        {isDuplicating ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Copy className="mr-1.5 h-4 w-4" />
        )}
        Duplicate
      </Button>
      {error && <span className="text-destructive mt-1 text-xs">{error}</span>}
    </div>
  );
}
