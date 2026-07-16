/**
 * Route gate for the respondent-report admin surfaces. The ConQuest questionnaire
 * feature flags have been retired — every questionnaire feature is now permanently
 * on — so this is a passthrough (auth still runs inside the wrapped handler). Kept
 * so the "re-run report" routes (revisions list/enqueue, detail, promote) need no
 * change; unwound with the rest of the flag call sites.
 */

import type { NextRequest } from 'next/server';

export function withRespondentReportEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return handler;
}
