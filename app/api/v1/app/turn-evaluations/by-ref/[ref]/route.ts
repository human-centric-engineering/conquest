/**
 * Look a chat up by its support reference.
 *
 * GET /api/v1/app/turn-evaluations/by-ref/:ref
 *   Admin-only. Resolves a respondent-quoted reference (forgivingly
 *   normalised) to its session and that session's turns — each annotated with whether a saved
 *   inspector dump is present (so it can be re-evaluated) and how many verdicts it already has.
 *   404 when no session matches the reference. Read-only; the read model lives in
 *   `_lib/turn-evaluation-list.ts`.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { lookupSessionByRef } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list';

const handleLookup = withAdminAuth<{ ref: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { ref } = await params;

  const result = await lookupSessionByRef(ref);
  if (!result) {
    return errorResponse('No chat found for that reference', { code: 'NOT_FOUND', status: 404 });
  }

  log.info('Chat looked up by ref', {
    sessionId: result.session.id,
    turns: result.turns.length,
  });
  return successResponse(result);
});

export const GET = handleLookup;
