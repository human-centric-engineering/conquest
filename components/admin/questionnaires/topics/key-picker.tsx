'use client';

/**
 * Compact membership picker for a topic's question / data-slot **keys**.
 *
 * A version routinely has dozens of questions and a topic holds a handful, so rendering every key
 * as a toggle per topic would drown the page. This shows the applied subset as removable chips plus
 * an "N of M" count, and tucks the full filterable list behind an Edit popover — the same shape as
 * `question-coverage-editor.tsx`, generalised over the two key kinds a topic can hold.
 *
 * **Stale keys are shown, never silently dropped.** A topic naming a question that was since
 * deleted is skipped at runtime and flagged by the launch check; hiding it here would leave the
 * admin unable to see — let alone remove — the thing the checklist is complaining about.
 */

import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** One selectable key, with the text that makes it recognisable and an optional grouping hint. */
export interface KeyOption {
  key: string;
  /** The human text — a question prompt or a data-slot name. */
  text: string;
  /** Section title / theme, shown dimmed beside the text. */
  group?: string;
}

export interface KeyPickerProps {
  label: string;
  options: readonly KeyOption[];
  /** Currently-selected keys. May contain keys absent from `options` (stale). */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Copy for the empty state inside the popover. */
  emptyText?: string;
}

export function KeyPicker({
  label,
  options,
  selected,
  onChange,
  disabled = false,
  emptyText = 'Nothing to pick from.',
}: KeyPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const byKey = new Map(options.map((o) => [o.key, o]));
  const chosen = new Set(selected);

  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? options.filter(
        (o) => o.key.toLowerCase().includes(needle) || o.text.toLowerCase().includes(needle)
      )
    : options;

  const toggle = (key: string) => {
    onChange(chosen.has(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-muted-foreground text-xs">
          {label} ({selected.length} of {options.length})
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={disabled}>
              <Pencil className="mr-1 h-3 w-3" aria-hidden="true" /> Edit
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            <div className="border-b p-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="h-8 text-xs"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="text-muted-foreground p-3 text-center text-xs">
                  {options.length === 0 ? emptyText : 'No matches.'}
                </p>
              ) : (
                filtered.map((option) => {
                  const on = chosen.has(option.key);
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => toggle(option.key)}
                      className={cn(
                        'hover:bg-muted flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs',
                        on && 'bg-muted/60'
                      )}
                    >
                      <Check
                        className={cn('mt-0.5 h-3 w-3 shrink-0', on ? 'opacity-100' : 'opacity-0')}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono font-medium">{option.key}</span>
                        <span className="text-muted-foreground block">{option.text}</span>
                        {option.group && (
                          <span className="text-muted-foreground/70 block italic">
                            {option.group}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {selected.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">None yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {selected.map((key) => {
            const option = byKey.get(key);
            return (
              <span
                key={key}
                title={option?.text ?? 'Not in this version'}
                className={cn(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]',
                  option
                    ? 'bg-muted/50'
                    : 'border-destructive/40 bg-destructive/10 text-destructive'
                )}
              >
                {key}
                {!option && <span className="not-italic">· missing</span>}
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  disabled={disabled}
                  aria-label={`Remove ${key}`}
                  className="hover:text-foreground opacity-60"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
