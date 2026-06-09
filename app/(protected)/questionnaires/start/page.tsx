import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { isLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  createOrResumeAuthedSession,
  type AuthedSessionRequest,
} from '@/lib/app/questionnaire/chat/session-bootstrap';
import { loadStartContext } from '@/lib/app/questionnaire/chat/start-context';
import { ProfileStartForm } from '@/components/app/questionnaire/profile/profile-start-form';

export const metadata: Metadata = {
  title: 'Start questionnaire',
  description: 'Begin or resume your conversational questionnaire.',
};

/**
 * Authenticated respondent entry point (F7.1).
 *
 * Resolves `?invitationToken=` or `?versionId=` into a created/resumed session and redirects
 * to the chat surface. Centralises the invitation-vs-version branching and maps create
 * failures to a friendly screen. The flag gate runs first so a dark-launched surface looks
 * like a missing route.
 */
export default async function StartQuestionnairePage({
  searchParams,
}: {
  searchParams: Promise<{ invitationToken?: string; versionId?: string }>;
}) {
  if (!(await isLiveSessionsEnabled())) notFound();

  const sp = await searchParams;
  const request: AuthedSessionRequest | null = sp.invitationToken
    ? { invitationToken: sp.invitationToken }
    : sp.versionId
      ? { versionId: sp.versionId }
      : null;

  if (!request) {
    return (
      <StartError
        title="This link is incomplete"
        message="The questionnaire link is missing its access details. Please use the link from your invitation."
      />
    );
  }

  const session = await getServerSession();
  if (!session) {
    const query = sp.invitationToken
      ? `?invitationToken=${encodeURIComponent(sp.invitationToken)}`
      : `?versionId=${encodeURIComponent(sp.versionId ?? '')}`;
    clearInvalidSession(`/questionnaires/start${query}`);
    return null; // unreachable — clearInvalidSession redirects
  }

  // F8.3: a non-anonymous questionnaire with profile fields collects them BEFORE the
  // session is created. The form posts the values back into the create route (which
  // writes the snapshot atomically); a resumable session skips straight to the chat.
  const context = await loadStartContext(request, session.user.id);
  if (context.kind === 'resume') {
    redirect(`/questionnaires/${context.sessionId}`);
  }
  if (context.kind === 'needs-profile' && 'invitationToken' in request) {
    return (
      <ProfileStartForm invitationToken={request.invitationToken} fields={context.profileFields} />
    );
  }

  const result = await createOrResumeAuthedSession(request);
  if (result.ok) {
    redirect(`/questionnaires/${result.sessionId}`);
  }

  return <StartError title="We couldn’t start your questionnaire" message={result.message} />;
}

function StartError({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      <p className="text-muted-foreground text-sm text-balance">{message}</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
