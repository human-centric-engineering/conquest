'use client';

/**
 * "Suggest rules" — the AI half of the house-rules decision support.
 *
 * The starter library answers "what kinds of rule exist"; this answers "what would *this*
 * questionnaire want", by reading its goal, audience, questions and defined terms.
 *
 * **Propose-then-accept, never apply.** Suggestions land in this dialog and reach the editor only
 * when the admin adds one. There is no "add all": a rule the admin never read is precisely what this
 * feature exists to prevent, and every proposal shows its reasoning so the decision is informed
 * rather than a rubber stamp.
 *
 * @see lib/app/questionnaire/house-rules/suggest.ts — the analysis behind the proposals
 */

import { useState } from 'react';
import { Check, Plus, RefreshCw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { HOUSE_RULE_KIND_LABELS, type HouseRuleKind } from '@/lib/app/questionnaire/types';

/** One proposal as the route returns it. `why` is guidance for the admin, never stored on the rule. */
export interface HouseRuleSuggestionView {
  kind: HouseRuleKind;
  text: string;
  trigger?: string;
  why: string;
}

/** Kind chip colours — shared with the panel and library so the three read as one system. */
const KIND_ACCENT: Record<HouseRuleKind, string> = {
  always: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  never: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  if_asked: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export function HouseRulesSuggest({
  questionnaireId,
  versionId,
  addedTexts,
  onAdd,
  disabled,
  atCap,
}: {
  questionnaireId: string;
  versionId: string;
  /** Rule texts already in the list — so an added proposal shows as added. */
  addedTexts: ReadonlySet<string>;
  onAdd: (suggestion: HouseRuleSuggestionView) => void;
  disabled?: boolean;
  /** The rule list is full — proposals are still readable, but nothing more can be added. */
  atCap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<HouseRuleSuggestionView[] | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiClient.post<{ suggestions: HouseRuleSuggestionView[] }>(
        API.APP.QUESTIONNAIRES.houseRulesSuggest(questionnaireId, versionId)
      );
      setSuggestions(data.suggestions);
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not suggest rules. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    setOpen(true);
    // Only fetch the first time — reopening shows what it already proposed rather than silently
    // spending again on a call the admin didn't ask to repeat. "Suggest again" is explicit.
    if (suggestions === null && !busy) void run();
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={start}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> Suggest rules
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Suggested rules</DialogTitle>
            <DialogDescription>
              Based on this questionnaire&rsquo;s goal, audience and questions. Add the ones you
              want and edit them to fit — nothing is applied until you do.
            </DialogDescription>
          </DialogHeader>

          {busy && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              Reading the questionnaire…
            </p>
          )}

          {error && !busy && (
            <div className="space-y-3 py-6 text-center">
              <p className="text-destructive text-sm">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void run()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again
              </Button>
            </div>
          )}

          {!busy && !error && suggestions?.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              Nothing to suggest for this questionnaire — the rules you have already cover it, or
              there isn&rsquo;t enough in the questionnaire yet to go on.
            </p>
          )}

          {!busy && !error && suggestions && suggestions.length > 0 && (
            <>
              <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
                {suggestions.map((suggestion, index) => {
                  const added = addedTexts.has(suggestion.text);
                  return (
                    <div
                      key={`${suggestion.kind}-${index}`}
                      className="bg-card flex items-start gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={cn('text-[10px] font-medium', KIND_ACCENT[suggestion.kind])}
                          >
                            {HOUSE_RULE_KIND_LABELS[suggestion.kind]}
                          </Badge>
                          {suggestion.trigger && (
                            <span className="text-muted-foreground text-xs">
                              when they ask about {suggestion.trigger}
                            </span>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed">{suggestion.text}</p>
                        {suggestion.why && (
                          // Equal billing with the rule itself — the admin is deciding, not the model.
                          <p className="text-muted-foreground text-xs leading-relaxed">
                            {suggestion.why}
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={added ? 'ghost' : 'outline'}
                        className="shrink-0"
                        disabled={disabled || added || atCap}
                        onClick={() => onAdd(suggestion)}
                      >
                        {added ? (
                          <>
                            <Check className="mr-1 h-3.5 w-3.5" /> Added
                          </>
                        ) : (
                          <>
                            <Plus className="mr-1 h-3.5 w-3.5" /> Add
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-end pt-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => void run()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> Suggest again
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
