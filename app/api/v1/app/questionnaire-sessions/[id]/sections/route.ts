/**
 * Sectioned interviews (P21) — read the section strip, and move between sections.
 *
 * GET  /api/v1/app/questionnaire-sessions/:id/sections   → the tab model
 * POST /api/v1/app/questionnaire-sessions/:id/sections   → body `{ action: 'open' | 'close', key }`
 *
 * Both are respondent-facing and authorised through `resolveTurnAccess` — an authenticated owner
 * OR a valid anonymous `X-Session-Token` — exactly as `/messages` and `/answers` are. `withAuth`
 * cannot serve the no-login surface, and a respondent who can answer a section can obviously read
 * and move between them.
 *
 * ## Why `close` re-asserts the gate
 *
 * The client already knows whether the control is unlocked; it was told by this same assessment on
 * the last turn. It re-asserts anyway, for the reason `/submit` re-asserts its own gate: a stale
 * client (the section widened under them) or a forged one must not be able to walk past a required
 * question. The client's copy is for drawing a button, never for deciding.
 *
 * ## Why there is no per-flow rate-limit sub-cap
 *
 * A single-row read and a single-row update, both cheap and neither spending an LLM call. They
 * inherit the platform's automatic 100/min section cap from `proxy.ts`, which is the documented
 * rule for exactly this shape of route.
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import {
  canOpenSection,
  closeSection,
  openSection,
  sectionEntry,
} from '@/lib/app/questionnaire/sections/run';
import { buildSectionStripView } from '@/lib/app/questionnaire/sections/view';

const bodySchema = z.object({
  action: z.enum(['open', 'close']),
  key: z.string().trim().min(1).max(512),
  /**
   * Who asked for the close, when it was not the respondent's own control: `agent_offer` is the
   * surface keeping the promise the interviewer's reply just made ("I'll take us on to X").
   *
   * An audit label on the run, never a gate — the close is assessed identically either way, so a
   * forged value costs nothing but a wrong word on an admin timeline. It is accepted from the
   * client because the client is the only party that knows whether the move followed the
   * announcement or the button; the server sees one POST in both cases. `cap` still wins over it,
   * because a turn budget releasing a section is the more important fact about that close.
   */
  reason: z.literal('agent_offer').optional(),
});

/** Load the session, check access, and resolve this turn's section state. */
type SectionContext =
  | { error: Response; loaded?: undefined }
  | { error?: undefined; loaded: NonNullable<Awaited<ReturnType<typeof buildTurnContext>>> };

async function loadSectionContext(
  request: NextRequest,
  sessionId: string
): Promise<SectionContext> {
  const loaded = await buildTurnContext(sessionId);
  if (!loaded) {
    return { error: errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 }) };
  }
  const access = await resolveTurnAccess(request, loaded.session);
  if (!access.ok) {
    return { error: errorResponse(access.message, { code: access.code, status: access.status }) };
  }
  return { loaded };
}

async function handleGet(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: sessionId } = await context.params;
    const resolved = await loadSectionContext(request, sessionId);
    if (resolved.error) return resolved.error;

    // Deliberately NOT status-gated. A paused or completed session still has a section strip to
    // draw, exactly as `/answers` still returns its answers — the same reasoning, and the same
    // absence of a gate.
    const settings = resolved.loaded.base.config.sections;
    return successResponse(
      buildSectionStripView(resolved.loaded.sectionState, {
        showLocked: settings.showLockedSections,
        navigation: settings.navigation,
        canGrow: resolved.loaded.base.config.conditionalTopics.enabled,
      })
    );
  } catch (error) {
    return handleAPIError(error);
  }
}

async function handlePost(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const resolved = await loadSectionContext(request, sessionId);
    if (resolved.error) return resolved.error;
    const { loaded } = resolved;

    // Moving between sections changes what the interview will ask next, so it is a write on a live
    // conversation and takes the same status gate `/messages` takes.
    if (loaded.session.status !== 'active') {
      return errorResponse(`Session is ${loaded.session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    const body = await validateRequestBody(request, bodySchema);
    const state = loaded.sectionState;

    if (!state.active || state.run === null) {
      return errorResponse('This questionnaire is not run in sections', {
        code: 'NOT_SECTIONED',
        status: 409,
      });
    }

    const target = state.sections.find((section) => section.key === body.key);
    if (!target || !sectionEntry(state.run, body.key)) {
      return errorResponse('Section not found', { code: 'SECTION_NOT_FOUND', status: 404 });
    }

    const settings = loaded.base.config.sections;
    // The turn ordinal this move happened at. `selectionRound` is the true count of turns already
    // taken, so a section opened now starts at the next one.
    const atTurn = loaded.base.selectionRound;

    let run = state.run;

    if (body.action === 'open') {
      if (!canOpenSection(run, state.sections, body.key, settings.navigation)) {
        return errorResponse('That section is not available yet', {
          code: 'SECTION_LOCKED',
          status: 409,
        });
      }
      run = openSection(run, body.key, atTurn);
    } else {
      // Re-asserted server-side. The gate on `loaded.sectionState.close` is for the ACTIVE section,
      // so a close aimed at any other section is refused outright rather than assessed against the
      // wrong one: closing a section you are not in is not a move the surface offers.
      if (state.activeSection?.key !== body.key) {
        return errorResponse('You can only finish the section you are in', {
          code: 'SECTION_NOT_ACTIVE',
          status: 409,
        });
      }
      if (!state.close?.canClose) {
        return errorResponse(
          state.close?.blockedOnRequired
            ? 'There is still something needed in this section'
            : 'This section is not finished yet',
          {
            code: state.close?.blockedOnRequired ? 'SECTION_BLOCKED' : 'SECTION_NOT_READY',
            status: 409,
          }
        );
      }
      run = closeSection(
        run,
        body.key,
        atTurn,
        // `cap` records that the turn budget released it rather than the respondent satisfying the
        // bars, which is a materially different thing to read off a session timeline later, and it
        // outranks the client's own account of who asked for the move.
        state.close.assessment.capReached ? 'cap' : (body.reason ?? 'respondent'),
        state.sections
      );
    }

    await prisma.appQuestionnaireSession.update({
      where: { id: sessionId },
      data: { sectionRun: jsonInput(run) },
    });

    log.info('Section move', {
      sessionId,
      action: body.action,
      key: body.key,
      activeKey: run.activeKey,
      ...(body.reason ? { reason: body.reason } : {}),
    });

    return successResponse(
      buildSectionStripView(
        {
          ...state,
          run,
          activeSection: state.sections.find((section) => section.key === run.activeKey) ?? null,
          // The strip is redrawn from the new run; the close gate belongs to the section that was
          // just left, so it is dropped rather than reported against the new one. The client refetches
          // it with the next turn, which is also when it becomes true.
          close: null,
        },
        {
          showLocked: settings.showLockedSections,
          navigation: settings.navigation,
          canGrow: resolved.loaded.base.config.conditionalTopics.enabled,
        }
      )
    );
  } catch (error) {
    return handleAPIError(error);
  }
}

export const GET = handleGet;
export const POST = handlePost;
