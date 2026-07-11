/**
 * RefinementHistory — the audit trail of how an answer evolved (F7.2).
 *
 * Disclosure (Accordion) shown only when an answer has been refined. Each entry shows
 * the value change (previous → new) and why it changed, so a respondent can see the
 * conversation corrected an earlier capture rather than silently overwriting it.
 * Rendered nothing when the history is empty.
 */

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';
import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';
import type { RefinementSource } from '@/lib/app/questionnaire/refinement/types';

const SOURCE_LABELS: Record<RefinementSource, string> = {
  contradiction: 'Resolved a contradiction',
  clarification: 'Clarified',
  correction: 'Corrected',
  manual: 'Edited by you',
};

export interface RefinementHistoryProps {
  entries: PanelRefinementEntry[];
  /** The slot's type + config, so each value diff renders slot-aware (choice labels, likert/matrix points). */
  type: QuestionType;
  typeConfig: unknown;
}

export function RefinementHistory({ entries, type, typeConfig }: RefinementHistoryProps) {
  if (entries.length === 0) return null;

  return (
    <Accordion type="single" collapsible className="mt-1">
      <AccordionItem value="history" className="border-b-0">
        <AccordionTrigger className="py-1.5 text-xs font-medium">
          {entries.length === 1 ? '1 revision' : `${entries.length} revisions`}
        </AccordionTrigger>
        <AccordionContent className="pb-1">
          <ol className="space-y-2">
            {entries.map((entry, i) => (
              <li key={i} className="text-muted-foreground text-xs">
                <span className="line-through">
                  {formatSlotAnswer(type, typeConfig, entry.previousValue)}
                </span>
                {' → '}
                <span className="text-foreground">
                  {formatSlotAnswer(type, typeConfig, entry.newValue)}
                </span>
                <div>
                  {SOURCE_LABELS[entry.source]}
                  {entry.rationale ? ` — ${entry.rationale}` : ''}
                </div>
              </li>
            ))}
          </ol>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
