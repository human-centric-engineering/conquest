/**
 * Data slots tab — generate / review the semantic abstraction layer for a version.
 *
 * Lifted into the workspace (header + version selector come from the layout).
 * Reads `vid` from the path.
 */
import type { Metadata } from 'next';

import { DataSlotsReview } from '@/components/admin/questionnaires/data-slots-review';
import { DataSlotEmbeddingStep } from '@/components/admin/questionnaires/data-slot-embedding-step';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getVersionGraphCached } from '@/lib/app/questionnaire/workspace-data';
import type { DataSlotView, DataSlotDraftView } from '@/lib/app/questionnaire/data-slots';

export const metadata: Metadata = {
  title: 'Data slots · Questionnaire',
  description:
    'Generate and review the semantic data slots that abstract over a version’s questions.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

interface LoadedSlots {
  slots: DataSlotView[];
  draft: DataSlotDraftView | null;
}

async function getSlots(id: string, versionId: string): Promise<LoadedSlots> {
  const empty: LoadedSlots = { slots: [], draft: null };
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionDataSlots(id, versionId));
    if (!res.ok) return empty;
    const body = await parseApiResponse<LoadedSlots>(res);
    return body.success ? { slots: body.data.slots, draft: body.data.draft } : empty;
  } catch (err) {
    logger.error('data slots tab: slots fetch failed', err);
    return empty;
  }
}

export default async function DataSlotsTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [graph, loaded] = await Promise.all([getVersionGraphCached(id, vid), getSlots(id, vid)]);

  const questions = graph
    ? graph.sections.flatMap((s) => s.questions.map((q) => ({ key: q.key, prompt: q.prompt })))
    : [];

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Data slots are the short, human targets the conversation aims to fill — each abstracts over
        one or more questions. Generate a set, review them, and save. Launch requires data slots
        while the feature is on.
      </p>

      {questions.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          This version has no questions to abstract over yet.
        </p>
      ) : (
        <DataSlotsReview
          questionnaireId={id}
          versionId={vid}
          questions={questions}
          initialSlots={loaded.slots}
          initialDraft={loaded.draft}
        />
      )}

      {/* Adaptive data-slot selection (50+-slot scale): the explicit embedding step + coverage.
          Embeddings rank unfilled slots by similarity so the conversation flows naturally rather
          than following a fixed order. */}
      {loaded.slots.length > 0 && <DataSlotEmbeddingStep questionnaireId={id} versionId={vid} />}
    </div>
  );
}
