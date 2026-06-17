'use client';

/**
 * AdaptiveEmbeddingStep (F4.1 surfacing) — the explicit "Generate embeddings" control shown under
 * the Selection strategy picker when a version uses the `adaptive` strategy. A thin wrapper over the
 * shared {@link EmbeddingCoverageStep} pointed at the question-slot embed endpoint.
 *
 * Adaptive ranks unanswered questions by vector similarity, so every question slot needs an
 * embedding. Without this an adaptive version silently falls back to sequential order. It's also a
 * launch-gate requirement — the Review & Launch checklist blocks launch until coverage is complete.
 */

import { API } from '@/lib/api/endpoints';
import { EmbeddingCoverageStep } from '@/components/admin/questionnaires/embedding-coverage-step';

export function AdaptiveEmbeddingStep({
  questionnaireId,
  versionId,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  /** True while a config mutation is in flight — disables the generate button to avoid overlap. */
  busy: boolean;
}) {
  return (
    <EmbeddingCoverageStep
      questionnaireId={questionnaireId}
      versionId={versionId}
      busy={busy}
      endpoint={API.APP.QUESTIONNAIRES.versionEmbedQuestions}
      title="Adaptive selection needs question embeddings"
      nounPlural="questions"
      requirementNote="Required before this version can be launched. Without embeddings, adaptive selection falls back to sequential order. Re-generate after editing question wording."
      emptyNote="Add questions to this version first — there’s nothing to embed yet."
    />
  );
}
