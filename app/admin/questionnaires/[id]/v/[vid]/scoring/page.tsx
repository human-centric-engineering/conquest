/**
 * Scoring tab — the deterministic "hard rules" scoring schema for a version (report kind `cohort`,
 * F14.4). An admin maps questions/data-slots onto named scales (with weight + reverse-scoring) and
 * defines band cutoffs — Big-Five style — either in the visual builder or by extracting a draft from
 * an uploaded document. Scores feed the cohort report's scored aggregation.
 *
 * Gated behind APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED (+ cohorts + master) — `notFound()`s when
 * off, mirroring the tab's visibility in `workspace-nav.ts`. Reads the schema + available keys from
 * the scoring-schema GET endpoint.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ScoringBuilder } from '@/components/admin/questionnaires/cohort-report/scoring-builder';
import { CohortReportSettingsForm } from '@/components/admin/questionnaires/cohort-report/cohort-report-settings-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import { DEFAULT_COHORT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';
import { EMPTY_SCORING_SCHEMA, type ScoringSchemaContent } from '@/lib/app/questionnaire/scoring';

export const metadata: Metadata = {
  title: 'Scoring · Questionnaire',
  description: 'Define deterministic scoring scales, item mappings, and bands.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

interface SchemaView {
  versionId: string;
  name: string;
  source: string;
  content: ScoringSchemaContent;
  questions: Array<{ key: string; prompt: string; type: string }>;
  dataSlots: Array<{ key: string; name: string }>;
}

async function getSchemaView(id: string, vid: string): Promise<SchemaView | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.scoringSchema(id, vid));
    if (!res.ok) return null;
    const body = await parseApiResponse<SchemaView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('scoring tab: schema fetch failed', err);
    return null;
  }
}

export default async function ScoringTab({ params }: PageProps) {
  const flags = await resolveQuestionnaireWorkspaceFlags();
  if (!flags.cohortReport) notFound();

  const { id, vid } = await params;
  const [view, graph] = await Promise.all([getSchemaView(id, vid), getVersionGraphCached(id, vid)]);
  const settings = graph?.config.cohortReport ?? DEFAULT_COHORT_REPORT_SETTINGS;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Cohort report</h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            The cross-respondent report generated over a round&rsquo;s submissions. Configure its
            length, depth, formality, the context it draws on, and an optional structure template.
            Generate + edit the report itself from a round&rsquo;s page.
          </p>
        </div>
        <CohortReportSettingsForm questionnaireId={id} versionId={vid} initial={settings} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Deterministic scoring</h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Map questions/data-slots onto named scales (weighted, optionally reverse-scored) with
            band cutoffs that turn a score into a label. Scores recompute on save and feed the
            cohort report. Build it here, or extract a draft from a scoring document.
          </p>
        </div>
        <ScoringBuilder
          questionnaireId={id}
          versionId={vid}
          initial={view?.content ?? EMPTY_SCORING_SCHEMA}
          questions={view?.questions ?? []}
          dataSlots={view?.dataSlots ?? []}
        />
      </section>
    </div>
  );
}
