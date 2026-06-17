'use client';

/**
 * EmbeddingCoverageStep — the shared "Generate embeddings" control behind both the question-slot
 * adaptive step (Settings tab) and the data-slot adaptive step (Data slots tab).
 *
 * Both features embed a set of rows (question slots / data slots) into a pgvector column so an
 * adaptive selector can rank by similarity. Nothing in the authoring flow generates them, so without
 * an explicit step an adaptive version silently falls back to a fixed order. This reads coverage
 * (`GET <endpoint>` → `{ total, embedded, missing }`) and generates (`POST <endpoint>`), then
 * refetches and `router.refresh()`es so the server-rendered launch checklist updates. Self-contained
 * (own fetch); the thin wrappers below supply the endpoint + the per-feature copy.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, CircleAlert, Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';

interface Coverage {
  total: number;
  embedded: number;
  missing: number;
}

export interface EmbeddingCoverageStepProps {
  questionnaireId: string;
  versionId: string;
  /** True while a sibling mutation is in flight — disables the generate button to avoid overlap. */
  busy: boolean;
  /** The embed endpoint (GET coverage + POST generate share the URL). */
  endpoint: (questionnaireId: string, versionId: string) => string;
  /** Heading, e.g. "Adaptive selection needs question embeddings". */
  title: string;
  /** Plural noun for coverage copy, e.g. "questions" / "data slots". */
  nounPlural: string;
  /** The explanatory sentence (why it's needed + when to re-generate). */
  requirementNote: string;
  /** The empty-state sentence shown when there's nothing to embed yet. */
  emptyNote: string;
}

export function EmbeddingCoverageStep({
  questionnaireId,
  versionId,
  busy,
  endpoint,
  title,
  nounPlural,
  requirementNote,
  emptyNote,
}: EmbeddingCoverageStepProps) {
  const router = useRouter();
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = endpoint(questionnaireId, versionId);

  const loadCoverage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      const parsed = await parseApiResponse<Coverage>(res);
      if (parsed.success) setCoverage(parsed.data);
      else setError(parsed.error.message);
    } catch {
      setError('Could not load embedding status.');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void loadCoverage();
  }, [loadCoverage]);

  const generate = (force: boolean) => {
    setGenerating(true);
    setError(null);
    // `force` re-embeds every row (used to refresh after edits); the default embeds only the rows
    // still missing an embedding.
    authoringMutate<Coverage>('POST', path, force ? { force: true } : {})
      .then(() => loadCoverage())
      .then(() => router.refresh()) // re-render the server-side launch checklist with new coverage
      .catch((err: unknown) =>
        setError(
          err instanceof AuthoringError || err instanceof Error
            ? err.message
            : 'Could not generate embeddings.'
        )
      )
      .finally(() => setGenerating(false));
  };

  const allEmbedded = coverage !== null && coverage.total > 0 && coverage.missing === 0;
  const noRows = coverage !== null && coverage.total === 0;

  return (
    <div className="space-y-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2.5 text-xs text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
      <div className="flex items-center gap-1.5 font-medium">
        <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {title}
      </div>

      {loading ? (
        <p className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Checking embedding status…
        </p>
      ) : noRows ? (
        <p>{emptyNote}</p>
      ) : allEmbedded ? (
        <p className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          All {coverage.total} {nounPlural} are embedded — ready for adaptive selection.
        </p>
      ) : (
        <p className="flex items-center gap-1.5">
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          {coverage ? `${coverage.embedded} of ${coverage.total}` : 'No'} {nounPlural} embedded
          {coverage && coverage.missing > 0 ? ` — ${coverage.missing} still need embedding.` : '.'}
        </p>
      )}

      <p className="text-blue-900/80 dark:text-blue-200/80">{requirementNote}</p>

      {error && <p className="text-destructive">{error}</p>}

      {!loading && !noRows && (
        <div className="pt-0.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || generating}
            // When fully embedded the only useful action is a forced re-embed (refresh after edits);
            // otherwise embed just the rows still missing one.
            onClick={() => generate(allEmbedded)}
          >
            {generating && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            {allEmbedded ? `Re-embed all ${nounPlural}` : 'Generate embeddings'}
          </Button>
        </div>
      )}
    </div>
  );
}
