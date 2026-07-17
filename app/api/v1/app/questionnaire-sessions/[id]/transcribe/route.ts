/**
 * Live respondent voice input — transcription (F6.2).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/transcribe
 *   multipart/form-data: audio (File, required) + language (ISO 639-1, optional)
 *   → { success: true, data: { text, durationMs, language? } }
 *
 * Turns a respondent's recorded audio into text via Sunrise's configured audio provider (OpenAI
 * Whisper) so the client can drop the transcript into the composer and send it through the normal
 * `/messages` text path. This endpoint is transcription-only — it does NOT run a turn, persist a
 * message, or stream; it mirrors the admin / embed transcribe routes, scoped to a respondent
 * session.
 *
 * Gate order: voice-input flag (404 before auth) → load session → access (authenticated owner OR a
 * valid anonymous session token) → status must be `active` → per-flow audio sub-cap → size guard →
 * multipart parse → audio validation → provider resolution → transcribe.
 *
 * Audit invariant: this handler MUST NOT persist audio bytes. The only DB write on the happy path
 * is the fire-and-forget `logCost(...)` for billing — the same invariant the admin transcribe route
 * enforces. Guarded by the retention regression tests in
 * `tests/integration/api/v1/app/questionnaire-sessions/transcribe-route.test.ts`.
 */

import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { audioLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { handleAPIError } from '@/lib/api/errors';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { enforceContentLengthCap } from '@/lib/validations/transcribe';

import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { validateAudioUpload } from '@/app/api/v1/app/questionnaire-sessions/_lib/audio-upload';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handleTranscribe(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // Light lookup — the transcribe path needs only identity + access + status, not the full turn
    // context the messages route loads.
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true, status: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    if (session.status !== 'active') {
      return errorResponse(`Session is ${session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    // Per-flow sub-cap for the paid Whisper path (Sunrise's shared audio limiter, 10/min). Keyed
    // under an `audio:qn:` namespace so respondent keys don't collide with the admin (`audio:user:`)
    // and embed (`audio:embed:`) callers on the same limiter instance.
    const limit = audioLimiter.check(`audio:qn:${access.rateKey}`);
    if (!limit.success) return createRateLimitResponse(limit);

    const oversize = enforceContentLengthCap(request);
    if (oversize) return oversize;

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('Expected multipart/form-data body', {
        code: 'INVALID_BODY',
        status: 400,
      });
    }

    const validation = validateAudioUpload(formData);
    if (!validation.ok) return validation.response;
    const { file, language } = validation.value;

    const audio = await getAudioProvider();
    if (!audio) {
      return errorResponse('No audio-capable provider is configured', {
        code: 'NO_AUDIO_PROVIDER',
        status: 503,
      });
    }

    try {
      const result = await audio.provider.transcribe(file, {
        model: audio.modelId,
        ...(language ? { language } : {}),
        mimeType: file.type,
        filename: file.name || 'audio.webm',
      });

      // Fire-and-forget: a billing-row failure must not fail an otherwise-successful transcript.
      // No `agentId` — a session isn't bound to a single agent; `sessionId` threads traceability.
      void logCost({
        model: audio.modelId,
        provider: audio.providerSlug,
        inputTokens: 0,
        outputTokens: 0,
        operation: 'transcription',
        durationMs: result.durationMs,
        metadata: { sessionId, ...(result.language ? { language: result.language } : {}) },
      });

      log.info('Respondent audio transcribed', {
        sessionId,
        userId: access.userId,
        provider: audio.providerSlug,
        model: audio.modelId,
        durationMs: result.durationMs,
        bytes: file.size,
      });

      return successResponse({
        text: result.text,
        durationMs: result.durationMs,
        ...(result.language ? { language: result.language } : {}),
      });
    } catch (err) {
      log.error('Respondent transcription failed', {
        sessionId,
        provider: audio.providerSlug,
        model: audio.modelId,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof ProviderError ? err.code : undefined,
      });
      return errorResponse('Transcription failed', {
        code: 'TRANSCRIPTION_FAILED',
        status: 502,
      });
    }
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleTranscribe;
