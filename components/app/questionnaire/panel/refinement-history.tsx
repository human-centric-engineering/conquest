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
import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';
import type { RefinementSource } from '@/lib/app/questionnaire/refinement/types';

const SOURCE_LABELS: Record<RefinementSource, string> = {
  contradiction: 'Resolved a contradiction',
  clarification: 'Clarified',
  correction: 'Corrected',
};

export interface RefinementHistoryProps {
  entries: PanelRefinementEntry[];
}

export function RefinementHistory({ entries }: RefinementHistoryProps) {
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
                <span className="line-through">{formatAnswerValue(entry.previousValue)}</span>
                {' → '}
                <span className="text-foreground">{formatAnswerValue(entry.newValue)}</span>
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
