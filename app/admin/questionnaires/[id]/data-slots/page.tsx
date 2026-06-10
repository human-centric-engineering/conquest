import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DataSlotsReview } from '@/components/admin/questionnaires/data-slots-review';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isDataSlotsEnabled, isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { QuestionnaireDetail, VersionGraphView } from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots';

export const metadata: Metadata = {
  title: 'Data slots',
  description:
    'Generate and review the semantic data slots that abstract over a version’s questions.',
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

async function getDetail(id: string): Promise<QuestionnaireDetail | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('data slots page: detail fetch failed', err);
    return null;
  }
}

async function getGraph(id: string, versionId: string): Promise<VersionGraphView | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionGraph(id, versionId));
    if (!res.ok) return null;
    const body = await parseApiResponse<VersionGraphView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('data slots page: graph fetch failed', err);
    return null;
  }
}

async function getSlots(id: string, versionId: string): Promise<DataSlotView[]> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionDataSlots(id, versionId));
    if (!res.ok) return [];
    const body = await parseApiResponse<{ slots: DataSlotView[] }>(res);
    return body.success ? body.data.slots : [];
  } catch (err) {
    logger.error('data slots page: slots fetch failed', err);
    return [];
  }
}

export default async function DataSlotsPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();
  if (!(await isDataSlotsEnabled())) notFound();

  const { id } = await params;
  const { v } = await searchParams;

  const detail = await getDetail(id);
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === v) ?? detail.versions[0] ?? null;
  const [graph, slots] = selected
    ? await Promise.all([getGraph(id, selected.id), getSlots(id, selected.id)])
    : [null, []];

  const questions = graph
    ? graph.sections.flatMap((s) => s.questions.map((q) => ({ key: q.key, prompt: q.prompt })))
    : [];

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <Link href={`/admin/questionnaires/${id}`} className="hover:underline">
          {detail.title}
        </Link>
        {' / '}
        <span>Data slots</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Data slots</h1>
        <p className="text-muted-foreground text-sm">
          Data slots are the short, human targets the conversation aims to fill — each abstracts
          over one or more questions. Generate a set from this version’s questions, review them, and
          save. Launch requires data slots while the feature is on.
        </p>
      </header>

      {detail.versions.length === 0 || !selected ? (
        <p className="text-muted-foreground text-sm italic">This questionnaire has no versions.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b pb-3">
            {detail.versions.map((ver) => {
              const active = ver.id === selected.id;
              return (
                <Link
                  key={ver.id}
                  href={`/admin/questionnaires/${id}/data-slots?v=${ver.id}`}
                  scroll={false}
                  className={
                    active
                      ? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
                      : 'hover:bg-accent rounded-md border px-3 py-1.5 text-sm'
                  }
                >
                  v{ver.versionNumber}
                  <span className={active ? 'opacity-80' : 'text-muted-foreground'}>
                    {' '}
                    · {ver.status}
                  </span>
                </Link>
              );
            })}
          </div>

          {questions.length === 0 ? (
            <p className="text-muted-foreground text-sm italic">
              This version has no questions to abstract over yet.
            </p>
          ) : (
            <DataSlotsReview
              questionnaireId={id}
              versionId={selected.id}
              questions={questions}
              initialSlots={slots}
            />
          )}
        </>
      )}
    </div>
  );
}
