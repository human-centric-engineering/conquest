/**
 * Route gate for the respondent-report admin surfaces: master questionnaires flag → respondent-report
 * flag → handler. Shared by the "re-run report" routes (revisions list/enqueue, detail, promote) so the
 * two-flag gate is declared once. Mirrors `withQuestionnairesEnabled` / `withLiveSessionsEnabled`.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG } from '@/lib/app/questionnaire/constants';

/** Wrap an admin handler so it 404s unless BOTH the master and respondent-report flags are on. */
export function withRespondentReportEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return withQuestionnairesEnabled<C>(async (request, context) => {
    const enabled = await isFeatureEnabled(APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG);
    if (!enabled) return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
    return handler(request, context);
  });
}
