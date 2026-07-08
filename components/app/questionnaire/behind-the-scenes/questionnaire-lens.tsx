'use client';

/**
 * Questionnaire lens selector.
 *
 * Picks a real questionnaire (we lens on its latest version) so the visualizer
 * can highlight which workflows actually apply to it. "Show all workflows"
 * clears the lens. Best-effort: the options load from the questionnaires list
 * on mount; a failure just leaves the selector empty.
 */

import { useEffect } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useQuestionnaireOptions,
  type QuestionnaireOption,
} from '@/components/app/questionnaire/behind-the-scenes/use-workflows';

/** Sentinel value for the "no lens" option (Select values must be non-empty). */
const NO_LENS = '__all__';

interface QuestionnaireLensProps {
  value: QuestionnaireOption | null;
  onChange: (option: QuestionnaireOption | null) => void;
}

export function QuestionnaireLens({ value, onChange }: QuestionnaireLensProps) {
  const { options, load } = useQuestionnaireOptions();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs whitespace-nowrap">Lens:</span>
      <Select
        value={value?.versionId ?? NO_LENS}
        onValueChange={(next) => {
          if (next === NO_LENS) {
            onChange(null);
            return;
          }
          onChange(options.find((o) => o.versionId === next) ?? null);
        }}
      >
        <SelectTrigger className="h-8 w-[240px] text-xs" aria-label="Questionnaire lens">
          <SelectValue placeholder="All workflows" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_LENS}>Show all workflows</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.versionId} value={o.versionId}>
              {o.title}
              <span className="text-muted-foreground"> · v{o.versionNumber}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
