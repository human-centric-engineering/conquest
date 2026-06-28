/**
 * Questionnaire **definition** import (F14.9).
 *
 * POST /api/v1/app/questionnaires/import   body: a definition export envelope (JSON)
 *   Admin-only. Parses + validates an exported definition file and persists it as a **brand-new**
 *   questionnaire (v1 draft) owned by the importer — never touching any existing questionnaire. The
 *   counterpart of `GET …/versions/:vid/definition`. After commit it regenerates question +
 *   data-slot embeddings (best-effort; they also self-heal lazily at runtime).
 *
 * Per-admin `ingestLimiter` sub-cap — each import writes a whole graph. Master-flag-gated.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { parseDefinitionImport } from '@/lib/app/questionnaire/authoring';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { persistDefinitionImport } from '@/app/api/v1/app/questionnaires/_lib/import-definition';
import { embedVersionSlots } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { embedVersionDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';

/** Max import payload — a definition is small; anything larger is almost certainly the wrong file. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

const handleImport = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;

  // Per-admin sub-cap — each import writes a whole graph. The 100/min `api` section cap was already
  // applied by the middleware.
  const rl = ingestLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Questionnaire import rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const text = await request.text();
  if (text.length > MAX_IMPORT_BYTES) {
    return errorResponse('That file is too large to be a questionnaire definition.', {
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  }

  // External-data boundary: parse + Zod-validate the file before any of it reaches the persister.
  let envelope;
  try {
    envelope = parseDefinitionImport(text);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Could not read that file.', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  const result = await persistDefinitionImport({ envelope, adminId });

  // Regenerate embeddings for the new version (best-effort — an unconfigured embedder must not fail
  // the import; question/data-slot vectors also self-heal lazily at runtime).
  try {
    await embedVersionSlots(result.versionId);
    await embedVersionDataSlots(result.versionId);
  } catch (err) {
    logger.warn('Questionnaire import: embedding regeneration failed (will self-heal lazily)', {
      versionId: result.versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logAdminAction({
    userId: adminId,
    action: 'questionnaire.import',
    entityType: 'questionnaire',
    entityId: result.questionnaireId,
    metadata: {
      versionId: result.versionId,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      dataSlotCount: result.dataSlotCount,
    },
    clientIp,
  });

  log.info('Questionnaire definition imported', {
    questionnaireId: result.questionnaireId,
    versionId: result.versionId,
    sectionCount: result.sectionCount,
    questionCount: result.questionCount,
  });

  return successResponse(result, undefined, { status: 201 });
});

export const POST = withQuestionnairesEnabled(handleImport);
