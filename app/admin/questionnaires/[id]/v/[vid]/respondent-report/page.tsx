/**
 * Respondent report tab — configuration for the **Respondent Report** (report kind
 * `respondent`): the per-respondent summary delivered to a respondent after they complete the
 * questionnaire. This is the first of two report kinds; the later cross-respondent **Cohort
 * Report** (`cohort`) will get its own tab + config.
 *
 * Lives under the version segment for the shared workspace chrome (header + tabs). Gated behind
 * APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED on top of the master flag — `notFound()`s when
 * either is off, mirroring the tab's visibility in `workspace-nav.ts`. Reads the resolved config
 * from the cached version graph (no second fetch) and hands the `respondentReport` slice to the
 * client editor.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RespondentReportEditor } from '@/components/admin/questionnaires/report/respondent-report-editor';
import { DEFAULT_RESPONDENT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';
import {
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Respondent report · Questionnaire',
  description: 'Configure the per-respondent report delivered after a respondent completes.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

export default async function RespondentReportTab({ params }: PageProps) {
  const flags = await resolveQuestionnaireWorkspaceFlags();
  if (!flags.respondentReport) notFound();

  const { id, vid } = await params;
  const graph = await getVersionGraphCached(id, vid);
  const settings = graph?.config.respondentReport ?? DEFAULT_RESPONDENT_REPORT_SETTINGS;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        The <span className="text-foreground font-medium">Respondent Report</span> is the
        personalised summary a respondent receives after completing this questionnaire. Configure
        what it contains, how it&rsquo;s generated, and how it&rsquo;s delivered. (Aggregate
        cross-respondent analysis lives in the separate <em>Cohort Report</em>, built later.)
      </p>

      <RespondentReportEditor
        questionnaireId={id}
        versionId={vid}
        initial={settings}
        dataSlotsEnabled={flags.dataSlots}
      />
    </div>
  );
}
