/**
 * Settings tab — questionnaire-level configuration that isn't part of a version's
 * structure. Today: demo-client attribution (which brand the sales surface wears)
 * and clone-for-client (DEMO-ONLY). Nested under `/v/[vid]` for the shared chrome;
 * the settings here are questionnaire-scoped.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DemoClientAssign } from '@/components/admin/demo-clients/demo-client-assign';
import { CloneForClientDialog } from '@/components/admin/questionnaires/clone-for-client-dialog';
import { VersionSettingsPanel } from '@/components/admin/questionnaires/version-settings-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  getQuestionnaireDetailCached,
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import type { AttributedDemoClient, DemoClientView } from '@/lib/app/questionnaire/demo-clients';

export const metadata: Metadata = {
  title: 'Settings · Questionnaire',
  description: 'Demo-client attribution and other questionnaire-level settings.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

// DEMO-ONLY (F2.5.1): active demo clients for the attribution picker. Degrades to
// an empty list — the picker still shows the current attribution and "None".
async function getActiveDemoClients(): Promise<AttributedDemoClient[]> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<DemoClientView[]>(res);
    if (!body.success) return [];
    return body.data
      .filter((client) => client.isActive)
      .map((client) => ({ id: client.id, slug: client.slug, name: client.name }));
  } catch (err) {
    logger.error('settings tab: demo clients fetch failed', err);
    return [];
  }
}

export default async function SettingsTab({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id, vid } = await params;

  const [detail, demoClientOptions, graph, flags] = await Promise.all([
    getQuestionnaireDetailCached(id),
    getActiveDemoClients(),
    getVersionGraphCached(id, vid),
    resolveQuestionnaireWorkspaceFlags(),
  ]);
  if (!detail) notFound();

  return (
    <div className="max-w-2xl space-y-8">
      {/* Version-scoped settings (F3.1 + F9.7) — goal/audience + run-time config. Editing a
          launched version forks a new draft (the panel surfaces the notice). */}
      {graph && (
        <VersionSettingsPanel
          questionnaireId={id}
          graph={graph}
          adaptiveEnabled={flags.adaptive}
          designEvalEnabled={flags.designEval}
        />
      )}

      {/* DEMO-ONLY (F2.5.1): demo-client attribution. */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Demo client</h2>
          <p className="text-muted-foreground text-sm">
            The brand this questionnaire’s respondent surface and invitations wear. “None” uses the
            generic demo theme.
          </p>
        </div>
        <DemoClientAssign
          questionnaireId={id}
          current={detail.demoClient}
          options={demoClientOptions}
        />
      </section>

      {/* Clone-for-client (DEMO-ONLY) — duplicate this questionnaire for another prospect. */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Clone for another client</h2>
          <p className="text-muted-foreground text-sm">
            Duplicate this questionnaire (and its current structure) as a fresh draft, optionally
            attributed to a different demo client.
          </p>
        </div>
        <CloneForClientDialog questionnaireId={id} options={demoClientOptions} />
      </section>
    </div>
  );
}
