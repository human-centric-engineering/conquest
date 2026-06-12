'use client';

/**
 * Compact editor for the question(s) a data slot covers.
 *
 * A slot typically maps to a handful of a questionnaire's (often dozens of) questions, so
 * rendering every question as a toggle per slot wastes huge amounts of space. Instead this
 * shows just the applied subset as removable chips plus a "X of N" count, and tucks the full
 * (filterable) question list behind an Edit popover.
 */

import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface QuestionRef {
  key: string;
  prompt: string;
}

export interface QuestionCoverageEditorProps {
  questions: QuestionRef[];
  /** Keys this slot currently covers (may include stale keys not in `questions`). */
  selectedKeys: string[];
  onToggle: (key: string) => void;
}

export function QuestionCoverageEditor({
  questions,
  selectedKeys,
  onToggle,
}: QuestionCoverageEditorProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const promptByKey = new Map(questions.map((q) => [q.key, q.prompt]));
  const selected = new Set(selectedKeys);
  const staleKeys = selectedKeys.filter((k) => !promptByKey.has(k));

  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? questions.filter(
        (q) => q.key.toLowerCase().includes(needle) || q.prompt.toLowerCase().includes(needle)
      )
    : questions;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-muted-foreground text-xs">
          Covers {selectedKeys.length} of {questions.length} question
          {questions.length === 1 ? '' : 's'}
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            <div className="border-b p-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter questions…"
                className="h-8 text-xs"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="text-muted-foreground p-3 text-center text-xs">
                  No matching questions.
                </p>
              ) : (
                filtered.map((q) => {
                  const on = selected.has(q.key);
                  return (
                    <button
                      key={q.key}
                      type="button"
                      onClick={() => onToggle(q.key)}
                      aria-pressed={on}
                      className={cn(
                        'hover:bg-accent flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                        on && 'bg-primary/5'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          on && 'bg-primary border-primary text-primary-foreground'
                        )}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="flex-1">
                        <span className="font-medium">{q.key}</span>
                        <span className="text-muted-foreground"> — {q.prompt}</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {selectedKeys.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          No questions mapped — the respondent flow will ask them directly.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedKeys.map((key) => {
            const stale = !promptByKey.has(key);
            return (
              <span
                key={key}
                title={promptByKey.get(key) ?? 'Not in this version — will be dropped on save'}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
                  stale
                    ? 'text-destructive border-destructive/50 border'
                    : 'bg-primary/10 border border-transparent'
                )}
              >
                {key}
                <button
                  type="button"
                  onClick={() => onToggle(key)}
                  aria-label={`Remove ${key}`}
                  className="hover:text-foreground opacity-70"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {staleKeys.length > 0 && (
        <p className="text-destructive text-xs">
          {staleKeys.length} mapped key{staleKeys.length === 1 ? '' : 's'} aren’t in this version
          and will be dropped on save.
        </p>
      )}
    </div>
  );
}
