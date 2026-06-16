'use client';

/**
 * Rename control for a questionnaire (Settings tab).
 *
 * Renames the questionnaire via `PATCH /api/v1/app/questionnaires/:id` with a
 * `{ title }` body — the questionnaire-level title, not a version's structure. The
 * title is validated client-side against the same {@link questionnaireTitleSchema}
 * the route enforces, so the form gives instant feedback; the server is still the
 * authority. On success the page is refreshed so the header and list pick up the
 * new name.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  MAX_QUESTIONNAIRE_TITLE_LENGTH,
  questionnaireTitleSchema,
} from '@/lib/app/questionnaire/title';

export interface RenameQuestionnaireProps {
  questionnaireId: string;
  /** The questionnaire's current title — the form's starting value. */
  currentTitle: string;
}

export function RenameQuestionnaire({ questionnaireId, currentTitle }: RenameQuestionnaireProps) {
  const router = useRouter();
  const [value, setValue] = useState(currentTitle);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = questionnaireTitleSchema.safeParse(value);
  const trimmed = parsed.success ? parsed.data : value.trim();
  const isUnchanged = trimmed === currentTitle;
  const canSave = parsed.success && !isUnchanged && !isSaving;

  const handleSave = async () => {
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid name.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.byId(questionnaireId), {
        body: { title: parsed.data },
      });
      // Normalise the field to the saved (trimmed) value so the button disables.
      setValue(parsed.data);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not rename the questionnaire.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="questionnaire-name" className="flex items-center gap-1">
        Name
        <FieldHelp title="Questionnaire name">
          The questionnaire&rsquo;s display name — shown in the admin list, this workspace header,
          and respondent surfaces. Renaming does not change its structure or any version.
        </FieldHelp>
        {isSaving && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
      </Label>
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <Input
            id="questionnaire-name"
            value={value}
            maxLength={MAX_QUESTIONNAIRE_TITLE_LENGTH}
            disabled={isSaving}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) {
                e.preventDefault();
                void handleSave();
              }
            }}
            aria-invalid={error ? true : undefined}
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
