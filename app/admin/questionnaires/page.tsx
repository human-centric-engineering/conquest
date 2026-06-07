import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { QuestionnairesTable } from '@/components/admin/questionnaires/questionnaires-table';
import { UploadQuestionnaireDialog } from '@/components/admin/questionnaires/upload-questionnaire-dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Questionnaires',
  description: 'Ingest, review, and edit conversational questionnaires.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

/**
 * Admin — Questionnaires list page (P2 / F2.1a).
 *
 * Thin server component: gates on the feature flag (404 when off — the surface is
 * dark), pre-renders the first page via `serverFetch`, and hands off to the
 * client `<QuestionnairesTable>` for search / filter / pagination. Fetch failures
 * never throw — the table renders an empty-state and an inline banner.
 */
async function getQuestionnaires(): Promise<{
  items: QuestionnaireListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.APP.QUESTIONNAIRES.ROOT}?page=1&limit=25`);
    if (!res.ok) return { items: [], meta: EMPTY_META };
    const body = await parseApiResponse<QuestionnaireListItem[]>(res);
    if (!body.success) return { items: [], meta: EMPTY_META };
    return { items: body.data, meta: parsePaginationMeta(body.meta) ?? EMPTY_META };
  } catch (err) {
    logger.error('questionnaires list page: initial fetch failed', err);
    return { items: [], meta: EMPTY_META };
  }
}

export default async function QuestionnairesListPage() {
  // The whole questionnaire surface is dark when the flag is off — match the API,
  // which 404s, so the page doesn't render an empty shell behind a hidden feature.
  if (!(await isQuestionnairesEnabled())) notFound();

  const { items, meta } = await getQuestionnaires();

  return (
    <div className="space-y-6">
      <header className="bg-background sticky top-0 z-30 -mx-6 flex items-start justify-between gap-4 border-b px-6 pt-3 pb-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Questionnaires{' '}
            <FieldHelp
              title="What are questionnaires?"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              <p>
                A questionnaire is a structured set of sections and questions an end user completes
                through a streaming conversation rather than a form. An admin ingests a source
                document (PDF / DOCX / MD / TXT) and an agent extracts its structure.
              </p>
              <p className="text-foreground mt-2 font-medium">This page</p>
              <p>
                Browse every ingested questionnaire with its latest version and structure counts.
                Click a row to view its versions and full section / question graph.
              </p>
            </FieldHelp>
          </h1>
          <p className="text-muted-foreground text-sm">
            Ingest, review, and edit conversational questionnaires.
          </p>
        </div>
        <UploadQuestionnaireDialog />
      </header>

      <QuestionnairesTable initialItems={items} initialMeta={meta} />
    </div>
  );
}
