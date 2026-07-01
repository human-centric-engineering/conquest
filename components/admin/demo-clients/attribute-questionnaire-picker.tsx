'use client';

/**
 * DEMO-ONLY (F2.5.1): reverse attribution — pick an available questionnaire and brand it as THIS
 * demo client, right from the client's detail page (the complement of the per-questionnaire Settings
 * picker `DemoClientAssign`). Options are the *generic* (unattributed) questionnaires, resolved
 * server-side; reassigning one already branded as another client stays in that client's row menu.
 *
 * Reuses the same endpoint as every other attribution control: `PATCH /api/v1/app/questionnaires/:id
 * { demoClientId }`. On success it `router.refresh()`es so the attributed list, count, and delete
 * guard re-read. A fork strips demo tenancy.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';

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
import type { AttributedQuestionnaireRow } from '@/lib/app/questionnaire/demo-clients';

export interface AttributeQuestionnairePickerProps {
  /** The demo client to attribute the chosen questionnaire to. */
  clientId: string;
  /** Generic (unattributed) questionnaires available to attribute. */
  options: AttributedQuestionnaireRow[];
}

export function AttributeQuestionnairePicker({
  clientId,
  options,
}: AttributeQuestionnairePickerProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (options.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No unattributed questionnaires are available — every questionnaire is already branded as a
        client, or none exist yet.
      </p>
    );
  }

  const attribute = async () => {
    if (!selected) return;
    setIsSaving(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.byId(selected), {
        body: { demoClientId: clientId },
      });
      setSelected('');
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not attribute the questionnaire.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Select value={selected} onValueChange={setSelected} disabled={isSaving}>
          <SelectTrigger className="w-72" aria-label="Questionnaire to attribute">
            <SelectValue placeholder="Choose a questionnaire to attribute…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((q) => (
              <SelectItem key={q.id} value={q.id}>
                {q.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" onClick={() => void attribute()} disabled={!selected || isSaving}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Attribute
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
