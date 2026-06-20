'use client';

/**
 * Add-a-member form for a cohort's roster — mirrors `<DemoClientForm>` conventions:
 * `react-hook-form` + Zod (`mode: 'onTouched'`), `apiClient` for the submit,
 * `<FormError>` per field, `<FieldHelp>` ⓘ on the non-obvious fields. A duplicate
 * email (the DB `@@unique([cohortId, email])`) surfaces as a 409 banner.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, UserPlus } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import type { CohortMemberView } from '@/lib/app/questionnaire/rounds';

// Local form schema — `apiClient` post body matches `createCohortMemberSchema`; the form keeps
// `notes` string-defaulted (controlled) and folds empty → null at submit time.
const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().email('A valid email is required').max(254),
  notes: z.string().trim().max(1000),
});

type FormValues = z.infer<typeof formSchema>;

export interface CohortMemberFormProps {
  cohortId: string;
}

export function CohortMemberForm({ cohortId }: CohortMemberFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', notes: '' },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      await apiClient.post<CohortMemberView>(API.APP.COHORTS.members(cohortId), {
        body: {
          name: values.name,
          email: values.email,
          notes: values.notes.trim() === '' ? null : values.notes.trim(),
        },
      });
      reset();
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong adding the member.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="grid gap-3 rounded-md border px-4 py-4 sm:grid-cols-2"
    >
      <div className="space-y-2">
        <Label htmlFor="member-name" className="flex items-center gap-1">
          Name
          <FieldHelp title="Member name">
            How this person is shown on the roster and (optionally) addressed in their invitation.
          </FieldHelp>
        </Label>
        <Input id="member-name" placeholder="Jane Doe" disabled={isLoading} {...register('name')} />
        <FormError message={errors.name?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="member-email" className="flex items-center gap-1">
          Email
          <FieldHelp title="Member email">
            The address rounds are delivered to. Must be unique within this cohort.
          </FieldHelp>
        </Label>
        <Input
          id="member-email"
          type="email"
          placeholder="jane@acme.example"
          disabled={isLoading}
          {...register('email')}
        />
        <FormError message={errors.email?.message} />
      </div>

      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="member-notes" className="flex items-center gap-1">
          Notes
          <FieldHelp title="Internal note">
            A private admin note about this member. Never shown to the respondent.
          </FieldHelp>
        </Label>
        <Textarea
          id="member-notes"
          placeholder="Internal note (optional)"
          rows={2}
          disabled={isLoading}
          {...register('notes')}
        />
        <FormError message={errors.notes?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm sm:col-span-2">
          {error}
        </div>
      )}

      <div className="sm:col-span-2">
        <Button type="submit" disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="mr-2 h-4 w-4" />
          )}
          Add member
        </Button>
      </div>
    </form>
  );
}
