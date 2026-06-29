'use client';

/**
 * Inline-editable questionnaire title for the workspace header.
 *
 * Renders the title as a heading with a hover/focus-revealed pencil affordance.
 * Clicking it (or the heading) swaps to an input; Enter or the check saves,
 * Escape or the cross cancels. Saving renames the questionnaire via
 * `PATCH /api/v1/app/questionnaires/:id` with a `{ title }` body — the
 * questionnaire-level name, not a version's structure — using the same
 * {@link questionnaireTitleSchema} the route enforces, so feedback is instant
 * while the server stays the authority. On success the page refreshes so the
 * header, breadcrumb, and list pick up the new name.
 *
 * Shares the rename contract with {@link RenameQuestionnaire} on the Settings
 * tab; this is the in-place affordance for the header that every tab shares.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Pencil, X } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  MAX_QUESTIONNAIRE_TITLE_LENGTH,
  questionnaireTitleSchema,
} from '@/lib/app/questionnaire/title';

export interface EditableTitleProps {
  questionnaireId: string;
  /** The questionnaire's current title — the starting value when editing. */
  title: string;
}

export function EditableTitle({ questionnaireId, title }: EditableTitleProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the field in sync if the title changes underneath us (e.g. a refresh
  // after saving, or a rename on the Settings tab) while not actively editing.
  useEffect(() => {
    if (!isEditing) setValue(title);
  }, [title, isEditing]);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const parsed = questionnaireTitleSchema.safeParse(value);

  const startEditing = () => {
    setValue(title);
    setError(null);
    setIsEditing(true);
  };

  const cancel = () => {
    setIsEditing(false);
    setValue(title);
    setError(null);
  };

  const save = async () => {
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid name.');
      return;
    }
    if (parsed.data === title) {
      cancel();
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.byId(questionnaireId), {
        body: { title: parsed.data },
      });
      setValue(parsed.data);
      setIsEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not rename the questionnaire.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="group flex items-center gap-2 text-left"
        aria-label="Edit questionnaire name"
      >
        <h1 className="text-2xl font-semibold">{title}</h1>
        <Pencil
          className="text-muted-foreground h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={value}
          maxLength={MAX_QUESTIONNAIRE_TITLE_LENGTH}
          disabled={isSaving}
          className="h-9 w-72 text-lg font-semibold"
          aria-label="Questionnaire name"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={isSaving || !parsed.success}
          onClick={() => void save()}
          aria-label="Save name"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={isSaving}
          onClick={cancel}
          aria-label="Cancel rename"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
