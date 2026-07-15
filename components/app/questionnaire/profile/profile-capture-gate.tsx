'use client';

/**
 * ProfileCaptureGate — the respondent profile capture form, a BLOCKING surface of the workspace
 * carousel (F-capture).
 *
 * Supersedes the pre-session `ProfileStartForm`: instead of collecting the admin-authored
 * `profileFields` before the session exists (authed invitation path only), this rides the carousel
 * just after the intro and before the chat, for BOTH the authenticated and public no-login surfaces
 * (whenever the version is non-anonymous and captures in `form` mode). The respondent cannot advance
 * past it — and the opening LLM turn is deferred — until they submit valid details.
 *
 * The client schema (`buildProfileFormSchema`) gives instant per-field feedback, but the SERVER is
 * the enforcing boundary: on submit we PUT to `…/:id/profile`, which re-derives the fields, coerces
 * types, and (per field) re-runs the best-effort agentic normalise/plausibility pass before
 * persisting the snapshot. A `400 INVALID_PROFILE` maps its `fieldErrors` back onto the inputs.
 *
 * Inherits the client's brand via the page's `BrandThemeProvider` CSS vars, so it reads as the same
 * surface as the intro / conversation. Never rendered for an anonymous version (the parent's
 * `showCapture` is false — the PII-free invariant).
 */

import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormError } from '@/components/forms/form-error';
import { FieldHelp } from '@/components/ui/field-help';
import { buildProfileFormSchema } from '@/lib/app/questionnaire/profile/form-schema';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';
const ACCENT = 'var(--app-accent-color, var(--color-primary))';

type FormValues = Record<string, string>;

export interface ProfileCaptureGateProps {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. Sent as `X-Session-Token`. */
  accessToken?: string;
  /** The admin-authored fields to collect, in order (each carries its `validation` mode). */
  fields: ProfileFieldConfig[];
  /** CTA label — defaults to "Continue". */
  proceedLabel?: string;
  /** Called after the server validates + persists the snapshot; the parent advances the carousel. */
  onSubmitted: () => void;
}

export function ProfileCaptureGate({
  sessionId,
  accessToken,
  fields,
  proceedLabel,
  onSubmitted,
}: ProfileCaptureGateProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(buildProfileFormSchema(fields)) as Resolver<FormValues>,
    mode: 'onTouched',
    defaultValues: Object.fromEntries(fields.map((f) => [f.key, ''])),
  });

  const onSubmit = async (data: FormValues) => {
    setSubmitting(true);
    setError(null);

    // Strip empty (untouched optional) values; the server validates + coerces the rest.
    const profileValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.trim() !== '') profileValues[key] = value.trim();
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) headers['X-Session-Token'] = accessToken;
      const response = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.profile(sessionId), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ profileValues }),
      });
      const parsed = await parseApiResponse<{ saved: true }>(response);

      if (parsed.success) {
        onSubmitted();
        return;
      }

      // Map per-field server errors (agentic plausibility, format) back onto the inputs.
      const fieldErrors = parsed.error.details?.fieldErrors;
      if (fieldErrors && typeof fieldErrors === 'object') {
        for (const [key, message] of Object.entries(fieldErrors as Record<string, unknown>)) {
          if (fields.some((f) => f.key === key) && typeof message === 'string') {
            setFieldError(key, { message });
          }
        }
      }
      setSubmitting(false);
      setError(parsed.error.message || 'Please check the details and try again.');
    } catch {
      setSubmitting(false);
      setError('We could not save your details. Please try again.');
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-10">
        <article className="bg-card relative overflow-hidden rounded-2xl border p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_50px_-22px_rgba(0,0,0,0.2)] sm:p-9">
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-1"
            style={{ background: CTA_FILL }}
          />
          <header className="mb-6 flex flex-col gap-1.5">
            <span
              className="text-[0.7rem] font-semibold tracking-[0.18em] uppercase"
              style={{ color: ACCENT }}
            >
              Before you begin
            </span>
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">Your details</h1>
            <p className="text-muted-foreground text-sm">
              A few quick details to go with your responses — you can’t be anonymous on this one.
            </p>
          </header>

          <form
            onSubmit={(e) => void handleSubmit(onSubmit)(e)}
            className="flex flex-col gap-4"
            noValidate
          >
            {fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`capture-${field.key}`} className="flex items-center gap-1.5">
                  {field.label}
                  {!field.required && (
                    <span className="text-muted-foreground text-xs">(optional)</span>
                  )}
                  <FieldHelp title={field.label}>
                    Shared with the questionnaire owner alongside your responses. This questionnaire
                    is not anonymous.
                  </FieldHelp>
                </Label>

                {field.type === 'select' ? (
                  <select
                    id={`capture-${field.key}`}
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
                    id={`capture-${field.key}`}
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
              <div
                className="bg-destructive/10 text-destructive rounded-md p-3 text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full gap-2 text-white"
              style={{ background: CTA_FILL }}
            >
              {submitting ? 'Checking…' : (proceedLabel ?? 'Continue')}
              {!submitting && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </form>
        </article>
      </div>
    </div>
  );
}
