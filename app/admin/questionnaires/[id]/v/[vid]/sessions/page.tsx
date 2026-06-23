/**
 * Sessions tab — the admin's entry to the respondent session viewer.
 *
 * Lives under the version segment for the shared workspace chrome (header + tabs). Gated behind the
 * live-sessions flag — `notFound()`s when it's off, mirroring the tab's visibility in
 * `workspace-nav.ts` (sessions only exist once the live respondent surface is on).
 *
 * For now the tab is a lookup-by-reference surface: paste a support reference to open a session's
 * conversation. It's built to later grow a full per-version session list above the lookup.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SessionRefLookup } from '@/components/admin/questionnaires/sessions/session-ref-lookup';
import { resolveQuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Sessions · Questionnaire',
  description: 'Look up and view a respondent session by its support reference.',
};

export default async function SessionsTab() {
  const flags = await resolveQuestionnaireWorkspaceFlags();
  if (!flags.liveSessions) notFound();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Open a respondent&rsquo;s conversation by the{' '}
        <span className="text-foreground font-medium">support reference</span> they were given. A
        real respondent conversation opens read-only; a preview conversation you started can be
        continued.
      </p>
      <SessionRefLookup />
    </div>
  );
}
