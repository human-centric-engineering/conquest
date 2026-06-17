'use client';

/**
 * DataSlotEmbeddingStep — the explicit "Generate embeddings" control for adaptive data-slot
 * selection, shown on the Data slots tab when the feature is on. A thin wrapper over the shared
 * {@link EmbeddingCoverageStep} pointed at the data-slot embed endpoint.
 *
 * Adaptive data-slot selection ranks unfilled data slots by vector similarity to the conversation,
 * so every data slot needs an embedding. Without this the conversation targets data slots in a fixed
 * (topic-local) order. It's also a launch-gate requirement when the feature is on — the Review &
 * Launch checklist blocks launch until coverage is complete (the live turn loop embeds lazily as a
 * backstop, so preview still works).
 */

import { API } from '@/lib/api/endpoints';
import { EmbeddingCoverageStep } from '@/components/admin/questionnaires/embedding-coverage-step';

export function DataSlotEmbeddingStep({
  questionnaireId,
  versionId,
}: {
  questionnaireId: string;
  versionId: string;
}) {
  return (
    <EmbeddingCoverageStep
      questionnaireId={questionnaireId}
      versionId={versionId}
      busy={false}
      endpoint={API.APP.QUESTIONNAIRES.versionEmbedDataSlots}
      title="Adaptive data-slot selection needs embeddings"
      nounPlural="data slots"
      requirementNote="Required before launch while adaptive data-slot selection is on. Without embeddings, the conversation targets data slots in a fixed order. Re-generate after editing slot names or descriptions."
      emptyNote="Generate and save data slots first — there’s nothing to embed yet."
    />
  );
}
