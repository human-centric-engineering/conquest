'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { waitlistClientSchema, type WaitlistClientInput } from '@/lib/app/waitlist/validation';
import { useFormAnalytics } from '@/lib/analytics/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormError } from '@/components/forms/form-error';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface WaitlistResponse {
  message: string;
}

/**
 * ConQuest waitlist sign-up form. Mirrors the contact-form pattern
 * (react-hook-form + Zod + apiClient, honeypot, success/error states) but is
 * app-owned. Captures name + email and an optional use-case; `source` is a
 * hidden field set by the page so we know which CTA the sign-up came from.
 */
export function WaitlistForm({ source }: { source?: string }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const { trackFormSubmitted } = useFormAnalytics();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<WaitlistClientInput>({
    resolver: zodResolver(waitlistClientSchema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', useCase: '', website: '', source },
  });

  const onSubmit = async (data: WaitlistClientInput) => {
    try {
      setIsLoading(true);
      setError(null);

      await apiClient.post<WaitlistResponse>(API.PUBLIC.WAITLIST, { body: data });

      void trackFormSubmitted('waitlist');
      setIsSuccess(true);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Success state
  if (isSuccess) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
          <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">You&apos;re on the list!</h3>
          <p className="text-muted-foreground mt-1">
            Thanks for joining. We&apos;ve sent a confirmation to your inbox, and you&apos;ll be
            among the first to hear when ConQuest opens up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
      {/* Hidden honeypot field - invisible to real users, attracts bots */}
      <div className="absolute -left-[9999px] opacity-0" aria-hidden="true">
        <label htmlFor="website">Website (leave blank)</label>
        <input type="text" id="website" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>

      {/* Source marker — set by the page, not the user */}
      <input type="hidden" {...register('source')} />

      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          placeholder="Your name"
          autoComplete="name"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          disabled={isLoading}
          {...register('email')}
        />
        <FormError message={errors.email?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="useCase">
          What would you use ConQuest for?{' '}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="useCase"
          placeholder="A line or two about the questionnaires, surveys or research you have in mind."
          className="min-h-[100px] resize-y"
          disabled={isLoading}
          {...register('useCase')}
        />
        <FormError message={errors.useCase?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Joining...
          </>
        ) : (
          'Join the waitlist'
        )}
      </Button>
    </form>
  );
}
