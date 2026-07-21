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
import { ArrowRight, CheckCircle2, Pencil } from 'lucide-react';

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
  // `form` = collecting/editing; `saved` = a confirmation the respondent can review, edit, or continue
  // from. Submitting doesn't auto-advance any more — it lands on the confirmation so the details are
  // acknowledged and re-editable before the conversation starts.
  const [phase, setPhase] = useState<'form' | 'saved'>('form');
  // The values the server accepted, shown in the confirmation summary (label → value, blanks omitted).
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});

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

    // Bound the request so a slow/hung validation can never leave the button stuck on "Checking…".
    // The ceiling sits above the server's worst-case agentic-validation window (8s + a retry) so a
    // genuinely slow-but-valid pass still completes; only a true hang trips it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) headers['X-Session-Token'] = accessToken;
      const response = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.profile(sessionId), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ profileValues }),
        signal: controller.signal,
      });
      const parsed = await parseApiResponse<{ saved: true }>(response);

      if (parsed.success) {
        // Land on the confirmation rather than advancing — the respondent sees it saved and can edit.
        setSavedValues(profileValues);
        setPhase('saved');
        setSubmitting(false);
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
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof DOMException && err.name === 'AbortError'
          ? 'That took longer than expected. Please try again.'
          : 'We could not save your details. Please try again.'
      );
    } finally {
      clearTimeout(timer);
    }
  };

  // Saved confirmation — the respondent's details are persisted; they can edit or carry on. Only the
  // fields they actually filled are listed (blanks were stripped before the PUT).
  const savedView = (
    <>
      <header className="mb-6 flex flex-col gap-1.5">
        <span
          className="inline-flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.18em] uppercase"
          style={{ color: ACCENT }}
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Saved
        </span>
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">You’re all set</h1>
        <p className="text-muted-foreground text-sm">
          Here’s what you shared — edit it, or carry on.
        </p>
      </header>

      <dl className="divide-border/70 mb-6 divide-y overflow-hidden rounded-xl border">
        {fields
          .filter((field) => savedValues[field.key])
          .map((field) => (
            // Stacked (label above value), so a long single-token value (e.g. an email) gets the full
            // width and wraps cleanly instead of squeezing the label or overflowing the card.
            <div key={field.key} className="px-4 py-3">
              <dt className="text-muted-foreground text-xs">{field.label}</dt>
              <dd className="text-foreground mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">
                {savedValues[field.key]}
              </dd>
            </div>
          ))}
      </dl>

      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError(null);
            setPhase('form');
          }}
          className="gap-2 sm:flex-1"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" /> Edit details
        </Button>
        <Button
          type="button"
          onClick={onSubmitted}
          className="gap-2 text-[var(--app-on-cta,#fff)] sm:flex-1"
          style={{ background: CTA_FILL }}
        >
          {proceedLabel ?? 'Continue'}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </>
  );

  const formView = (
    <>
      <header className="mb-6 flex flex-col gap-1.5">
        <span
          className="text-[0.7rem] font-semibold tracking-[0.18em] uppercase"
          style={{ color: ACCENT }}
        >
          Before you begin
        </span>
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Your details</h1>
        <p className="text-muted-foreground text-sm">
          Please leave a couple of quick details before you begin.
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
              {!field.required && <span className="text-muted-foreground text-xs">(optional)</span>}
              <FieldHelp title={field.label}>
                Shared with the questionnaire owner alongside your responses. This questionnaire is
                not anonymous.
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
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm" role="alert">
            {error}
          </div>
        )}

        <Button
          type="submit"
          disabled={submitting}
          className="mt-2 w-full gap-2 text-[var(--app-on-cta,#fff)]"
          style={{ background: CTA_FILL }}
        >
          {submitting ? 'Checking…' : (proceedLabel ?? 'Continue')}
          {!submitting && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </form>
    </>
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center px-6 py-10">
        <article className="bg-card relative overflow-hidden rounded-2xl border p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_50px_-22px_rgba(0,0,0,0.2)] sm:p-9">
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-1"
            style={{ background: CTA_FILL }}
          />
          {phase === 'saved' ? savedView : formView}
        </article>
      </div>
    </div>
  );
}
