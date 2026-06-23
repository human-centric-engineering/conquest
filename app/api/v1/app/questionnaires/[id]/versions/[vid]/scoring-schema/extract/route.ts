/**
 * Scoring schema extraction — the upload path (report kind `cohort`, F14.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/scoring-schema/extract  (multipart: `file`)
 *   Admin-only. Parses an uploaded scoring document and runs the cohort-report agent to PROPOSE a
 *   scoring schema scoped to the version's available keys. Returns the proposal (does NOT persist —
 *   the admin reviews it in the builder and saves via PUT). Paid LLM work → per-admin sub-cap. Gated
 *   by the cohort-report flag.
 *
 * Pipeline: cohort-report flag-gate (404) → withAdminAuth → version scope → sub-cap → file guard →
 *   parseDocument → extract → return proposal.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { extractScoringSchema } from '@/lib/app/questionnaire/scoring/extract';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { parseUploadGuard } from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';

type Params = { id: string; vid: string };

const handleExtract = withAdminAuth<Params>(
  async (request: NextRequest, session, { params }: { params: Promise<Params> }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) throw new NotFoundError('Questionnaire version not found');

    // Paid LLM work — shares the cohort-report generate sub-cap class/window.
    const rl = cohortReportGenerateLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Scoring extract rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const guard = await parseUploadGuard(request);
    if (!guard.ok) return guard.response;

    let fullText: string;
    try {
      const buffer = Buffer.from(await guard.file.arrayBuffer());
      const parsed = await parseDocument(buffer, guard.file.name);
      fullText = parsed.fullText.trim();
    } catch (err) {
      log.warn('Scoring extract parse failed', {
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse('Could not read that document', { code: 'PARSE_FAILED', status: 422 });
    }
    if (fullText.length === 0) {
      return errorResponse('No text could be extracted from that document', {
        code: 'EMPTY_DOCUMENT',
        status: 422,
      });
    }

    let proposal;
    try {
      proposal = await extractScoringSchema(vid, fullText);
    } catch (err) {
      log.warn('Scoring extract failed', {
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse('Could not extract a scoring schema from that document', {
        code: 'EXTRACTION_FAILED',
        status: 502,
      });
    }

    logAdminAction({
      userId: adminId,
      action: 'app_scoring_schema.extract',
      entityType: 'app_questionnaire_version',
      entityId: vid,
      metadata: { scales: proposal.scales.length, items: proposal.items.length },
      clientIp,
    });
    log.info('Scoring schema extracted', { vid, scales: proposal.scales.length });
    return successResponse(proposal);
  }
);

export const POST = withCohortReportEnabled(handleExtract);
