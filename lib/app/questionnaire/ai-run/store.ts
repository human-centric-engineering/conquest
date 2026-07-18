/**
 * Persistence seam for {@link AppAiRun} — the durable record of an AI run that judged, verified,
 * or generated something an admin later relies on (F14.15).
 *
 * The pure vocabulary lives alongside this file in `types.ts`; this module owns every write.
 * It sits in `lib/` rather than the API tier because both tiers capture runs — the ingest and
 * advisor routes, and the learning-digest builder, which is itself a `lib/` module.
 *
 * ## Capture is best-effort, but never silent
 *
 * `recordAiRun` never throws. A provenance write must not fail the admin's actual action — losing
 * a questionnaire edit because its audit row wouldn't insert is a strictly worse outcome. But the
 * failure is logged at `error` with the run's identifying fields, so a capture gap is visible in
 * the logs rather than inferred later from an empty table. Callers that need to surface the miss
 * to a human should check the returned id for null (this is the mistake the turn-evaluation route
 * originally made: it swallowed the failure and rendered as though the write had succeeded).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { APP_VERSION } from '@/lib/app-version';
import {
  truncateSnapshot,
  type AppAiRunKind,
  type AppAiRunStatus,
  type AppAiRunSubject,
} from '@/lib/app/questionnaire/ai-run/types';

/** Everything a capturing surface hands the store to record one run. */
export interface RecordAiRunParams {
  subjectKind: AppAiRunSubject;
  subjectId: string;
  /** Version in scope, when the subject is version-scoped (drives the primary search index). */
  versionId?: string | null;
  kind: AppAiRunKind;
  status?: AppAiRunStatus;
  /** Resolved provider slug + model id that actually served the call (post-fallback). */
  provider: string;
  model: string;
  /** The fully interpolated prompt as sent, and the raw output as received. Both capped. */
  promptSnapshot?: unknown;
  outputSnapshot?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  /** Per-kind structured detail: critic verdicts, advisor suggestions, applied edit-ops. */
  detail?: unknown;
  /** Failure message when `status` is `failed`. */
  error?: string | null;
  /** The calling surface's prompt/rubric version constant, when it has one. */
  promptVersion?: string | null;
  /** The admin who triggered it; null for worker/background runs. */
  triggeredByUserId?: string | null;
}

/**
 * Record one AI run. Returns the new row id, or `null` when the write failed.
 *
 * Both snapshots are capped independently but share one `truncated` flag — the flag answers "is
 * anything here abridged", which is what a reader needs before quoting it.
 */
export async function recordAiRun(params: RecordAiRunParams): Promise<string | null> {
  try {
    const prompt = truncateSnapshot(params.promptSnapshot);
    const output = truncateSnapshot(params.outputSnapshot);

    const row = await prisma.appAiRun.create({
      data: {
        subjectKind: params.subjectKind,
        subjectId: params.subjectId,
        versionId: params.versionId ?? null,
        kind: params.kind,
        status: params.status ?? 'succeeded',
        provider: params.provider,
        model: params.model,
        // Our own serialisable shapes (already capped) — not external data.
        promptSnapshot: toJson(prompt.value),
        outputSnapshot: toJson(output.value),
        truncated: prompt.truncated || output.truncated,
        inputTokens: params.inputTokens ?? null,
        outputTokens: params.outputTokens ?? null,
        costUsd: params.costUsd ?? null,
        durationMs: params.durationMs ?? null,
        detail: toJson(params.detail),
        error: params.error ?? null,
        promptVersion: params.promptVersion ?? null,
        appVersion: APP_VERSION,
        triggeredByUserId: params.triggeredByUserId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // Deliberately swallowed: see the module header. Logged with enough context to identify
    // which surface lost its provenance without needing the caller's stack.
    logger.error('AI run provenance capture failed', {
      subjectKind: params.subjectKind,
      subjectId: params.subjectId,
      kind: params.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Map an optional value for a nullable Json column.
 *
 * Returns `undefined` for an absent value rather than `Prisma.DbNull`: on a create, an omitted
 * field is written as SQL NULL, which is what we want, and it keeps this module free of a direct
 * `@prisma/client` import (ESLint forbids one under `lib/app/**` — the extension surface stays
 * storage-agnostic).
 */
function toJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return value as T;
}
