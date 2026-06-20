'use client';

/**
 * Create / edit form for a cohort (a group of people under a demo client).
 *
 * One component, two modes — mirrors `<DemoClientForm>`: `react-hook-form` + Zod
 * (`mode: 'onTouched'`), `apiClient` for the submit, `<FormError>` per field,
 * `<FieldHelp>` ⓘ on the non-obvious fields. The `demoClientId` is supplied by the
 * route (create mode); a duplicate name collision surfaces as a banner.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS` at the page boundary.
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
import { cohortDetailHref, type CohortDetail } from '@/lib/app/questionnaire/rounds';

// Local form schema: the domain `createCohortSchema` carries `demoClientId` (route-supplied)
// and treats `description` as nullable; the form keeps every field string-defaulted so
// react-hook-form stays controlled, and folds empty → null at submit time.
const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(1000),
});

type FormValues = z.infer<typeof formSchema>;

export interface CohortFormProps {
  /** The demo client this cohort belongs to (drives the redirect + create body). */
  demoClientId: string;
  /** Present in edit mode; absent in create mode. */
  cohort?: CohortDetail;
  /** Called after a successful create/edit (e.g. to close a dialog). */
  onSuccess?: () => void;
  /** Called when the user cancels. */
  onCancel?: () => void;
}

export function CohortForm({ demoClientId, cohort, onSuccess, onCancel }: CohortFormProps) {
  const router = useRouter();
  const isEdit = cohort !== undefined;
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
      name: cohort?.name ?? '',
      description: cohort?.description ?? '',
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      const description = values.description.trim() === '' ? null : values.description.trim();
      if (isEdit) {
        await apiClient.patch<CohortDetail>(API.APP.COHORTS.byId(cohort.id), {
          body: { name: values.name, description },
        });
      } else {
        const created = await apiClient.post<CohortDetail>(API.APP.COHORTS.ROOT, {
          body: { demoClientId, name: values.name, description },
        });
        router.push(cohortDetailHref(demoClientId, created.id));
      }
      router.refresh();
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong saving the cohort.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="cohort-name" className="flex items-center gap-1">
          Name
          <FieldHelp title="Cohort name">
            A short label for this group of people, e.g.{' '}
            <code className="text-xs">Acme leadership team</code>. Shown in the admin and used as
            the default round-name prefix.
          </FieldHelp>
        </Label>
        <Input
          id="cohort-name"
          placeholder="Acme leadership team"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cohort-description" className="flex items-center gap-1">
          Description
          <FieldHelp title="Internal note">
            A private admin note about this cohort (e.g. who they are, why they were grouped). Never
            shown to respondents.
          </FieldHelp>
        </Label>
        <Textarea
          id="cohort-description"
          placeholder="Internal note (optional)"
          rows={3}
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
          {isEdit ? 'Save changes' : 'Create cohort'}
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
