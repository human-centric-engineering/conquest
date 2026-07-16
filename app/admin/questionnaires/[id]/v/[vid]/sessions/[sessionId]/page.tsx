/**
 * Session viewer — an admin reads (and, for a preview, continues) one session's conversation.
 *
 * Lives under the version segment for the shared workspace chrome. Gated behind the live-sessions
 * flag, and `notFound()`s when the session is unknown OR belongs to a different questionnaire than
 * the route's `:id` — the same ownership rule the admin transcript/export routes enforce, so the
 * URL can never confirm a cross-questionnaire session.
 *
 * The read-only vs. continue split is keyed on `isPreview`:
 *  - real respondent session (`isPreview: false`) → read-only replay. No token is minted, so there
 *    is no credential to post a turn with; `resolveTurnAccess` would 403 the admin anyway.
 *  - preview session (`isPreview: true`) that is still active → mint a session token here and render
 *    the full interactive workspace, so the admin can continue the conversation they started.
 *
 * Identity is redacted in anonymous mode by {@link loadAdminSessionView} (mirrors the PDF export).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { SessionDownloads } from '@/components/admin/questionnaires/sessions/session-downloads';
import { SessionReportRerun } from '@/components/admin/questionnaires/sessions/session-report-rerun';
import { Badge } from '@/components/ui/badge';
import { loadAdminSessionView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';
import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { loadAdminReportRerunPanel } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-report-rerun-view';
import { resolveQuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

export const metadata: Metadata = {
  title: 'Session · Questionnaire',
  description: 'View a respondent session conversation.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string; sessionId: string }>;
}

export default async function SessionViewerPage({ params }: PageProps) {
  const { id, vid, sessionId } = await params;

  const flags = await resolveQuestionnaireWorkspaceFlags();
  if (!flags.liveSessions) notFound();

  const view = await loadAdminSessionView(sessionId);
  // Ownership AND version must match the URL — otherwise the session renders under the wrong
  // version's chrome/back-link (and the URL could confirm a cross-questionnaire session).
  if (!view || view.questionnaireId !== id || view.versionId !== vid) notFound();

  const turns = await loadTranscript(sessionId);

  // Continue only a preview session that is still active; mint its token here. A real respondent
  // session never reaches this branch, so it can never be continued by an admin.
  const continuable = view.isPreview && view.status === 'active';
  const accessToken = continuable ? mintSessionToken(sessionId).token : undefined;

  // Admin "re-run report" affordance — only when the respondent-report feature is on. Seeds the panel
  // with the version's current report config (the re-run starting point) and the existing re-run history.
  const rerun = flags.respondentReport ? await loadAdminReportRerunPanel(vid, sessionId) : null;

  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`${workspaceVersionBase(id, vid)}/sessions`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Sessions
        </Link>
        {view.publicRef && (
          <span className="font-mono text-sm font-semibold">
            {formatSessionRef(view.publicRef)}
          </span>
        )}
        <Badge variant="outline">{view.status}</Badge>
        {view.isPreview ? (
          <Badge variant="secondary">Preview</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">Respondent session · read-only</span>
        )}
        {view.respondentName && (
          <span className="text-muted-foreground text-xs">{view.respondentName}</span>
        )}
        {continuable && (
          <span className="text-muted-foreground text-xs">
            You can continue this preview conversation.
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {rerun && (
            <SessionReportRerun
              sessionId={sessionId}
              initialSettings={rerun.settings}
              initialView={rerun.initialView}
              hasClient={rerun.hasClient}
            />
          )}
          <SessionDownloads questionnaireId={id} sessionId={sessionId} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <SessionWorkspace
          sessionId={sessionId}
          initialTurns={turns}
          {...(continuable ? { accessToken } : { readOnly: true })}
        />
      </div>
    </div>
  );
}
