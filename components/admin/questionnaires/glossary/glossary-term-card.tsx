'use client';

/**
 * One term in the glossary editor (P16) — the adjudication unit.
 *
 * Two faces, chosen by curation state:
 *
 *  - **Open (a proposal, or an accepted term being edited)** — the working form: term + aliases,
 *    the analyst's rationale/context quote, and the candidate definitions as a multi-select. The
 *    admin ticks the reading(s) that apply, edits any wording, and accepts or rejects.
 *  - **Settled (accepted / rejected)** — the form collapses to a one-glance record: a coloured
 *    status rail down the card's edge, an Accepted / Rejected stamp, the term, and the ticked
 *    readings as a read-only list. Adjudicating twenty terms is a scanning job, and twenty
 *    identical open forms give the eye nothing to scan; the rail + stamp make "what have I
 *    already dealt with?" answerable from the column edge alone.
 *
 * A settled card can always be reopened ("Edit"), and one that cannot be saved as-is — no reading
 * ticked, no surface typed, or a duplicate — is FORCED open, because a collapsed summary would
 * hide the very error the admin has to fix.
 *
 * Multiple ticked definitions are deliberate and never merged: they are the senses this
 * questionnaire genuinely accepts, and they render to the respondent as numbered senses.
 */

import { useState } from 'react';
import { Check, CheckCircle2, Pencil, Plus, Trash2, Undo2, X, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
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

/**
 * The verdict, as a stamp rather than a caption: filled tint, hairline ring, uppercase micro-type.
 * Colour carries the meaning, so the icon and the word carry it again for anyone who can't use it.
 */
function StatusStamp({ status }: { status: 'accepted' | 'rejected' }) {
  const accepted = status === 'accepted';
  const Icon = accepted ? CheckCircle2 : XCircle;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wider uppercase ring-1',
        accepted
          ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-600/30 dark:text-emerald-300 dark:ring-emerald-400/30'
          : 'bg-destructive/10 text-destructive ring-destructive/30'
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {accepted ? 'Accepted' : 'Rejected'}
    </span>
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

  const selectedDefinitions = term.definitions.filter(
    (definition) => definition.selected && definition.text.trim().length > 0
  );
  const acceptedWithNothingSelected =
    term.status === 'accepted' && selectedDefinitions.length === 0;
  const isProposed = term.status === 'proposed';
  const isAccepted = term.status === 'accepted';
  const isRejected = term.status === 'rejected';

  /**
   * A hand-added term arrives `accepted` and blank, so it opens on its own; everything settled
   * opens only on request. Proposals are never collapsed — adjudicating them IS the open form.
   */
  const [expanded, setExpanded] = useState(() => term.term.trim().length === 0);
  const blocked = acceptedWithNothingSelected || term.term.trim().length === 0;
  const open = isProposed || expanded || blocked || duplicateOf !== null;

  const accept = () => {
    patch({ status: 'accepted' });
    // Collapse on the verdict: the point of accepting is that the term stops needing attention.
    setExpanded(false);
  };
  const reject = () => {
    patch({ status: 'rejected' });
    setExpanded(false);
  };
  // A term rejected before anything was ticked comes back unusable; `blocked` reopens it on its
  // own, so restoring only has to change the verdict.
  const restore = () => patch({ status: 'accepted' });

  const deleteButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={`Delete ${term.term || 'term'}`}
      onClick={onRemove}
    >
      <Trash2 className="text-destructive h-3.5 w-3.5" />
    </Button>
  );

  return (
    <div
      // The status rail: a 3px coloured edge that turns a column of cards into something scannable.
      className={cn(
        'rounded-lg border border-l-[3px] transition-colors',
        open ? 'p-4' : 'px-4 py-3',
        isAccepted && 'border-l-emerald-500 bg-emerald-500/[0.04] dark:bg-emerald-400/[0.05]',
        isRejected && 'border-l-destructive/60 bg-muted/40 opacity-75',
        isProposed && 'bg-card border-l-amber-400/80'
      )}
      data-testid="glossary-term-card"
      data-status={term.status}
    >
      {!open ? (
        /* Settled record — the verdict, the term, and what it now means. No form. */
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusStamp status={isAccepted ? 'accepted' : 'rejected'} />
              <span
                className={cn(
                  'text-sm font-semibold',
                  isRejected && 'text-muted-foreground line-through'
                )}
              >
                {term.term}
              </span>
              {term.aliases.length > 0 && (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  also {term.aliases.join(', ')}
                </span>
              )}
            </div>

            {isAccepted &&
              (selectedDefinitions.length === 1 ? (
                <p className="text-muted-foreground text-sm">{selectedDefinitions[0].text}</p>
              ) : (
                /* Several ticked readings are senses, not alternatives — numbered here exactly as
                   the respondent will see them. */
                <ol className="text-muted-foreground list-inside list-decimal space-y-0.5 text-sm">
                  {selectedDefinitions.map((definition) => (
                    <li key={definition.id}>{definition.text}</li>
                  ))}
                </ol>
              ))}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isAccepted && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpanded(true)}
                  aria-label={`Edit ${term.term || 'term'}`}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={reject}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  Reject
                </Button>
              </>
            )}
            {isRejected && (
              <Button type="button" size="sm" variant="ghost" onClick={restore}>
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                Restore
              </Button>
            )}
            {deleteButton}
          </div>
        </div>
      ) : (
        <>
          {/* An accepted term being edited keeps its stamp, so the verdict never goes missing
              while the form is open. */}
          {isAccepted && (
            <div className="mb-3 flex items-center gap-2">
              <StatusStamp status="accepted" />
              {acceptedWithNothingSelected && (
                <span className="text-destructive text-xs">
                  Tick a reading below to keep this in use
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[14rem] flex-1 space-y-1">
              <Label htmlFor={`${term.id}-term`}>
                Term{' '}
                <FieldHelp title="Term">
                  The word or phrase as it appears in your questions. Matching ignores case and
                  treats hyphens as spaces, so a hyphenated spelling and a spaced one are the same
                  term. Add other spellings, acronyms, or irregular plurals as aliases.
                </FieldHelp>
              </Label>
              <Input
                id={`${term.id}-term`}
                value={term.term}
                placeholder="The term as it appears in your questions"
                onChange={(event) => patch({ term: event.target.value })}
              />
            </div>

            <div className="min-w-[14rem] flex-1 space-y-1">
              <Label htmlFor={`${term.id}-aliases`}>
                Aliases{' '}
                <FieldHelp title="Aliases">
                  Comma-separated alternative surfaces that mean the same thing — other spellings,
                  acronyms, or irregular plurals. Regular plurals and possessives (adding “s” or
                  “’s”) are handled automatically, so you only need aliases for the ones a simple
                  “add an s” wouldn’t produce. Default: none.
                </FieldHelp>
              </Label>
              <Input
                id={`${term.id}-aliases`}
                value={term.aliases.join(', ')}
                placeholder="Comma-separated alternative spellings or acronyms"
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
              {isProposed && (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={accept}>
                    <Check className="mr-1 h-3.5 w-3.5" />
                    Accept
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={reject}>
                    <X className="mr-1 h-3.5 w-3.5" />
                    Reject
                  </Button>
                </>
              )}
              {isAccepted && (
                <>
                  {/* Only offered once the card is actually saveable — "Done" on a term with no
                      reading ticked would collapse it straight back open. */}
                  {!blocked && duplicateOf === null && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setExpanded(false)}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      Done
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={reject}>
                    <X className="mr-1 h-3.5 w-3.5" />
                    Reject
                  </Button>
                </>
              )}
              {isRejected && (
                <Button type="button" size="sm" variant="ghost" onClick={restore}>
                  <Undo2 className="mr-1 h-3.5 w-3.5" />
                  Restore
                </Button>
              )}
              {deleteButton}
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
                    Tick every reading this questionnaire actually accepts. One ticked definition
                    means one settled meaning. More than one is a deliberate statement that the term
                    carries several senses here — they are shown to respondents as numbered senses
                    and never merged. Untick a suggestion to keep it on file without using it.
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
        </>
      )}
    </div>
  );
}
