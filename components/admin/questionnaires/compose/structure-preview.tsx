'use client';

/**
 * StructurePreview — read-only render of a composed questionnaire's sections and
 * questions, shared by the streaming phase (sections fill in as they arrive) and
 * the refined phase (re-rendered after each refine turn) of the Compose Studio.
 *
 * Purely presentational: it renders whatever {@link PreviewSection}[] it's given.
 * The studio owns the state; this component owns the look (per-section cards,
 * question rows with a type badge, a spinner while a section is still generating).
 */

import { Loader2, AlertCircle, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface PreviewQuestion {
  key: string;
  prompt: string;
  /** The questionnaire question type slug (e.g. `free_text`); rendered via {@link typeLabel}. */
  suggestedType: string;
}

export interface PreviewSection {
  ordinal: number;
  title: string;
  description?: string;
  status: 'pending' | 'done' | 'error';
  questions: PreviewQuestion[];
  message?: string;
}

/** Human label for a question type badge. */
const TYPE_LABELS: Record<string, string> = {
  free_text: 'Text',
  single_choice: 'Multi-Choice (one)',
  multi_choice: 'Multi-Choice (many)',
  likert: 'Likert',
  matrix: 'Matrix',
  numeric: 'Number',
  date: 'Date',
  boolean: 'Yes/No',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export interface StructurePreviewProps {
  sections: PreviewSection[];
  goal?: string;
}

export function StructurePreview({ sections, goal }: StructurePreviewProps) {
  if (sections.length === 0) return null;

  return (
    <div className="space-y-4">
      {goal && (
        <div className="cq-rise relative overflow-hidden rounded-xl border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] p-4 shadow-sm">
          {/* Faint architect's-grid texture — ties the goal card to the editor's blueprint motif. */}
          <div
            className="cq-blueprint pointer-events-none absolute inset-0 opacity-40"
            aria-hidden
          />
          <div className="relative flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)] shadow-sm">
              <Target className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="text-[10px] font-semibold tracking-[0.18em] text-[var(--cq-accent)] uppercase">
                Composing for
              </p>
              <p className="text-foreground text-[0.95rem] leading-snug font-medium text-balance">
                {goal}
              </p>
            </div>
          </div>
        </div>
      )}

      {sections.map((section) => (
        <div key={section.ordinal} className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-semibold">
                {section.ordinal + 1}
              </span>
              <h3 className="text-sm font-semibold">{section.title}</h3>
            </div>
            {section.status === 'pending' && (
              <Loader2
                className="text-muted-foreground h-4 w-4 animate-spin"
                aria-label="Generating"
              />
            )}
            {section.status === 'error' && (
              <AlertCircle className="text-destructive h-4 w-4" aria-label="Failed" />
            )}
            {section.status === 'done' && (
              <Badge variant="secondary" className="text-xs">
                {section.questions.length} question{section.questions.length === 1 ? '' : 's'}
              </Badge>
            )}
          </div>

          <div className={cn('px-4 py-3', section.status === 'pending' && 'opacity-60')}>
            {section.description && (
              <p className="text-muted-foreground mb-2 text-xs">{section.description}</p>
            )}
            {section.status === 'error' ? (
              <p className="text-destructive text-sm">
                {section.message ?? 'This section could not be generated.'}
              </p>
            ) : section.questions.length === 0 ? (
              <p className="text-muted-foreground text-sm italic">
                {section.status === 'pending' ? 'Writing questions…' : 'No questions.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {section.questions.map((q) => (
                  <li key={q.key} className="flex items-start justify-between gap-3">
                    <span className="text-sm">{q.prompt}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {typeLabel(q.suggestedType)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
