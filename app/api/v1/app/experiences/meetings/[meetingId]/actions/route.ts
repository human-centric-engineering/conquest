/**
 * Facilitator actions on a live meeting (P15.5).
 *
 * POST /api/v1/app/experiences/meetings/:meetingId/actions
 *   body: { action: 'start' | 'start_breakout' | 'end_breakout' | 'close_breakout' | 'end' | 'synthesise', ... }
 *
 * One route rather than five, because these are all the same thing from the caller's side: the
 * facilitator pressing a button on the console. A refused transition returns 409 with the
 * machine-readable code from `lifecycle.ts`, so the console can say WHY rather than just failing.
 *
 * Admin-only. Running a meeting is an operator act.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { z } from 'zod';

import {
  buildMeetingLiveState,
  closeBreakout,
  endBreakout,
  endMeeting,
  startBreakout,
  startMeeting,
  synthesiseAndStore,
} from '@/app/api/v1/app/experiences/_lib/meeting-service';
import {
  BREAKOUT_MAX_DURATION_SECONDS,
  BREAKOUT_MIN_DURATION_SECONDS,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import type { TransitionDecision } from '@/lib/app/questionnaire/experiences/meeting/lifecycle';

type Params = { meetingId: string };

const actionSchema = z.object({
  action: z.enum([
    'start',
    'start_breakout',
    'end_breakout',
    'close_breakout',
    'end',
    'synthesise',
  ]),
  /** `start_breakout` only. */
  stepId: z.string().min(1).optional(),
  /**
   * `start_breakout` only — the facilitator's chosen length for THIS occurrence. Omit to use the
   * step's authored default; explicit null means untimed.
   */
  durationSeconds: z
    .number()
    .int()
    .min(BREAKOUT_MIN_DURATION_SECONDS)
    .max(BREAKOUT_MAX_DURATION_SECONDS)
    .nullable()
    .optional(),
});

const handleAction = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { meetingId } = await params;
  const body = await validateRequestBody(request, actionSchema);

  // Synthesising on demand is not a state transition — it is the facilitator asking for the
  // current picture before they decide to pull the room back.
  if (body.action === 'synthesise') {
    const result = await synthesiseAndStore(meetingId);
    log.info('Meeting synthesised on demand', { meetingId, ...result });
    return successResponse(result);
  }

  const decision: TransitionDecision = await (async (): Promise<TransitionDecision> => {
    switch (body.action) {
      case 'start':
        return startMeeting(meetingId);
      case 'start_breakout':
        if (!body.stepId) {
          return {
            ok: false as const,
            code: 'STEP_NOT_A_BREAKOUT' as const,
            message: 'Choose a breakout to run.',
          };
        }
        return startBreakout({
          meetingId,
          stepId: body.stepId,
          ...(body.durationSeconds !== undefined ? { durationSeconds: body.durationSeconds } : {}),
        });
      case 'end_breakout':
        return endBreakout(meetingId);
      case 'close_breakout':
        return closeBreakout(meetingId);
      case 'end':
        return endMeeting(meetingId);
      default:
        // Unreachable — the Zod enum and the cases above are the same set, and `synthesise`
        // returned earlier. Present so a new action added to the enum fails loudly here rather
        // than silently falling through to a success response.
        return {
          ok: false,
          code: 'MEETING_TERMINAL',
          message: 'Unsupported action.',
        };
    }
  })();

  if (!decision.ok) {
    log.info('Meeting action refused', { meetingId, action: body.action, code: decision.code });
    return errorResponse(decision.message, { code: decision.code, status: 409 });
  }

  log.info('Meeting action applied', { meetingId, action: body.action });
  return successResponse(await buildMeetingLiveState(meetingId));
});

export const POST = handleAction;
