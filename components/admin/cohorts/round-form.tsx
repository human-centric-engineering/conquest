'use client';

/**
 * Create / edit form for a round (a time-bound delivery of questionnaires to a cohort).
 *
 * One component, two modes — mirrors `<DemoClientForm>`: `react-hook-form` + Zod
 * (`mode: 'onTouched'`), `apiClient` for the submit, `<FormError>` per field,
 * `<FieldHelp>` ⓘ on the non-obvious fields. On create `name` is optional — left blank
 * the server derives it from the cohort name + window. `opensAt`/`closesAt` are
 * datetime-local inputs converted to ISO (with offset) at submit, and back for defaults.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import { roundDetailHref, type RoundDetail } from '@/lib/app/questionnaire/rounds';

/** ISO string → the `yyyy-MM-ddThh:mm` value a datetime-local input expects (local time). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** A datetime-local value (local wall-clock) → an ISO string with offset, or null if blank. */
function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const formSchema = z
  .object({
    name: z.string().trim().max(120),
    description: z.string().trim().max(1000),
    opensAt: z.string(),
    closesAt: z.string(),
  })
  .refine(
    (b) => {
      if (b.opensAt.trim() === '' || b.closesAt.trim() === '') return true;
      return new Date(b.closesAt).getTime() > new Date(b.opensAt).getTime();
    },
    { message: 'The close date must be after the open date', path: ['closesAt'] }
  );

type FormValues = z.infer<typeof formSchema>;

export interface RoundFormProps {
  /** The demo client (for the post-create redirect). */
  demoClientId: string;
  /** Create mode: the cohort the new round belongs to. */
  cohortId?: string;
  /** Edit mode: the round being edited. */
  round?: RoundDetail;
  /** Called after a successful create/edit (e.g. to close a dialog or collapse a form). */
  onSuccess?: () => void;
  /** Called when the user cancels. */
  onCancel?: () => void;
}

export function RoundForm({ demoClientId, cohortId, round, onSuccess, onCancel }: RoundFormProps) {
  const router = useRouter();
  const isEdit = round !== undefined;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      name: round?.name ?? '',
      description: round?.description ?? '',
      opensAt: isoToLocalInput(round?.opensAt ?? null),
      closesAt: isoToLocalInput(round?.closesAt ?? null),
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      const opensAt = localInputToIso(values.opensAt);
      const closesAt = localInputToIso(values.closesAt);
      const description = values.description.trim() === '' ? null : values.description.trim();
      const name = values.name.trim();

      if (isEdit) {
        // Edit: every field optional. Only send what changed-with-intent; name must be
        // non-empty when present (the schema rejects blank), so omit it when cleared.
        await apiClient.patch<RoundDetail>(API.APP.ROUNDS.byId(round.id), {
          body: {
            ...(name === '' ? {} : { name }),
            description,
            opensAt,
            closesAt,
          },
        });
        router.refresh();
      } else {
        const created = await apiClient.post<RoundDetail>(API.APP.ROUNDS.ROOT, {
          body: {
            cohortId,
            ...(name === '' ? {} : { name }),
            description,
            opensAt,
            closesAt,
          },
        });
        router.push(roundDetailHref(demoClientId, created.id));
        router.refresh();
      }
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong saving the round.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="space-y-5 rounded-md border px-4 py-4"
    >
      <div className="space-y-2">
        <Label htmlFor="round-name" className="flex items-center gap-1">
          Name
          <FieldHelp title="Round name">
            A label for this delivery. Leave blank and it defaults to the cohort name plus the
            window dates (you can rename it later).
          </FieldHelp>
        </Label>
        <Input
          id="round-name"
          placeholder={isEdit ? undefined : 'Defaults to cohort name + dates if left blank'}
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="round-opensAt" className="flex items-center gap-1">
            Opens at
            <FieldHelp title="Opens at">
              When the round becomes available (your local time). Leave blank for no lower bound —
              it opens as soon as its status is set to open.
            </FieldHelp>
          </Label>
          <Input
            id="round-opensAt"
            type="datetime-local"
            disabled={isLoading}
            {...register('opensAt')}
          />
          <FormError message={errors.opensAt?.message} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="round-closesAt" className="flex items-center gap-1">
            Closes at
            <FieldHelp title="Closes at">
              When the round stops accepting responses (your local time). After this, even an open
              round denies access. Leave blank for no upper bound.
            </FieldHelp>
          </Label>
          <Input
            id="round-closesAt"
            type="datetime-local"
            disabled={isLoading}
            {...register('closesAt')}
          />
          <FormError message={errors.closesAt?.message} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="round-description" className="flex items-center gap-1">
          Description
          <FieldHelp title="Internal note">
            A private admin note about this round. Never shown to respondents.
          </FieldHelp>
        </Label>
        <Textarea
          id="round-description"
          placeholder="Internal note (optional)"
          rows={2}
          disabled={isLoading}
          {...register('description')}
        />
        <FormError message={errors.description?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isLoading || (isEdit && !isDirty)}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create round'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={isLoading} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
