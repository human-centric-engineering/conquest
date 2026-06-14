/**
 * Invitations tab — invite respondents to a launched questionnaire and track them.
 *
 * Questionnaire-scoped, not version-scoped: it nests under `/v/[vid]` only to
 * inherit the shared workspace chrome. `vid` is ignored here — the send path
 * targets the newest *launched* version (`_lib/send.ts` orders by versionNumber
 * desc), so the cost estimate and form follow that, as before.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { InviteImportWizard } from '@/components/admin/questionnaires/invite-import-wizard';
import { InvitationsTable } from '@/components/admin/questionnaires/invitations-table';
import { CostEstimateCard } from '@/components/admin/questionnaires/cost-estimate-card';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  isQuestionnairesEnabled,
  isInvitationImportEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  getQuestionnaireDetailCached,
  getVersionGraphCached,
} from '@/lib/app/questionnaire/workspace-data';
import { DEFAULT_INVITEE_FIELDS } from '@/lib/app/questionnaire/types';
import type { InvitationView } from '@/lib/app/questionnaire/invitations';

export const metadata: Metadata = {
  title: 'Invitations · Questionnaire',
  description: 'Invite respondents to a launched questionnaire and track their status.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
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
    logger.error('invitations tab: list fetch failed', err);
    return { invitations: [], total: 0 };
  }
}

export default async function InvitationsTab({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;

  const detail = await getQuestionnaireDetailCached(id);
  if (!detail) notFound();

  // Estimate against the *newest* launched version — the one the send path targets.
  const launchedVersion = detail.versions
    .filter((ver) => ver.status === 'launched')
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
  const hasLaunchedVersion = launchedVersion !== undefined;
  const { invitations, total } = await getInvitations(id);
  const truncated = total > invitations.length;

  // Invitee-field config drives the verify-grid columns; AI import gated by its sub-flag.
  const [graph, importEnabled] = await Promise.all([
    launchedVersion ? getVersionGraphCached(id, launchedVersion.id) : Promise.resolve(null),
    isInvitationImportEnabled(),
  ]);
  const inviteeFields = graph?.config.inviteeFields ?? DEFAULT_INVITEE_FIELDS;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Invite respondents to complete the launched version. Each receives a unique link to register
        and begin — track their progress through to completion here.
      </p>

      {launchedVersion && (
        <CostEstimateCard questionnaireId={id} versionId={launchedVersion.id} variant="banner" />
      )}

      <InviteImportWizard
        questionnaireId={id}
        inviteeFields={inviteeFields}
        importEnabled={importEnabled}
        disabled={!hasLaunchedVersion}
      />

      {truncated && (
        <p className="text-muted-foreground text-sm">
          Showing the most recent {invitations.length} of {total} invitations.
        </p>
      )}
      <InvitationsTable questionnaireId={id} invitations={invitations} />
    </div>
  );
}
