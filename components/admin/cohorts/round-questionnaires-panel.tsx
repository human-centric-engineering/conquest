'use client';

/**
 * The questionnaires bundled into a round, with attach (a simple id/title picker that
 * POSTs `{ questionnaireId }`) and per-row detach (DELETE). Both use the per-row
 * pending-state pattern and refresh on success so the SSR list + headline count re-read.
 *
 * The attachable list is the client's questionnaires, fetched server-side and passed in
 * (no per-row fetch). Already-attached ones are filtered out of the picker.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Loader2, Unlink } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import type { RoundDetail, RoundQuestionnaireView } from '@/lib/app/questionnaire/rounds';

/** Minimal shape for the attach picker — just enough to choose a questionnaire. */
export interface AttachableQuestionnaire {
  id: string;
  title: string;
}

export interface RoundQuestionnairesPanelProps {
  roundId: string;
  /** The questionnaires currently bundled into this round. */
  questionnaires: RoundQuestionnaireView[];
  /** Every questionnaire the admin could attach (the client's list). */
  attachable: AttachableQuestionnaire[];
}

export function RoundQuestionnairesPanel({
  roundId,
  questionnaires,
  attachable,
}: RoundQuestionnairesPanelProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState('');
  const [isAttaching, setIsAttaching] = useState(false);
  // Item id of the row currently detaching (drives the spinner).
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hide already-attached questionnaires from the picker.
  const options = useMemo(() => {
    const attached = new Set(questionnaires.map((q) => q.questionnaireId));
    return attachable.filter((q) => !attached.has(q.id));
  }, [attachable, questionnaires]);

  const attach = async () => {
    if (selectedId === '') return;
    setIsAttaching(true);
    setError(null);
    try {
      await apiClient.post<RoundDetail>(API.APP.ROUNDS.questionnaires(roundId), {
        body: { questionnaireId: selectedId },
      });
      setSelectedId('');
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not attach the questionnaire.');
    } finally {
      setIsAttaching(false);
    }
  };

  const detach = async (itemId: string) => {
    setPendingItemId(itemId);
    setError(null);
    try {
      await apiClient.delete<RoundDetail>(API.APP.ROUNDS.questionnaire(roundId, itemId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not detach the questionnaire.');
    } finally {
      setPendingItemId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            Attach a questionnaire
            <FieldHelp title="Bundled questionnaires">
              The questionnaires this round delivers to the cohort. Attach one or more; each member
              completes every bundled questionnaire. The picker lists this client&rsquo;s
              questionnaires that aren&rsquo;t already attached.
            </FieldHelp>
          </div>
          <Select value={selectedId} onValueChange={setSelectedId} disabled={options.length === 0}>
            <SelectTrigger className="w-[20rem]" aria-label="Questionnaire to attach">
              <SelectValue
                placeholder={
                  options.length === 0
                    ? 'No more questionnaires to attach'
                    : 'Choose a questionnaire…'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => void attach()} disabled={selectedId === '' || isAttaching}>
          {isAttaching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="mr-2 h-4 w-4" />
          )}
          Attach
        </Button>
      </div>

      <ul className="divide-y rounded-md border">
        {questionnaires.length === 0 ? (
          <li className="text-muted-foreground px-4 py-6 text-center text-sm">
            No questionnaires bundled yet. Attach one above to deliver it in this round.
          </li>
        ) : (
          questionnaires.map((q) => {
            const isPending = pendingItemId === q.itemId;
            return (
              <li key={q.itemId} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{q.title}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive shrink-0"
                  disabled={isPending}
                  onClick={() => void detach(q.itemId)}
                >
                  {isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Unlink className="mr-2 h-4 w-4" />
                  )}
                  Detach
                </Button>
              </li>
            );
          })
        )}
      </ul>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
