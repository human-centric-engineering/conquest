'use client';

/**
 * One matched glossary term, rendered inline with a dotted underline and a popover (P16).
 *
 * Deliberately NOT `<FieldHelp>`: that renders a separate ⓘ icon button, which is right beside a
 * form label but wrong inside prose — it would litter the interviewer's sentences with icons. The
 * affordance here is the word itself. The class vocabulary and the popover body still mirror
 * FieldHelp so the two feel like one system.
 *
 * The trigger is a real `<button>` so it is keyboard-reachable and announced; `cursor-help` and
 * the dotted underline are the visual cue that it explains rather than navigates.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

export interface GlossaryTermMarkProps {
  /** The text exactly as it appeared — never the canonical term, so the sentence still reads. */
  surface: string;
  entry: GlossaryEntry;
}

export function GlossaryTermMark({ surface, entry }: GlossaryTermMarkProps) {
  const multiple = entry.definitions.length > 1;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-glossary-term={entry.termId}
          aria-label={`Definition of ${entry.term}`}
          className="decoration-muted-foreground/60 hover:decoration-foreground cursor-help underline decoration-dotted underline-offset-4 transition-colors"
          // A defined term can appear inside a <label>; without this, opening the popover would
          // also toggle the labelled control.
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {surface}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-60 w-80 overflow-y-auto text-sm">
        <p className="mb-1 font-medium">{entry.term}</p>
        {multiple ? (
          <>
            {/* Several selected definitions are never merged — the admin kept both senses on
                purpose, and collapsing them would assert a precision the questionnaire doesn't have. */}
            <p className="text-muted-foreground mb-1.5 text-xs">
              This questionnaire uses this term in more than one sense:
            </p>
            <ol className="text-muted-foreground list-decimal space-y-1 pl-4">
              {entry.definitions.map((definition, i) => (
                <li key={i}>{definition}</li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-muted-foreground">{entry.definitions[0]}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
