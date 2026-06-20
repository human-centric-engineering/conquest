/**
 * Round detail — one round's window, bundled questionnaires, and completion stats.
 *
 * Server component: gates on the `APP_QUESTIONNAIRES_COHORTS` flag, fetches the round
 * detail (with its bundled questionnaires) plus the client's questionnaires (the attach
 * picker's source) via `serverFetch`, then composes the client panels
 * (`<RoundHeaderActions>`, `<RoundQuestionnairesPanel>`). A missing round 404s; the
 * attachable-list fetch degrades to an empty picker, never throws.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS`. DEMO-ONLY (F2.5.1 lineage).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { RoundHeaderActions } from '@/components/admin/cohorts/round-header-actions';
import {
  RoundStatusBadge,
  SectionHeading,
  humanizeWindow,
} from '@/components/admin/cohorts/cohort-ui';
import { RoundInvitesPanel } from '@/components/admin/cohorts/round-invites-panel';
import {
  RoundQuestionnairesPanel,
  type AttachableQuestionnaire,
} from '@/components/admin/cohorts/round-questionnaires-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { cohortDetailHref, roundsTabHref, type RoundDetail } from '@/lib/app/questionnaire/rounds';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Round · Demo client',
  description: 'A round’s window, bundled questionnaires, and completion.',
};

interface PageProps {
  params: Promise<{ id: string; roundId: string }>;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function getRound(roundId: string): Promise<RoundDetail | null> {
  try {
    const res = await serverFetch(API.APP.ROUNDS.byId(roundId));
    if (!res.ok) return null;
    const body = await parseApiResponse<RoundDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('round detail: fetch failed', err);
    return null;
  }
}

/** The client's questionnaires, the attach picker's source — filtered server-side to this client. */
async function getAttachable(demoClientId: string): Promise<AttachableQuestionnaire[]> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.ROOT}?limit=100&demoClientId=${encodeURIComponent(demoClientId)}`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<QuestionnaireListItem[]>(res);
    if (!body.success) return [];
    return body.data.map((q) => ({ id: q.id, title: q.title }));
  } catch (err) {
    logger.error('round detail: attachable questionnaires fetch failed', err);
    return [];
  }
}

export default async function RoundDetailPage({ params }: PageProps) {
  if (!(await isCohortsEnabled())) notFound();

  const { id, roundId } = await params;
  const round = await getRound(roundId);
  if (!round) notFound();

  const attachable = await getAttachable(id);

  const statTiles: CqStat[] = [
    { label: 'Members', value: round.memberCount },
    { label: 'Started', value: round.stats.sessionsStarted },
    { label: 'Completed', value: round.stats.sessionsCompleted, accent: true },
    {
      label: 'Completion',
      value:
        round.stats.sessionsStarted === 0
          ? '—'
          : `${Math.round(round.stats.completionRate * 100)}%`,
    },
  ];

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link
          href={roundsTabHref(id)}
          className="hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Rounds
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{round.name}</h1>
            <RoundStatusBadge status={round.status} />
            <span className="text-muted-foreground text-xs">
              {humanizeWindow(round.status, round.opensAt, round.closesAt)}
            </span>
          </div>
          {round.description && (
            <p className="text-muted-foreground max-w-prose text-sm">{round.description}</p>
          )}
          <p className="text-muted-foreground text-xs">
            <Link
              href={cohortDetailHref(id, round.cohortId)}
              className="hover:text-[color:var(--cq-accent)] hover:underline"
            >
              {round.cohortName}
            </Link>{' '}
            · Opens {formatDateTime(round.opensAt)} · Closes {formatDateTime(round.closesAt)}
            {round.closedAt && <> · Closed {formatDateTime(round.closedAt)}</>}
          </p>
        </div>
        <RoundHeaderActions demoClientId={id} round={round} />
      </header>

      <CqStatTiles stats={statTiles} />

      <section className="space-y-3 rounded-xl border px-4 py-4">
        <SectionHeading title="Bundled questionnaires">
          Every member completes each questionnaire bundled here. Attach one from this
          client&rsquo;s questionnaires, or detach to remove it from the round.
        </SectionHeading>
        <RoundQuestionnairesPanel
          roundId={round.id}
          questionnaires={round.questionnaires}
          attachable={attachable}
        />
      </section>

      <section className="space-y-3 rounded-xl border px-4 py-4">
        <SectionHeading title="Member invitations">
          Generate a secure, round-bound link per active cohort member. The link carries the round
          membership, so each respondent&rsquo;s session is enforced against this round&rsquo;s
          window and their membership.
        </SectionHeading>
        <RoundInvitesPanel roundId={round.id} questionnaireCount={round.questionnaireCount} />
      </section>
    </div>
  );
}
