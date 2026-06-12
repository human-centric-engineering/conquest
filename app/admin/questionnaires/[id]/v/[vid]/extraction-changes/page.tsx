/**
 * Changes tab — review / revert the extractor's editorial decisions for the
 * selected version. Lifted into the workspace; reads `vid` from the path.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

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
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Every editorial decision the extractor made — review the before/after and revert any of
        them. Reverting a launched version creates a new draft.
      </p>

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
