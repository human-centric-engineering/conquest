import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import {
  createOrResumeAuthedSession,
  type AuthedSessionRequest,
} from '@/lib/app/questionnaire/chat/session-bootstrap';
import { findAuthedResumeDetail } from '@/lib/app/questionnaire/chat/resumable-session';
import { resolveSessionResumeEnabledForVersion } from '@/lib/app/questionnaire/chat/anonymity';
import { AuthedResumeChooser } from '@/components/app/questionnaire/intro/authed-resume-chooser';

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

  // Session resume (versionId path only): if the respondent already has an in-progress session for
  // this version WITH real progress, offer Continue / Start new instead of silently resuming. The
  // invitation path keeps its idempotent silent resume — its round/cohort context is resolved by the
  // create seam, not re-derived here. A zero-progress session isn't worth a prompt (like the
  // anonymous gate), so it falls through to the silent create/resume below.
  if ('versionId' in request) {
    const resumeEnabled = await resolveSessionResumeEnabledForVersion(request.versionId);
    if (resumeEnabled) {
      const resume = await findAuthedResumeDetail(request.versionId, session.user.id);
      if (resume && resume.answeredCount >= 1) {
        return (
          <AuthedResumeChooser
            versionId={request.versionId}
            sessionId={resume.sessionId}
            refRaw={resume.ref}
            answeredCount={resume.answeredCount}
          />
        );
      }
    }
  }

  // Create (or idempotently resume) the session and go straight to the chat. Profile capture is no
  // longer collected here — for a non-anonymous version it now rides the workspace carousel as a
  // blocking form gate AFTER the intro (F-capture), so the session is always created first.
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
