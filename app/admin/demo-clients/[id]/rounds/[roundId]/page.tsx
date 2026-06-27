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
import { ChevronLeft, Sparkles } from 'lucide-react';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { SectionRail } from '@/components/admin/section-rail';
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
import { RoundContextPanel } from '@/components/admin/cohorts/round-context-panel';
import { RoundLearningPanel } from '@/components/admin/cohorts/round-learning-panel';
import { RoundPhasesPanel } from '@/components/admin/cohorts/round-phases-panel';
import { RoundCohortReportPanel } from '@/components/admin/cohorts/round-cohort-report-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  isCohortsEnabled,
  isCohortReportEnabled,
  isLearningModeEnabled,
  isRoundContextEnabled,
  isRoundPhasesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  listBriefableQuestionnaires,
  listRoundContextEntries,
} from '@/app/api/v1/app/rounds/_lib/context';
import { listRoundLearningDigest } from '@/lib/app/questionnaire/learning/digest';
import { listCohortSubgroups } from '@/app/api/v1/app/cohorts/_lib/read';
import {
  cohortDetailHref,
  roundsTabHref,
  type CohortSubgroupView,
  type RoundDetail,
} from '@/lib/app/questionnaire/rounds';
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

  // Round Additional Context + Learning Mode — each gated by its own flag; the sections hide entirely
  // when off. Reads go straight through the `_lib` (server component), no extra HTTP. `briefable` is
  // shared (both panels need version titles), loaded once when either feature is on.
  const [roundContextOn, learningOn, phasesOn, cohortReportOn] = await Promise.all([
    isRoundContextEnabled(),
    isLearningModeEnabled(),
    isRoundPhasesEnabled(),
    isCohortReportEnabled(),
  ]);
  const [briefable, contextEntries, learningDigest, subgroups] = await Promise.all([
    roundContextOn || learningOn || cohortReportOn
      ? listBriefableQuestionnaires(roundId)
      : Promise.resolve([]),
    roundContextOn ? listRoundContextEntries(roundId) : Promise.resolve([]),
    learningOn ? listRoundLearningDigest(roundId) : Promise.resolve([]),
    phasesOn
      ? listCohortSubgroups(round.cohortId)
      : Promise.resolve<CohortSubgroupView[] | null>([]),
  ]);

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
            {learningOn && round.learningEnabled && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                title="Learning Mode is on — later respondents are influenced by earlier ones, so results carry intentional bias."
              >
                <Sparkles className="h-3 w-3" /> Learning · biased
              </span>
            )}
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

      {/* Two-column on wide screens: a sticky scroll-spy rail (wayfinding only) beside the
          single scroll. The rail discovers its items from the `[data-section-rail]` panels
          inside `#round-sections`, so flag-gated sections appear exactly when they render.
          Content is pinned to column 2 so the layout doesn't shift when the rail mounts. */}
      <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-6">
        <SectionRail
          targetId="round-sections"
          ariaLabel="Round sections"
          className="top-24 hidden self-start lg:sticky lg:block"
        />
        <div id="round-sections" className="min-w-0 space-y-6 lg:col-start-2">
          <section
            id="bundled"
            data-section-rail
            data-section-label="Bundled questionnaires"
            className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
          >
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

          {phasesOn && (
            <section
              id="phases"
              data-section-rail
              data-section-label="Phases"
              className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
            >
              <SectionHeading title="Phases">
                Stagger access by subgroup so one group can go before the rest — for example, a
                leadership team in week one, everyone else from week two. Each phase&rsquo;s window
                must sit inside the round window; members with no phase use the round&rsquo;s own
                window.
              </SectionHeading>
              <RoundPhasesPanel
                roundId={round.id}
                roundOpensAt={round.opensAt}
                roundClosesAt={round.closesAt}
                phases={round.phases}
                subgroups={subgroups ?? []}
              />
            </section>
          )}

          {roundContextOn && (
            <section
              id="context"
              data-section-rail
              data-section-label="Additional context"
              className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
            >
              <SectionHeading title="Additional context">
                Brief the interviewer with facts, figures, and background for this round&rsquo;s
                questions — attach a note to one question or keep it general. The interviewer draws
                on these quietly; it never reads them aloud.
              </SectionHeading>
              <RoundContextPanel
                roundId={round.id}
                contextEnabled={round.contextEnabled}
                entries={contextEntries}
                briefable={briefable}
              />
            </section>
          )}

          {learningOn && (
            <section
              id="learning"
              data-section-rail
              data-section-label="Learning mode"
              className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
            >
              <SectionHeading title="Learning mode">
                Let the interviewer draw on what earlier respondents in this round have said to
                enrich later conversations. Powerful for depth &mdash; but it introduces bias, so it
                stays off until you opt in.
              </SectionHeading>
              <RoundLearningPanel
                roundId={round.id}
                learningEnabled={round.learningEnabled}
                learningConfig={round.learningConfig}
                digest={learningDigest}
                briefable={briefable}
              />
            </section>
          )}

          {cohortReportOn && (
            <section
              id="cohort-report"
              data-section-rail
              data-section-label="Cohort report"
              className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
            >
              <SectionHeading title="Cohort report">
                Analyse this round across all respondents — segmented by the questionnaire&rsquo;s
                own demographics — and generate a narrative report with charts, recommendations and
                actions. Review and (soon) edit it here; privacy thresholds hide any group that is
                too small.
              </SectionHeading>
              <RoundCohortReportPanel
                roundId={round.id}
                versions={briefable.map((b) => ({ versionId: b.versionId, title: b.title }))}
              />
            </section>
          )}

          <section
            id="invitations"
            data-section-rail
            data-section-label="Member invitations"
            className="scroll-mt-24 space-y-3 rounded-xl border px-4 py-4"
          >
            <SectionHeading title="Member invitations">
              Generate a secure, round-bound link per active cohort member. The link carries the
              round membership, so each respondent&rsquo;s session is enforced against this
              round&rsquo;s window and their membership.
            </SectionHeading>
            <RoundInvitesPanel roundId={round.id} questionnaireCount={round.questionnaireCount} />
          </section>
        </div>
      </div>
    </div>
  );
}
