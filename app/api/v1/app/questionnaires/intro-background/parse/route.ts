/**
 * Intro-background document parse endpoint (F12.2).
 *
 * POST /api/v1/app/questionnaires/intro-background/parse  (multipart: `file`)
 *   Admin-only. Extracts plain text from an uploaded document (.pdf / .docx / .md / .txt) so the
 *   admin can use it as the respondent intro "about this questionnaire" background. Returns the
 *   extracted text (trimmed, capped to the intro length) — it does NOT persist; the admin reviews,
 *   edits, and saves it via the config / cohort PATCH. No LLM call: a pure parse.
 *
 * Pipeline: withAdminAuth → per-admin sub-cap → file guard → parseDocument → cap.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { parseUploadGuard } from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';

const handleParse = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;

  // Reuse the ingestion sub-cap — a document parse is the same class of expensive admin upload.
  const rl = ingestLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Intro-background parse rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const guard = await parseUploadGuard(request);
  if (!guard.ok) return guard.response;
  const { file } = guard;

  let fullText: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await parseDocument(buffer, file.name);
    fullText = parsed.fullText;
  } catch (err) {
    log.warn('Intro-background parse failed', {
      adminId,
      fileName: file.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Could not read that document', { code: 'PARSE_FAILED', status: 422 });
  }

  const trimmed = fullText.trim();
  if (trimmed.length === 0) {
    return errorResponse('No text could be extracted from that document', {
      code: 'EMPTY_DOCUMENT',
      status: 422,
    });
  }

  const text = trimmed.slice(0, INTRO_BACKGROUND_MAX_LENGTH);
  log.info('Intro-background document parsed', {
    adminId,
    fileName: file.name,
    chars: text.length,
    truncated: trimmed.length > text.length,
    clientIp,
  });

  return successResponse({ text, truncated: trimmed.length > text.length });
});

export const POST = handleParse;
