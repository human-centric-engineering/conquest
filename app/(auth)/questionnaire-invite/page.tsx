import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { QuestionnaireInviteForm } from '@/components/forms/questionnaire-invite-form';

export const metadata: Metadata = {
  title: 'Your invitation',
  description: 'Register to complete the questionnaire you were invited to.',
};

/**
 * Respondent invitation landing + registration (F3.2 PR2).
 *
 * Reached from the tokenised link in the invitation email
 * (`/questionnaire-invite?token=…`). The form validates the token against the
 * public metadata endpoint, shows the questionnaire title, and registers the
 * respondent (set-password) — auto-logging them in on success. The token is the
 * sole credential; the email is derived server-side.
 *
 * The form uses `useSearchParams()`, so it needs a Suspense boundary.
 */
export default function QuestionnaireInvitePage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">You&apos;re invited</CardTitle>
        <CardDescription>Register to complete the questionnaire</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>Loading…</div>}>
          <QuestionnaireInviteForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
