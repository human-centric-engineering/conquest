'use client';

/**
 * "Suggest openers" — the AI half of the opening-questions decision support.
 *
 * Reads this questionnaire's subject, goal, audience and coverage and proposes a few example
 * opening questions, each with a reason the admin can weigh.
 *
 * **Propose-then-accept, never apply.** Suggestions land in this dialog and reach the editor only
 * when the admin adds one. There is no "add all": the opening is the first thing a real respondent
 * is ever asked, so an opener nobody read is exactly what this feature exists to prevent. Every
 * proposal shows its reasoning, so the choice is informed rather than a rubber stamp.
 *
 * @see lib/app/questionnaire/opening-examples/suggest.ts — the analysis behind the proposals
 */

import { useState } from 'react';
import { Check, Plus, RefreshCw, Sparkles } from 'lucide-react';

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

/** One proposal as the route returns it. `why` is guidance for the admin, never stored. */
export interface OpeningExampleSuggestionView {
  text: string;
  why: string;
}

export function OpeningExamplesSuggest({
  questionnaireId,
  versionId,
  addedTexts,
  onAdd,
  disabled,
  atCap,
}: {
  questionnaireId: string;
  versionId: string;
  /** Example texts already in the list — so an added proposal shows as added. */
  addedTexts: ReadonlySet<string>;
  onAdd: (text: string) => void;
  disabled?: boolean;
  /** The list is full — proposals are still readable, but nothing more can be added. */
  atCap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<OpeningExampleSuggestionView[] | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiClient.post<{ suggestions: OpeningExampleSuggestionView[] }>(
        API.APP.QUESTIONNAIRES.openingExamplesSuggest(questionnaireId, versionId)
      );
      setSuggestions(data.suggestions);
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not suggest opening questions. Please try again.'
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
        <Sparkles className="mr-1 h-3.5 w-3.5" /> Suggest openers
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Suggested opening questions</DialogTitle>
            <DialogDescription>
              Based on this questionnaire&rsquo;s subject, goal and audience. Add the ones you want
              and edit them to fit — the interviewer is guided by them, and writes its own opener in
              the same spirit rather than reading yours out.
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
              Nothing to suggest for this questionnaire — the openers you have already cover it, or
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
                      key={`${index}-${suggestion.text}`}
                      className="bg-card flex items-start gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <p className="text-sm leading-relaxed">{suggestion.text}</p>
                        {suggestion.why && (
                          // Equal billing with the opener itself — the admin is choosing, not the model.
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
                        onClick={() => onAdd(suggestion.text)}
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
