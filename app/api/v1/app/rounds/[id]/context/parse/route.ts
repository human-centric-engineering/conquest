/**
 * Round Additional Context — document parse endpoint (round Additional Context, phase 3).
 *
 * POST /api/v1/app/rounds/:id/context/parse  (multipart: `file`)
 *   Admin-only. Extracts plain text from an uploaded document (.pdf / .docx / .md / .txt) so the
 *   admin can use it as briefing content (or feed it to AI-suggest). Returns the extracted text,
 *   trimmed and capped — it does NOT persist; the admin reviews, edits, and saves it via create. No
 *   LLM call: a pure parse, reusing the intro-background upload guard + the knowledge-base parser.
 *
 * Pipeline: withAdminAuth → per-admin sub-cap → file guard → parseDocument.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { parseUploadGuard } from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';

/** Briefing content cap (matches the create schema's CONTENT max) so parsed text fits one entry. */
const BRIEFING_PARSE_MAX = 5_000;

const handleParse = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;

  // Reuse the ingestion sub-cap — a document parse is the same class of expensive admin upload.
  const rl = ingestLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Round-context parse rate limit exceeded', { adminId, reset: rl.reset });
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
    log.warn('Round-context parse failed', {
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

  log.info('Round-context document parsed', { adminId, chars: trimmed.length, clientIp });
  return successResponse({ text: trimmed.slice(0, BRIEFING_PARSE_MAX) });
});

export const POST = handleParse;
