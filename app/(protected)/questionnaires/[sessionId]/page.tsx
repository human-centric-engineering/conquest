import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import {
  isAttachmentInputEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import { resolveThemeForSession } from '@/lib/app/questionnaire/chat/theme';
import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';
import { loadSessionStatus } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-status';
import { narrowToEnum, PRESENTATION_MODES } from '@/lib/app/questionnaire/types';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

/**
 * Map the SSR-loaded session status to the surface's initial chat status. A budget-paused
 * session (hard cost tier) is terminal cost_capped, not a resumable pause; a respondent
 * pause is `not_active` (the lifecycle bar offers Resume); completed shows the
 * confirmation. Falls back to the row status when the status view didn't resolve.
 */
function initialChatStatus(
  view: SessionStatusView | undefined,
  fallbackActive: boolean
): QuestionnaireChatStatus {
  if (!view) return fallbackActive ? 'idle' : 'not_active';
  switch (view.status) {
    case 'active':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'paused':
      return view.cost?.tier === 'hard' ? 'cost_capped' : 'not_active';
    default:
      return 'not_active'; // abandoned
  }
}

export const metadata: Metadata = {
  title: 'Questionnaire',
  description: 'Complete your questionnaire through a short conversation.',
};

/**
 * Authenticated respondent chat surface (F7.1).
 *
 * The session is created upstream by `start`; this page renders the conversation. It verifies
 * ownership server-side (a session must belong to the signed-in user — anonymous, no-login
 * sessions are driven via `/q/[versionId]` instead) and seeds the surface with a welcome or
 * resume turn plus the session's blocking status, if any.
 *
 * The `/questionnaires` path is not in the proxy's protected list, so this page enforces auth
 * itself rather than relying on the route group alone.
 */
export default async function QuestionnaireSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  if (!(await isLiveSessionsEnabled())) notFound();

  const { sessionId } = await params;

  const session = await getServerSession();
  if (!session) clearInvalidSession(`/questionnaires/${sessionId}`);

  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      respondentUserId: true,
      version: {
        select: {
          config: {
            select: {
              anonymousMode: true,
              presentationMode: true,
              voiceEnabled: true,
              attachmentsEnabled: true,
            },
          },
        },
      },
      _count: { select: { answers: true } },
    },
  });

  // Not found, or not this user's session — 404 either way (don't confirm existence).
  if (!row || row.respondentUserId !== session.user.id) notFound();

  const resumed = row._count.answers > 0;
  const anonymous = row.version.config?.anonymousMode ?? false;
  const presentationMode = narrowToEnum(
    row.version.config?.presentationMode ?? 'chat',
    PRESENTATION_MODES,
    'chat'
  );
  const wantsForm = presentationMode === 'form' || presentationMode === 'both';
  // Voice and attachments each need BOTH the platform flag (capability dark-launch) AND the
  // version's per-questionnaire opt-in, so the affordance shows only when the author turned it on.
  const voiceConfigured = row.version.config?.voiceEnabled ?? false;
  const attachmentsConfigured = row.version.config?.attachmentsEnabled ?? false;
  // Independent reads — resolve in parallel rather than serialising the round-trips. The
  // panel + lifecycle status are SSR-seeded here (the user is already verified as owner),
  // so they paint with no fetch flash; the live updates after each turn come from the
  // client hooks.
  const [voicePlatform, attachmentPlatform, theme, panel, status, formPanel] = await Promise.all([
    isVoiceInputEnabled(),
    isAttachmentInputEnabled(),
    resolveThemeForSession(sessionId),
    loadAnswerPanelState(sessionId),
    loadSessionStatus(sessionId),
    // Seed the full form structure for form/both modes (forForm = full structure, no data-slot
    // swap); chat-only mode skips this round-trip.
    wantsForm ? loadAnswerPanelState(sessionId, false, true) : Promise.resolve(null),
  ]);
  const voiceInputEnabled = voicePlatform && voiceConfigured;
  const attachmentInputEnabled = attachmentPlatform && attachmentsConfigured;
  const initialStatus = initialChatStatus(status?.view, row.status === 'active');

  return (
    <div className="mx-auto h-[calc(100vh-12rem)] max-w-6xl">
      <BrandThemeProvider theme={theme}>
        <SessionWorkspace
          sessionId={sessionId}
          initialTurns={buildWelcomeTurns({
            resumed,
            welcomeCopy: theme.welcomeCopy,
            voiceInputEnabled,
            anonymous,
          })}
          autoStart={!resumed}
          initialStatus={initialStatus}
          initialPanel={panel?.view}
          initialStatusView={status?.view}
          initialFormView={formPanel?.view}
          presentationMode={presentationMode}
          voiceInputEnabled={voiceInputEnabled}
          attachmentInputEnabled={attachmentInputEnabled}
        />
      </BrandThemeProvider>
    </div>
  );
}
