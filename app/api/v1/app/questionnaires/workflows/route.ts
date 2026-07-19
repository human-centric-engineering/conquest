/**
 * GET /api/v1/app/questionnaires/workflows
 *
 * Admin-only. Returns the read-only "Behind the Scenes" workflow
 * diagrams as lightweight summaries for the picker. When a `?versionId=` lens is
 * supplied, each summary is annotated with its applicability to that version
 * (applies / inactive / unavailable). Read-only: computes from the in-code
 * registry + resolved config; persists nothing.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { listWorkflowSummaries } from '@/lib/app/questionnaire/workflows/registry';
import {
  buildApplicabilityContext,
  evaluateApplicability,
} from '@/lib/app/questionnaire/workflows/applicability';

const versionIdSchema = z.string().min(1).max(64);

const handleGet = withAdminAuth(async (request: NextRequest) => {
  const summaries = listWorkflowSummaries();

  const rawVersionId = request.nextUrl.searchParams.get('versionId');
  const parsed = rawVersionId ? versionIdSchema.safeParse(rawVersionId) : null;
  let lensApplied = false;

  if (parsed?.success) {
    const ctx = await buildApplicabilityContext(parsed.data);
    if (ctx) {
      const map = evaluateApplicability(ctx);
      for (const summary of summaries) {
        summary.applicability = map[summary.slug];
      }
      lensApplied = true;
    }
  }

  logger.info('workflow visualizer: served summaries', {
    count: summaries.length,
    lensApplied,
  });

  return successResponse({ workflows: summaries });
});

export const GET = handleGet;
