/**
 * GET /api/v1/app/questionnaires/workflows/:slug
 *
 * Admin-only, flag-gated. Returns one pipeline diagram (the raw platform
 * `WorkflowDefinition` — the client runs the pure mapper itself) enriched with
 * live per-node detail: the agent binding + best-effort resolved model, the
 * exact prompt messages from the catalog, and each capability's name. When a
 * `?versionId=` lens is supplied, the workflow's applicability to that version
 * is attached. 404s on an unknown slug. Read-only; persists nothing.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { enrichWorkflow } from '@/lib/app/questionnaire/workflows/enrich';
import {
  buildApplicabilityContext,
  evaluateApplicability,
} from '@/lib/app/questionnaire/workflows/applicability';

const versionIdSchema = z.string().min(1).max(64);

const handleGet = withAdminAuth<{ slug: string }>(
  async (request: NextRequest, _session, { params }) => {
    const { slug } = await params;

    // Resolve the optional version lens first so we can attach applicability.
    const rawVersionId = request.nextUrl.searchParams.get('versionId');
    const parsed = rawVersionId ? versionIdSchema.safeParse(rawVersionId) : null;
    let applicability;
    if (parsed?.success) {
      const ctx = await buildApplicabilityContext(parsed.data);
      if (ctx) applicability = evaluateApplicability(ctx)[slug];
    }

    const detail = await enrichWorkflow(slug, applicability);
    if (!detail) {
      return errorResponse('Workflow not found', { code: 'NOT_FOUND', status: 404 });
    }

    logger.info('workflow visualizer: served detail', {
      slug,
      steps: detail.definition.steps.length,
      lensApplied: Boolean(applicability),
    });

    return successResponse({ workflow: detail });
  }
);

export const GET = handleGet;
