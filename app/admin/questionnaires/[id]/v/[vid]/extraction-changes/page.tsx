/**
 * Changes tab — review / revert the extractor's editorial decisions for the
 * selected version. Lifted into the workspace; reads `vid` from the path.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Wand2 } from 'lucide-react';

import { ExtractionChangesTable } from '@/components/admin/questionnaires/extraction-changes-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { ExtractionChangeListResponse } from '@/lib/app/questionnaire/extraction-review';

export const metadata: Metadata = {
  title: 'Changes · Questionnaire',
  description: 'Review and revert the extractor’s editorial decisions for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

async function getChanges(
  id: string,
  versionId: string
): Promise<ExtractionChangeListResponse | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionChanges(id, versionId));
    if (!res.ok) return null;
    const body = await parseApiResponse<ExtractionChangeListResponse>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('changes tab: fetch failed', err);
    return null;
  }
}

export default async function ExtractionChangesTab({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id, vid } = await params;
  const changes = await getChanges(id, vid);

  return (
    <div className="space-y-5">
      {/* Explainer band — names the surface and, crucially, says what "the extractor" is: the
          ingestion agent that built this structure from the uploaded document. Mirrors the
          Structure / Data-slots blueprint header so the workspace reads as one tool. */}
      <div className="cq-blueprint relative overflow-hidden rounded-xl border">
        <div className="bg-card/70 p-4 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
              <Wand2 className="h-5 w-5" />
            </span>
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold tracking-tight">Extraction changes</h2>
              <p className="text-muted-foreground max-w-3xl text-sm">
                When this version’s source document was uploaded, an{' '}
                <span className="text-foreground font-medium">extraction agent</span> read it and
                built the questionnaire’s structure for you — it’s opinionated, not a verbatim copy.
              </p>
              <p className="text-muted-foreground max-w-3xl text-sm">
                This log records every editorial decision the extractor made — pruning boilerplate,
                fixing typos, rewriting terse prompts, and inferring question types, the goal, and
                the audience. Review the before / after of each and revert anything you disagree
                with. Reverting a launched version creates a new draft.
              </p>
            </div>
          </div>
        </div>
      </div>

      {changes ? (
        <ExtractionChangesTable
          questionnaireId={id}
          versionId={vid}
          changes={changes.changes}
          counts={changes.counts}
        />
      ) : (
        <p className="text-muted-foreground text-sm italic">
          Could not load this version’s extraction changes.
        </p>
      )}
    </div>
  );
}
