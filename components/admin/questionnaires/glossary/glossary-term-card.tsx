'use client';

/**
 * One term in the glossary editor (P16) — the adjudication unit.
 *
 * Renders the term's surface + aliases, the analyst's rationale/context quote when it proposed the
 * term, and its candidate definitions as a multi-select. The admin ticks the reading(s) that
 * apply, edits any wording, and accepts or rejects the term.
 *
 * Multiple ticked definitions are deliberate and never merged: they are the senses this
 * questionnaire genuinely accepts, and they render to the respondent as numbered senses.
 */

import { Check, Plus, Trash2, Undo2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { FieldHelp } from '@/components/ui/field-help';
import { GLOSSARY_MAX_DEFINITIONS_PER_TERM } from '@/lib/app/questionnaire/glossary';
import {
  clientId,
  type DraftDefinition,
  type DraftTerm,
} from '@/components/admin/questionnaires/glossary/glossary-types';

export interface GlossaryTermCardProps {
  term: DraftTerm;
  /** Duplicate-surface warning from the container, shown inline so Save isn't the first hint. */
  duplicateOf: string | null;
  onChange: (next: DraftTerm) => void;
  onRemove: () => void;
}

/** Where a definition's wording came from — the admin's "can I trust this?" signal. */
function DefinitionSourceBadge({ definition }: { definition: DraftDefinition }) {
  if (definition.source === 'document') {
    return (
      <Badge variant="secondary" className="shrink-0">
        From your document
      </Badge>
    );
  }
  if (definition.source === 'admin') {
    return (
      <Badge variant="outline" className="shrink-0">
        Yours
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      AI {definition.edited ? '· edited' : 'suggested'}
    </Badge>
  );
}

export function GlossaryTermCard({ term, duplicateOf, onChange, onRemove }: GlossaryTermCardProps) {
  const patch = (changes: Partial<DraftTerm>) => onChange({ ...term, ...changes });

  const patchDefinition = (id: string, changes: Partial<DraftDefinition>) =>
    patch({
      definitions: term.definitions.map((definition) =>
        definition.id === id ? { ...definition, ...changes } : definition
      ),
    });

  /**
   * Editing an AI-suggested wording stamps `edited` so a later analyst re-run leaves it alone.
   * The stamp is one-way: reverting the text by hand doesn't un-edit it, because we can't know
   * the admin meant to restore the original rather than coincidentally retype it.
   */
  const editDefinitionText = (definition: DraftDefinition, text: string) =>
    patchDefinition(definition.id, {
      text,
      ...(definition.source === 'ai_proposed' && !definition.edited ? { edited: true } : {}),
    });

  const addDefinition = () =>
    patch({
      definitions: [
        ...term.definitions,
        {
          id: clientId('def'),
          text: '',
          selected: false,
          source: 'admin',
          sourceQuote: null,
          edited: false,
        },
      ],
    });

  const removeDefinition = (id: string) =>
    patch({ definitions: term.definitions.filter((definition) => definition.id !== id) });

  const selectedCount = term.definitions.filter(
    (definition) => definition.selected && definition.text.trim().length > 0
  ).length;
  const acceptedWithNothingSelected = term.status === 'accepted' && selectedCount === 0;
  const isRejected = term.status === 'rejected';

  return (
    <div
      className={`rounded-lg border p-4 ${isRejected ? 'bg-muted/40 opacity-70' : 'bg-card'}`}
      data-testid="glossary-term-card"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label htmlFor={`${term.id}-term`}>
            Term{' '}
            <FieldHelp title="Term">
              The word or phrase as it appears in your questions. Matching ignores case and treats
              hyphens as spaces, so “higher-self” and “higher self” are the same term. Add other
              spellings, acronyms, or irregular plurals as aliases.
            </FieldHelp>
          </Label>
          <Input
            id={`${term.id}-term`}
            value={term.term}
            placeholder="e.g. higher self"
            onChange={(event) => patch({ term: event.target.value })}
          />
        </div>

        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label htmlFor={`${term.id}-aliases`}>
            Aliases{' '}
            <FieldHelp title="Aliases">
              Comma-separated alternative surfaces that mean the same thing — other spellings,
              acronyms, or irregular plurals. Regular plurals (<code>ego</code> → <code>egos</code>,{' '}
              <code>ego’s</code>) are handled automatically, so you only need aliases for the ones a
              simple “add an s” wouldn’t produce. Default: none.
            </FieldHelp>
          </Label>
          <Input
            id={`${term.id}-aliases`}
            value={term.aliases.join(', ')}
            placeholder="e.g. Higher Self, HS"
            onChange={(event) =>
              patch({
                aliases: event.target.value
                  .split(',')
                  .map((alias) => alias.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 self-end pb-1">
          {term.status === 'proposed' && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => patch({ status: 'accepted' })}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Accept
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => patch({ status: 'rejected' })}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Reject
              </Button>
            </>
          )}
          {term.status === 'accepted' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => patch({ status: 'rejected' })}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
          )}
          {isRejected && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => patch({ status: 'accepted' })}
            >
              <Undo2 className="mr-1 h-3.5 w-3.5" />
              Restore
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Delete ${term.term || 'term'}`}
            onClick={onRemove}
          >
            <Trash2 className="text-destructive h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {duplicateOf !== null && (
        <p className="text-destructive mt-2 text-xs">
          Already defined above as “{duplicateOf}” — matching treats these as the same term.
        </p>
      )}

      {term.rationale && (
        <p className="text-muted-foreground mt-3 text-xs">
          <span className="font-medium">Why this may need defining:</span> {term.rationale}
        </p>
      )}
      {term.contextQuote && (
        <p className="text-muted-foreground border-muted mt-1 border-l-2 pl-2 text-xs italic">
          “{term.contextQuote}”
        </p>
      )}

      {!isRejected && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label>
              Definitions{' '}
              <FieldHelp title="Definitions">
                Tick every reading this questionnaire actually accepts. One ticked definition means
                one settled meaning. More than one is a deliberate statement that the term carries
                several senses here — they are shown to respondents as numbered senses and never
                merged. Untick a suggestion to keep it on file without using it.
              </FieldHelp>
            </Label>
            {acceptedWithNothingSelected && (
              <span className="text-destructive text-xs">Tick at least one to accept</span>
            )}
          </div>

          {term.definitions.map((definition) => (
            <div key={definition.id} className="flex items-start gap-2">
              <Checkbox
                id={`${definition.id}-selected`}
                className="mt-2.5"
                checked={definition.selected}
                aria-label="Use this definition"
                onCheckedChange={(checked) =>
                  patchDefinition(definition.id, { selected: checked === true })
                }
              />
              <div className="flex-1 space-y-1">
                <AutoTextarea
                  value={definition.text}
                  placeholder="What this term means in this questionnaire…"
                  rows={2}
                  onChange={(event) => editDefinitionText(definition, event.target.value)}
                />
                {definition.sourceQuote && (
                  <p className="text-muted-foreground border-muted border-l-2 pl-2 text-xs italic">
                    “{definition.sourceQuote}”
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-2">
                <DefinitionSourceBadge definition={definition} />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Remove definition"
                  onClick={() => removeDefinition(definition.id)}
                >
                  <Trash2 className="text-muted-foreground h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}

          {term.definitions.length < GLOSSARY_MAX_DEFINITIONS_PER_TERM && (
            <Button type="button" size="sm" variant="outline" onClick={addDefinition}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add a definition
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
