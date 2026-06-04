import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { InviteForm } from '@/components/admin/questionnaires/invite-form';
import { InvitationsTable } from '@/components/admin/questionnaires/invitations-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { QuestionnaireDetail } from '@/lib/app/questionnaire/views';
import type { InvitationView } from '@/lib/app/questionnaire/invitations';

export const metadata: Metadata = {
  title: 'Invitations',
  description: 'Invite respondents to a launched questionnaire and track their status.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getDetail(id: string): Promise<QuestionnaireDetail | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('invitations page: detail fetch failed', err);
    return null;
  }
}

/** Page size for the (un-paginated) admin list. The list endpoint caps `limit` at 100. */
const INVITATION_PAGE_SIZE = 100;

async function getInvitations(
  id: string
): Promise<{ invitations: InvitationView[]; total: number }> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.invitations(id)}?limit=${INVITATION_PAGE_SIZE}`
    );
    if (!res.ok) return { invitations: [], total: 0 };
    const body = await parseApiResponse<InvitationView[]>(res);
    if (!body.success) return { invitations: [], total: 0 };
    const total = typeof body.meta?.total === 'number' ? body.meta.total : body.data.length;
    return { invitations: body.data, total };
  } catch (err) {
    logger.error('invitations page: list fetch failed', err);
    return { invitations: [], total: 0 };
  }
}

export default async function InvitationsPage({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;

  const detail = await getDetail(id);
  if (!detail) notFound();

  const hasLaunchedVersion = detail.versions.some((ver) => ver.status === 'launched');
  const { invitations, total } = await getInvitations(id);
  const truncated = total > invitations.length;

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <Link href={`/admin/questionnaires/${id}`} className="hover:underline">
          {detail.title}
        </Link>
        {' / '}
        <span>Invitations</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Invitations</h1>
        <p className="text-muted-foreground text-sm">
          Invite respondents to complete the launched version. Each receives a unique link to
          register and begin — track their progress through to completion here.
        </p>
      </header>

      <InviteForm questionnaireId={id} hasLaunchedVersion={hasLaunchedVersion} />

      {truncated && (
        <p className="text-muted-foreground text-sm">
          Showing the most recent {invitations.length} of {total} invitations.
        </p>
      )}
      <InvitationsTable questionnaireId={id} invitations={invitations} />
    </div>
  );
}
