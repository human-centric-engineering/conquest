/**
 * Settings tab — questionnaire-level configuration that isn't part of a version's
 * structure. Today: demo-client attribution (which brand the sales surface wears)
 * and clone-for-client (DEMO-ONLY). Nested under `/v/[vid]` for the shared chrome;
 * the settings here are questionnaire-scoped.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DemoClientAssign } from '@/components/admin/demo-clients/demo-client-assign';
import { AdvisorPanel } from '@/components/admin/questionnaires/advisor/advisor-panel';
import { PolicyEvaluationCard } from '@/components/admin/questionnaires/policy-evaluation-card';
import { CloneForClientDialog } from '@/components/admin/questionnaires/clone-for-client-dialog';
import { RenameQuestionnaire } from '@/components/admin/questionnaires/rename-questionnaire';
import { VersionSettingsPanel } from '@/components/admin/questionnaires/version-settings-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  getQuestionnaireDetailCached,
  getVersionGraphCached,
  getVersionTopicsCached,
} from '@/lib/app/questionnaire/workspace-data';
import { conditionalQuestionCountOf } from '@/lib/app/questionnaire/authoring/config-conflicts';
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
  const { id, vid } = await params;

  const [detail, demoClientOptions, graph, scope] = await Promise.all([
    getQuestionnaireDetailCached(id),
    getActiveDemoClients(),
    getVersionGraphCached(id, vid),
    // F17.33: the conflict check that reads how much of the instrument is conditional needs the
    // topics, which are authored on their own tab. Cached and already fetched by the version
    // overview, so this rides the same read rather than adding one.
    getVersionTopicsCached(id, vid),
  ]);
  if (!detail) notFound();

  // `null` would mean "this surface cannot know"; here we looked, so a version with no conditional
  // topics honestly reports zero and the check stays quiet.
  const conditionalQuestionCount = conditionalQuestionCountOf(scope?.topics ?? []);

  return (
    <div className="max-w-2xl space-y-8">
      {/* Questionnaire-level identity: rename. The title spans every version, so it lives here
          (questionnaire-scoped), not in a version's Structure editor. */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Name</h2>
          <p className="text-muted-foreground text-sm">
            The questionnaire&rsquo;s display name, shown in the admin list, this workspace header,
            and respondent surfaces.
          </p>
        </div>
        <RenameQuestionnaire questionnaireId={id} currentTitle={detail.title} />
      </section>

      {/* Config Advisor (admin-triggered AI review of the whole config). Sits above the editor so the
          advice is read before tweaking; applying a suggestion PATCHes the same config endpoint. */}
      {graph && <AdvisorPanel questionnaireId={id} graph={graph} />}

      {/* Interviewer-policy judge panel (F18.8). Sits in the same slot as the Advisor, and for the
          same stated reason — the review is read before tweaking — but one layer more specific:
          it judges the house rules, the questioning arc and the ask-as-written dial together.
          Not inside any one SettingsGroup: one of its four reviewers is about the arc, one about
          the questions, and one about how all of them interact. */}
      {graph && (
        <PolicyEvaluationCard
          questionnaireId={id}
          versionId={vid}
          ruleTextById={Object.fromEntries(
            graph.config.houseRules.rules.map((rule) => [rule.id, rule.text])
          )}
          questionPromptByKey={Object.fromEntries(
            graph.sections.flatMap((section) => section.questions.map((q) => [q.key, q.prompt]))
          )}
          formOnly={graph.config.presentationMode === 'form'}
        />
      )}

      {/* Version-scoped run-time config (F3.1 + F9.7). Editing a launched version forks a new
          draft (the panel surfaces the notice). Goal & audience are edited on the Structure tab. */}
      {graph && (
        <VersionSettingsPanel
          questionnaireId={id}
          graph={graph}
          conditionalQuestionCount={conditionalQuestionCount}
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
