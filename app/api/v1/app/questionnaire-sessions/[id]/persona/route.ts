/**
 * Selectable interviewer persona — runtime read + choice (respondent surface).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/persona
 *   → { success: true, data: { persona: ResolvedSessionPersonas | null } }
 *   The no-login anonymous surface boots client-side, so (like the intro route) it fetches the
 *   resolved persona menu here on boot. The per-version `personaSelection.enabled` (inside the
 *   payload) is the gate the client honours.
 *
 * PATCH /api/v1/app/questionnaire-sessions/:id/persona   body: { personaKey: string | null }
 *   → { success: true, data: { selectedPersonaKey: string | null } }
 *   Persists the respondent's chosen interviewer on the session.
 *   422 when respondent switching isn't enabled for the version (no picker ⇒ a crafted request can't
 *   override the pinned persona) or when the key isn't one of the version's personas. `null` clears
 *   the choice (⇒ default applies), but only while switching is enabled.
 *
 * Both respondent kinds (authenticated owner OR a valid anonymous/preview `X-Session-Token`) via
 * `resolveTurnAccess`, exactly like the turn/transcript/intro routes. Inherits the standard 100/min
 * section cap — no per-flow sub-limiter needed.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { PERSONA_KEY_MAX_LENGTH } from '@/lib/app/questionnaire/types';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { resolveSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';

/** PATCH body: the chosen persona key, or `null` to clear the choice (default applies). */
const setPersonaSchema = z.object({
  personaKey: z.string().trim().min(1).max(PERSONA_KEY_MAX_LENGTH).nullable(),
});

async function handleGetPersona(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const persona = await resolveSessionPersonas(sessionId);
    log.info('Session persona menu read', { sessionId, enabled: persona?.enabled ?? false });
    return successResponse({ persona });
  } catch (err) {
    return handleAPIError(err);
  }
}

async function handleSetPersona(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const { personaKey } = await validateRequestBody(request, setPersonaSchema);

    // Respondent switching must be allowed for this version (built-in mode on AND `allowRespondentSwitch`
    // AND ≥2 personas — all folded into `resolved.enabled`). When it isn't, there's no picker, so a
    // crafted request can't override the pinned persona or clear a choice.
    const resolved = await resolveSessionPersonas(sessionId);
    if (!resolved?.enabled) {
      return errorResponse('Persona switching is not enabled for this questionnaire', {
        code: 'VALIDATION_ERROR',
        status: 422,
      });
    }

    // Validate against the resolved library so a crafted request can't pin a non-existent persona.
    if (personaKey !== null) {
      const known = resolved.personas.some((p) => p.key === personaKey);
      if (!known) {
        return errorResponse('Unknown persona', {
          code: 'VALIDATION_ERROR',
          status: 422,
        });
      }
    }

    await prisma.appQuestionnaireSession.update({
      where: { id: sessionId },
      data: { selectedPersonaKey: personaKey },
    });
    log.info('Session persona chosen', { sessionId, personaKey });
    return successResponse({ selectedPersonaKey: personaKey });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = handleGetPersona;
export const PATCH = handleSetPersona;
