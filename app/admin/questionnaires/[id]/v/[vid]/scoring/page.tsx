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
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { resolveQuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';
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
  const view = await getSchemaView(id, vid);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Define <span className="text-foreground font-medium">deterministic scoring</span> — named
        scales, the questions/data-slots that feed each (weighted, optionally reverse-scored), and
        the band cutoffs that turn a score into a label. Scores are recomputed on save and feed the
        cohort report&rsquo;s scored analysis. Build it here, or extract a draft from a scoring
        document.
      </p>

      <ScoringBuilder
        questionnaireId={id}
        versionId={vid}
        initial={view?.content ?? EMPTY_SCORING_SCHEMA}
        questions={view?.questions ?? []}
        dataSlots={view?.dataSlots ?? []}
      />
    </div>
  );
}
