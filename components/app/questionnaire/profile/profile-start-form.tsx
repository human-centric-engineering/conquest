'use client';

/**
 * Respondent profile form (F8.3) — collected at session start on the authenticated
 * (non-anonymous) surface, before the chat begins. The fields are admin-authored
 * (`profileFields`); this renders one input per field and POSTs the values into the
 * session-create route, which writes the `AppRespondentProfileSnapshot` atomically and
 * returns the new session id. On success we navigate to the chat.
 *
 * The anonymous surface never renders this — `loadStartContext` only returns
 * `needs-profile` for a non-anonymous version with profile fields, so no PII is ever
 * collected for an anonymous questionnaire.
 */

import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormError } from '@/components/forms/form-error';
import { FieldHelp } from '@/components/ui/field-help';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

type FormValues = Record<string, string>;

/** Build the client form schema. Values are strings (inputs); the server coerces/validates. */
function buildFormSchema(fields: ProfileFieldConfig[]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny;
    switch (field.type) {
      case 'email':
        base = z.string().trim().email('Enter a valid email address');
        break;
      case 'number':
        base = z
          .string()
          .trim()
          .regex(/^-?\d+(\.\d+)?$/, 'Enter a number');
        break;
      case 'select':
        base = z.string().min(1, 'Select an option');
        break;
      case 'text':
      default:
        base = z.string().trim().min(1, 'This field is required');
        break;
    }
    // Optional fields accept an empty string (rendered blank, stripped before submit).
    shape[field.key] = field.required ? base : z.union([base, z.literal('')]);
  }
  return z.object(shape);
}

export interface ProfileStartFormProps {
  /** The invitation token the session is created from. */
  invitationToken: string;
  /** The admin-authored fields to collect, in order. */
  fields: ProfileFieldConfig[];
}

export function ProfileStartForm({ invitationToken, fields }: ProfileStartFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(buildFormSchema(fields)) as Resolver<FormValues>,
    mode: 'onTouched',
    defaultValues: Object.fromEntries(fields.map((f) => [f.key, ''])),
  });

  const onSubmit = async (data: FormValues) => {
    setSubmitting(true);
    setError(null);

    // Strip empty (untouched optional) values; the server validates the rest against
    // the version's profile fields and coerces number/select types.
    const profileValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.trim() !== '') profileValues[key] = value.trim();
    }

    try {
      const result = await apiClient.post<{ session: { id: string } }>(
        API.APP.QUESTIONNAIRE_SESSIONS.ROOT,
        { body: { invitationToken, profileValues } }
      );
      router.push(`/questionnaires/${result.session.id}`);
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof APIClientError
          ? err.message
          : 'We could not start your questionnaire. Please try again.'
      );
    }
  };

  return (
    <div className="mx-auto max-w-md py-12">
      <h1 className="text-xl font-semibold">Before you begin</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        A few quick details to go with your responses.
      </p>

      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="mt-6 space-y-4">
        {fields.map((field) => (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={`profile-${field.key}`} className="flex items-center gap-1.5">
              {field.label}
              {!field.required && <span className="text-muted-foreground text-xs">(optional)</span>}
              <FieldHelp title={field.label}>
                Shared with the questionnaire owner alongside your responses. This questionnaire is
                not anonymous.
              </FieldHelp>
            </Label>

            {field.type === 'select' ? (
              <select
                id={`profile-${field.key}`}
                disabled={submitting}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50"
                defaultValue=""
                {...register(field.key)}
              >
                <option value="" disabled>
                  Select…
                </option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`profile-${field.key}`}
                type={
                  field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text'
                }
                disabled={submitting}
                {...register(field.key)}
              />
            )}

            <FormError message={errors[field.key]?.message} />
          </div>
        ))}

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Starting…' : 'Start questionnaire'}
        </Button>
      </form>
    </div>
  );
}
