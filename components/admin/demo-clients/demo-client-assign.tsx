'use client';

/**
 * DEMO-ONLY (F2.5.1): attribution control on a questionnaire.
 *
 * Assigns the questionnaire to a demo client (or detaches with "None") via
 * `PATCH /api/v1/app/questionnaires/:id`. Options are the *active* demo clients,
 * resolved server-side and passed in; the currently-attributed client is always
 * shown even if it has since been deactivated, so attribution never silently
 * disappears from the picker. A fork strips demo tenancy.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

const NONE = '__none__';

export interface DemoClientAssignProps {
  questionnaireId: string;
  current: AttributedDemoClient | null;
  /** Active demo clients available to attribute (id, slug, name). */
  options: AttributedDemoClient[];
}

export function DemoClientAssign({ questionnaireId, current, options }: DemoClientAssignProps) {
  const router = useRouter();
  const [value, setValue] = useState(current?.id ?? NONE);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The attributed client may be inactive (so absent from `options`) — include it
  // so the current selection renders rather than showing a blank trigger.
  const merged =
    current && !options.some((o) => o.id === current.id) ? [current, ...options] : options;

  const handleChange = async (next: string) => {
    const previous = value;
    setValue(next);
    setIsSaving(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.byId(questionnaireId), {
        body: { demoClientId: next === NONE ? null : next },
      });
      router.refresh();
    } catch (err) {
      setValue(previous); // revert the optimistic selection
      setError(err instanceof APIClientError ? err.message : 'Could not update attribution.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="demo-client" className="flex items-center gap-1">
        Demo client
        <FieldHelp title="Demo-client attribution">
          Attribute this questionnaire to a prospect so the sales surface is theirs.
          &ldquo;None&rdquo; is a generic Sunrise demo. Branding for the attributed client lands in
          a later phase.
        </FieldHelp>
        {isSaving && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
      </Label>
      <Select value={value} onValueChange={(v) => void handleChange(v)} disabled={isSaving}>
        <SelectTrigger id="demo-client" className="w-72">
          <SelectValue placeholder="None (generic demo)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None (generic demo)</SelectItem>
          {merged.map((client) => (
            <SelectItem key={client.id} value={client.id}>
              {client.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
