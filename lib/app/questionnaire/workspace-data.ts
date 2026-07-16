/**
 * Shared server-side data + flag resolution for the questionnaire admin
 * **workspace** (the tabbed `[id]/v/[vid]/…` surface).
 *
 * The workspace layout and each tab page both need the questionnaire detail and
 * (often) the selected version's graph. `serverFetch` is `cache: 'no-store'`, so
 * a naive layout-plus-page pair would issue duplicate HTTP calls every render.
 * Wrapping the fetchers in React `cache()` collapses them to one call per
 * (argument set) within a single request render pass — the layout fetches the
 * detail, the Overview/Structure page reuses it for free, and so on.
 *
 * Framework-agnostic boundary note: this file imports `serverFetch` through the
 * `@/lib/api` alias (not a `next/*` runtime import) and `cache` from `react`
 * (only `react-dom` is banned), so it is allowed under `lib/app/**`. It is still
 * server-only in practice — call it from server components / route handlers.
 */
import { cache } from 'react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots';
import type {
  EvaluationRunDetail,
  EvaluationSeed,
  QuestionnaireDetail,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';

/**
 * Questionnaire detail (title, status, versions list). `cache()`-wrapped so the
 * layout and the active tab share one fetch. Returns `null` on any failure — the
 * caller decides whether that is a `notFound()`.
 */
export const getQuestionnaireDetailCached = cache(
  async (id: string): Promise<QuestionnaireDetail | null> => {
    try {
      const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
      if (!res.ok) return null;
      const body = await parseApiResponse<QuestionnaireDetail>(res);
      return body.success ? body.data : null;
    } catch (err) {
      logger.error('workspace: questionnaire detail fetch failed', err);
      return null;
    }
  }
);

/**
 * Full structural graph for one version (sections, questions, goal, audience,
 * config). `cache()`-wrapped so tabs that both need the graph (Overview +
 * Structure) dedup. Returns `null` on any failure.
 */
export const getVersionGraphCached = cache(
  async (id: string, versionId: string): Promise<VersionGraphView | null> => {
    try {
      const res = await serverFetch(API.APP.QUESTIONNAIRES.versionGraph(id, versionId));
      if (!res.ok) return null;
      const body = await parseApiResponse<VersionGraphView>(res);
      return body.success ? body.data : null;
    } catch (err) {
      logger.error('workspace: version graph fetch failed', err);
      return null;
    }
  }
);

/**
 * How many data slots the selected version has — drives the launch gate and the
 * "Data slots" tab badge. `cache()`-wrapped; degrades to `0` on any failure.
 * Only meaningful when the data-slots flag is on (callers gate on that first).
 */
export const getVersionDataSlotCountCached = cache(
  async (id: string, versionId: string): Promise<number> => {
    try {
      const res = await serverFetch(API.APP.QUESTIONNAIRES.versionDataSlots(id, versionId));
      if (!res.ok) return 0;
      const body = await parseApiResponse<{ slots: DataSlotView[] }>(res);
      return body.success ? body.data.slots.length : 0;
    } catch (err) {
      logger.error('workspace: data slot count fetch failed', err);
      return 0;
    }
  }
);

/**
 * Question-slot embedding coverage for the selected version — `{ total, embedded, missing }`.
 * Drives the adaptive launch-gate check (the Overview "Questions embedded" row) and is only worth
 * fetching when the version actually uses the `adaptive` strategy. `cache()`-wrapped; degrades to a
 * fully-embedded-looking `{ total: 0, embedded: 0, missing: 0 }` on failure so a transient error
 * never wrongly blocks launch (the server re-checks on PATCH, which is the real gate).
 */
export const getVersionEmbeddingCoverageCached = cache(
  async (
    id: string,
    versionId: string
  ): Promise<{ total: number; embedded: number; missing: number }> => {
    try {
      const res = await serverFetch(API.APP.QUESTIONNAIRES.versionEmbedQuestions(id, versionId));
      if (!res.ok) return { total: 0, embedded: 0, missing: 0 };
      const body = await parseApiResponse<{ total: number; embedded: number; missing: number }>(
        res
      );
      return body.success ? body.data : { total: 0, embedded: 0, missing: 0 };
    } catch (err) {
      logger.error('workspace: embedding coverage fetch failed', err);
      return { total: 0, embedded: 0, missing: 0 };
    }
  }
);

/**
 * Data-slot embedding coverage for the selected version — `{ total, embedded, missing }`. Drives the
 * adaptive data-slot launch-gate check (the Overview "Data slots embedded" row); only worth fetching
 * when adaptive data-slot selection is on and the version has data slots. `cache()`-wrapped; degrades
 * to a fully-embedded-looking zero on failure so a transient error never wrongly blocks launch (the
 * server re-checks on PATCH, which is the real gate).
 */
export const getVersionDataSlotEmbeddingCoverageCached = cache(
  async (
    id: string,
    versionId: string
  ): Promise<{ total: number; embedded: number; missing: number }> => {
    try {
      const res = await serverFetch(API.APP.QUESTIONNAIRES.versionEmbedDataSlots(id, versionId));
      if (!res.ok) return { total: 0, embedded: 0, missing: 0 };
      const body = await parseApiResponse<{ total: number; embedded: number; missing: number }>(
        res
      );
      return body.success ? body.data : { total: 0, embedded: 0, missing: 0 };
    } catch (err) {
      logger.error('workspace: data-slot embedding coverage fetch failed', err);
      return { total: 0, embedded: 0, missing: 0 };
    }
  }
);

/**
 * Resolve the editor seed for an `add_question` finding deep-link (F5.3 "Open in editor").
 *
 * The structure page receives `?seedFinding=<runId>:<findingId>` from the review queue. This loads
 * the run detail (HTTP, admin-scoped), finds the finding, and — only when its effective op is a
 * still-actionable `add_question` draft — returns the {@link EvaluationSeed} the composer pre-fills.
 * Returns `null` on any miss (bad ref, finding gone, not an add_question, already terminal), so the
 * editor just opens normally. The caller gates on the design-eval flag before calling.
 */
export async function getEvaluationAddQuestionSeed(
  id: string,
  versionId: string,
  ref: string
): Promise<EvaluationSeed | null> {
  const sep = ref.indexOf(':');
  if (sep <= 0) return null;
  const runId = ref.slice(0, sep);
  const findingId = ref.slice(sep + 1);
  if (!runId || !findingId) return null;

  try {
    const res = await serverFetch(
      API.APP.QUESTIONNAIRES.versionEvaluationById(id, versionId, runId)
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<EvaluationRunDetail>(res);
    if (!body.success) return null;

    const finding = body.data.findings.find((f) => f.id === findingId);
    if (!finding || finding.status === 'applied' || finding.status === 'declined') return null;

    const op = finding.editedOverride ?? finding.proposedEdit;
    if (!op || op.op !== 'add_question') return null;

    return {
      runId,
      findingId,
      prompt: op.prompt,
      type: op.type,
      guidelines: op.guidelines ?? null,
      sectionKey:
        op.sectionKey ??
        (finding.targetKey.startsWith('section:')
          ? finding.targetKey.slice('section:'.length)
          : null),
    };
  } catch (err) {
    logger.error('workspace: evaluation seed fetch failed', err);
    return null;
  }
}
