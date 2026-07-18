import type { Metadata } from 'next';

import { QuestionnairesTable } from '@/components/admin/questionnaires/questionnaires-table';
import { NewQuestionnaireMenu } from '@/components/admin/questionnaires/new-questionnaire-menu';
import { DataSlotEmbeddingInfo } from '@/components/admin/questionnaires/data-slot-embedding-info';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { AttributedDemoClient, DemoClientView } from '@/lib/app/questionnaire/demo-clients';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Questionnaires',
  description: 'Ingest, review, and edit conversational questionnaires.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

interface QuestionnaireStats {
  total: number;
  launched: number;
  draft: number;
  archived: number;
}

/**
 * Status breakdown for the summary tiles. Fetches the widest page the list endpoint
 * allows (its `limit` is capped at 100 — asking for more 400s and the tiles silently
 * read zero) so the launched / draft split is accurate at demo scale; `total` comes
 * from the pagination meta so it stays correct even past the sample. The `archived`
 * tile counts soft-deleted questionnaires — a separate slice the default list
 * excludes — via a 1-row `?archived=true` fetch read for its meta `total`. Degrades
 * to zeros.
 */
async function getQuestionnaireStats(): Promise<QuestionnaireStats> {
  const empty: QuestionnaireStats = { total: 0, launched: 0, draft: 0, archived: 0 };
  try {
    const [activeRes, archivedRes] = await Promise.all([
      serverFetch(`${API.APP.QUESTIONNAIRES.ROOT}?page=1&limit=100`),
      serverFetch(`${API.APP.QUESTIONNAIRES.ROOT}?archived=true&page=1&limit=1`),
    ]);

    let archived = 0;
    if (archivedRes.ok) {
      const archivedBody = await parseApiResponse<QuestionnaireListItem[]>(archivedRes);
      if (archivedBody.success) {
        archived = parsePaginationMeta(archivedBody.meta)?.total ?? 0;
      }
    }

    if (!activeRes.ok) return { ...empty, archived };
    const body = await parseApiResponse<QuestionnaireListItem[]>(activeRes);
    if (!body.success) return { ...empty, archived };
    const total = parsePaginationMeta(body.meta)?.total ?? body.data.length;
    return body.data.reduce<QuestionnaireStats>(
      (acc, q) => {
        if (q.status === 'launched') acc.launched += 1;
        else if (q.status === 'draft') acc.draft += 1;
        return acc;
      },
      { ...empty, total, archived }
    );
  } catch (err) {
    logger.error('questionnaires list page: stats fetch failed', err);
    return empty;
  }
}

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

/**
 * DEMO-ONLY (F2.5.1): active demo clients for the upload dialog's attribution picker.
 * Degrades to an empty list — the dialog then hides the picker entirely. Mirrors the
 * settings tab's loader.
 */
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
    logger.error('questionnaires list page: demo clients fetch failed', err);
    return [];
  }
}

export default async function QuestionnairesListPage() {
  const [{ items, meta }, stats, demoClientOptions] = await Promise.all([
    getQuestionnaires(),
    getQuestionnaireStats(),
    getActiveDemoClients(),
  ]);

  const statTiles: CqStat[] = [
    { label: 'Questionnaires', value: stats.total },
    { label: 'Launched', value: stats.launched, accent: true },
    { label: 'Drafts', value: stats.draft },
    { label: 'Deleted', value: stats.archived },
  ];

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
        <NewQuestionnaireMenu
          demoClientOptions={demoClientOptions}
          generativeAuthoringEnabled={true}
        />
      </header>

      <CqStatTiles stats={statTiles} />

      <DataSlotEmbeddingInfo />

      <QuestionnairesTable
        initialItems={items}
        initialMeta={meta}
        demoClientOptions={demoClientOptions}
        showDataSlots={true}
      />
    </div>
  );
}
