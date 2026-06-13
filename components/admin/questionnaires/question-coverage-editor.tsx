'use client';

/**
 * Compact editor for the question(s) a data slot covers.
 *
 * A slot typically maps to a handful of a questionnaire's (often dozens of) questions, so
 * rendering every question as a toggle per slot wastes huge amounts of space. Instead this
 * shows just the applied subset as removable chips plus a "X of N" count, and tucks the full
 * (filterable) question list behind an Edit popover. A read-only "View questions" popover
 * surfaces the full prompt text of the covered questions for a quick glance without editing.
 */

import { useState } from 'react';
import { Check, Eye, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
  const [viewOpen, setViewOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // The key whose removal is awaiting confirmation. Removing coverage is deliberately
  // friction-ed (an "are you sure"): unmapping a question risks it never being targeted.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

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
        <Label className="text-muted-foreground flex items-center gap-1 text-xs">
          Covered question keys ({selectedKeys.length} of {questions.length})
          <FieldHelp title="Question key">
            A <strong>question key</strong> is the short, stable identifier (a slug like{' '}
            <code>sales_model_definition</code>) for one question in this questionnaire. Each chip
            below is the key of a question this data slot is responsible for capturing in the
            conversation — filling the slot well answers those questions in the background. Removing
            a key here only unmaps that question from this slot; it does not delete the question. If
            no slot covers a question, the respondent flow asks it directly instead.
          </FieldHelp>
        </Label>
        {selectedKeys.length > 0 && (
          <Popover open={viewOpen} onOpenChange={setViewOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                <Eye className="mr-1 h-3 w-3" /> View questions
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 p-0">
              <div className="border-b px-3 py-2">
                <p className="text-xs font-medium">Raw questions this slot covers</p>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto p-3">
                {selectedKeys.map((key) => {
                  const prompt = promptByKey.get(key);
                  return (
                    <div key={key} className="text-xs">
                      <p className="font-mono font-medium">{key}</p>
                      {prompt ? (
                        <p className="text-muted-foreground">{prompt}</p>
                      ) : (
                        <p className="text-destructive italic">
                          Not in this version — will be dropped on save.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        )}
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
                        <span className="font-mono font-medium">{q.key}</span>
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
          No question keys mapped — the respondent flow will ask these questions directly.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedKeys.map((key) => {
            const stale = !promptByKey.has(key);
            const prompt = promptByKey.get(key);
            return (
              <span
                key={key}
                title={
                  prompt ? `${key} — ${prompt}` : 'Not in this version — will be dropped on save'
                }
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs',
                  stale
                    ? 'text-destructive border-destructive/50 border'
                    : 'bg-primary/10 border border-transparent'
                )}
              >
                {key}
                <button
                  type="button"
                  onClick={() => setPendingRemove(key)}
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

      {/* Removing coverage is risky — confirm before unmapping a question from this slot. */}
      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(next) => !next && setPendingRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this question key?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove && (
                <>
                  Removing <code className="font-mono">{pendingRemove}</code>
                  {promptByKey.get(pendingRemove)
                    ? ` (“${promptByKey.get(pendingRemove)}”)`
                    : ''}{' '}
                  unmaps it from this data slot. Unless another slot covers it, this question may no
                  longer be targeted naturally in the conversation — it risks going unanswered.
                  Removing a key is usually inadvisable.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemove) onToggle(pendingRemove);
                setPendingRemove(null);
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Remove anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
