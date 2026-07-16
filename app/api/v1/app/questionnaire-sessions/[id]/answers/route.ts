/**
 * Answer-slot panel state — respondent read (F7.2) + form-mode write (P-presentation).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/answers[?view=form]
 *   → { success: true, data: AnswerPanelView }
 * PUT /api/v1/app/questionnaire-sessions/:id/answers
 *   { answers: [{ questionKey, value?, clear? }] }
 *   → { success: true, data: AnswerPanelView }   (the refreshed form view)
 *
 * GET is the data source for the live answer panel beside the chat. `?view=form`
 * returns the full question structure (every question, answered or not) regardless of
 * `answerSlotPanelScope`, and never the data-slot abstraction — the raw form surface
 * edits the underlying questions directly.
 *
 * PUT persists answers the respondent sets themselves in form view. It serves the same
 * two respondent kinds as the turn route, so it reuses `resolveTurnAccess` (an
 * authenticated owner OR a valid anonymous/preview `X-Session-Token`). Unlike GET it
 * gates on status — only an `active` session accepts writes (editing a submitted
 * session would desync the deliverable). Each value is validated against its question's
 * type/typeConfig via `validateAnswerValue` (the same check the per-turn extractor uses)
 * before any write; a malformed value rejects the whole batch (no partial writes).
 *
 * Recording: a fresh answer is `direct`; an edit of an existing one appends a `manual`
 * refinement-history entry and flips the answer to `refined` + `respondentEdited`, the
 * authoritative guard the per-turn pipeline honours.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { validateAnswerValue } from '@/lib/app/questionnaire/extraction/answer-value';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';
import {
  loadSessionForFormWrite,
  loadVersionSlotsByKey,
  recordManualAnswer,
  clearAnswer,
  reconcileDataSlotFills,
  type ManualAnswerOutcome,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/form-answers';

async function handleGetAnswers(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // `?view=form` (P-presentation): the raw form surface needs the full question structure
    // (every question, answered or not) regardless of `answerSlotPanelScope`, and never the
    // data-slot abstraction — the form edits the underlying questions directly.
    const forForm = new URL(request.url).searchParams.get('view') === 'form';

    // Data Slots feature: render the data-slot panel (the loader only switches if the version
    // actually has data slots).
    const loaded = await loadAnswerPanelState(sessionId, true, forForm);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    log.info('Answer panel read', {
      sessionId,
      forForm,
      answeredCount: loaded.view.answeredCount,
      totalCount: loaded.view.totalCount,
    });

    return successResponse(loaded.view);
  } catch (err) {
    return handleAPIError(err);
  }
}

/** One form answer to write: set `value`, or `clear` to unset. */
const formAnswerEntrySchema = z
  .object({
    questionKey: z.string().trim().min(1),
    value: z.unknown().optional(),
    clear: z.boolean().optional(),
  })
  .refine((e) => e.clear === true || e.value !== undefined, {
    message: 'Each entry must carry a value or set clear: true',
  });

/** Form-mode write body: a non-empty, bounded batch of answer writes. */
const putAnswersSchema = z.object({
  answers: z.array(formAnswerEntrySchema).min(1).max(200),
});

async function handlePutAnswers(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // Load just the access + gate fields (no panel projection needed for a write).
    const session = await loadSessionForFormWrite(sessionId);
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: authenticated owner OR valid anonymous/preview session token (same as GET/turn).
    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Status gate: only an active session accepts edits. Editing a paused/completed/abandoned
    // session would desync the deliverable, so reject with 409.
    if (session.status !== 'active') {
      return errorResponse('This session is not active', {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    const parsed = putAnswersSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse('Invalid request body', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: parsed.error.issues },
      });
    }
    const { answers } = parsed.data;

    // Resolve every addressed key to its slot in ONE query; reject unknown keys.
    const keys = answers.map((a) => a.questionKey);
    const slots = await loadVersionSlotsByKey(session.versionId, keys);
    const unknownKey = keys.find((k) => !slots.has(k));
    if (unknownKey !== undefined) {
      return errorResponse(`Unknown question key "${unknownKey}"`, {
        code: 'UNKNOWN_QUESTION',
        status: 400,
      });
    }

    // Validate ALL set-values up front (no partial writes). A clear skips value validation.
    // Build the normalised write list so the transaction does no validation work.
    const writes: Array<
      | { kind: 'set'; questionKey: string; slotId: string; value: unknown }
      | { kind: 'clear'; questionKey: string; slotId: string }
    > = [];
    for (const entry of answers) {
      const slot = slots.get(entry.questionKey)!;
      if (entry.clear === true) {
        writes.push({ kind: 'clear', questionKey: entry.questionKey, slotId: slot.id });
        continue;
      }
      const check = validateAnswerValue(slot.type, entry.value, slot.typeConfig);
      if (!check.ok) {
        return errorResponse(`Invalid value for "${entry.questionKey}": ${check.issue}`, {
          code: 'INVALID_ANSWER_VALUE',
          status: 400,
          details: { questionKey: entry.questionKey, issue: check.issue },
        });
      }
      writes.push({
        kind: 'set',
        questionKey: entry.questionKey,
        slotId: slot.id,
        value: check.value,
      });
    }

    // Persist atomically: all reads + writes share one transaction.
    const outcomes = await prisma.$transaction(async (tx) => {
      const results: Array<{ questionKey: string; outcome: ManualAnswerOutcome | 'cleared' }> = [];
      for (const w of writes) {
        if (w.kind === 'clear') {
          await clearAnswer(tx, sessionId, w.slotId);
          results.push({ questionKey: w.questionKey, outcome: 'cleared' });
        } else {
          const outcome = await recordManualAnswer(tx, sessionId, w.slotId, w.value);
          results.push({ questionKey: w.questionKey, outcome });
        }
      }
      // Data Slots feature: keep the chat-facing data-slot fills in sync with form edits in the
      // same transaction, so a form change is reflected in the data-slot panel immediately rather
      // than only on the next chat turn.
      await reconcileDataSlotFills(
        tx,
        sessionId,
        writes.map((w) => w.slotId)
      );
      return results;
    });

    log.info('Form answers written', {
      sessionId,
      count: outcomes.length,
      created: outcomes.filter((o) => o.outcome === 'created').length,
      edited: outcomes.filter((o) => o.outcome === 'edited').length,
      cleared: outcomes.filter((o) => o.outcome === 'cleared').length,
    });

    // Return the refreshed form view so the client picks up new provenance/history in one trip.
    const refreshed = await loadAnswerPanelState(sessionId, false, true);
    if (!refreshed) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
    return successResponse(refreshed.view);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = handleGetAnswers;
export const PUT = handlePutAnswers;
