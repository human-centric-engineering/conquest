/**
 * Integration test: live respondent transcribe route (F6.2).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/transcribe
 *
 * The audio provider, cost logger, rate limiter, and session token verify are mocked, but the
 * REAL access resolver, audio-upload validator, and content-length guard run — so this pins the
 * route's wiring: gate order (flag → session → access → status → audio sub-cap → size guard →
 * multipart → validation → provider), the response shape, the `'transcription'` cost-log call,
 * and the audit invariant that no audio bytes (or transcript) are ever persisted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

// The real resolveTurnAccess runs; stub only the token verify so the anonymous-path tests aren't
// coupled to the HMAC crypto (session-access-token.test.ts covers that directly).
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    // Models the route MUST NOT touch — wired so the retention regression test can assert they
    // were never called. If a future contributor persists audio / the transcript, these trip.
    appQuestionnaireTurn: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    appAnswerSlot: { create: vi.fn(), update: vi.fn(), upsert: vi.fn(), createMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  audioLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getAudioProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/transcribe/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG } from '@/lib/app/questionnaire/constants';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { audioLimiter } from '@/lib/security/rate-limit';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { assertNoAudioPersistence } from '@/tests/helpers/no-audio-persistence';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/transcribe';
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function setSession(over: Record<string, unknown> = {}): void {
  vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue({
    id: 'sess-1',
    respondentUserId: USER,
    status: 'active',
    ...over,
  } as never);
}

function makeAudioFormData({
  audio = new File([new Uint8Array([1, 2, 3, 4])], 'voice.webm', { type: 'audio/webm' }),
  language,
}: { audio?: File | string | null; language?: string } = {}): FormData {
  const fd = new FormData();
  if (audio !== null) fd.set('audio', audio as Blob | string);
  if (language !== undefined) fd.set('language', language);
  return fd;
}

function req(formData: FormData, headers: Record<string, string> = {}): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(headers),
    formData: () => Promise.resolve(formData),
    url: URL,
  } as unknown as NextRequest;
}

function audioResolution() {
  return {
    provider: { transcribe: vi.fn() },
    modelId: 'whisper-1',
    providerSlug: 'openai',
  };
}

/** Resolution whose transcribe succeeds with the given result. */
function resolveTranscribe(result: Record<string, unknown>) {
  const audio = audioResolution();
  audio.provider.transcribe.mockResolvedValue({ model: 'whisper-1', ...result });
  vi.mocked(getAudioProvider).mockResolvedValue(audio as never);
  return audio;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/**
 * Assert a full Sunrise error envelope: the HTTP status, `success: false`, and `error.code`.
 * Pinning `success` (not just `error.code`) keeps the outer envelope from drifting silently.
 */
async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = await parseJson<{ success: false; error: { code: string } }>(res);
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true); // master + voice sub-flag on
  setAuth(mockAuthenticatedUser());
  setSession();
  vi.mocked(audioLimiter.check).mockReturnValue({ success: true } as never);
  resolveTranscribe({ text: 'hello world', durationMs: 2500 });
});

describe('gate order', () => {
  it('404s when the voice-input flag is off, before auth or DB lookup', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(404);
    expect(prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('404s when live-sessions is off even though voice is on (voice depends on the live surface)', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag !== APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG)
    );
    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(404);
    expect(prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(prisma.appQuestionnaireSession.findUnique).mockResolvedValue(null);
    expect((await POST(req(makeAudioFormData()), ctx)).status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(makeAudioFormData()), ctx)).status).toBe(401);
  });

  it('403s when the session belongs to another respondent', async () => {
    setSession({ respondentUserId: 'someone-else' });
    expect((await POST(req(makeAudioFormData()), ctx)).status).toBe(403);
  });

  it('409s when the session is not active', async () => {
    setSession({ status: 'paused' });
    const res = await POST(req(makeAudioFormData()), ctx);
    await expectError(res, 409, 'SESSION_NOT_ACTIVE');
  });

  it('429s when the audio sub-cap is exceeded, and never calls the provider', async () => {
    vi.mocked(audioLimiter.check).mockReturnValue({ success: false } as never);
    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(429);
    expect(getAudioProvider).not.toHaveBeenCalled();
  });

  it('keys the audio limiter under the namespaced `audio:qn:` prefix', async () => {
    await POST(req(makeAudioFormData()), ctx);
    const key = vi.mocked(audioLimiter.check).mock.calls.at(-1)?.[0];
    expect(key).toMatch(/^audio:qn:/);
  });
});

describe('anonymous (no-login) access', () => {
  beforeEach(() => {
    setAuth(null); // no cookie session
    setSession({ respondentUserId: null });
  });

  it('grants a session-token-bearing anonymous caller', async () => {
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    const res = await POST(req(makeAudioFormData(), { 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
  });

  it('401s an anonymous caller with an invalid token, never calling the provider', async () => {
    tokenMock.verifySessionToken.mockReturnValue({ ok: false, reason: 'bad_signature' });
    const res = await POST(req(makeAudioFormData(), { 'x-session-token': 'bad' }), ctx);
    await expectError(res, 401, 'SESSION_TOKEN_INVALID');
    expect(getAudioProvider).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller with no token', async () => {
    await expectError(await POST(req(makeAudioFormData()), ctx), 401, 'SESSION_TOKEN_REQUIRED');
  });
});

describe('audio validation', () => {
  it('400s when the audio field is missing', async () => {
    const res = await POST(req(makeAudioFormData({ audio: null })), ctx);
    await expectError(res, 400, 'MISSING_AUDIO');
  });

  it('400s when the audio file is empty', async () => {
    const empty = new File([], 'voice.webm', { type: 'audio/webm' });
    const res = await POST(req(makeAudioFormData({ audio: empty })), ctx);
    await expectError(res, 400, 'AUDIO_EMPTY');
  });

  it('413s when the audio exceeds the size cap', async () => {
    const tooBig = new File([new Uint8Array(26 * 1024 * 1024)], 'big.webm', { type: 'audio/webm' });
    const res = await POST(req(makeAudioFormData({ audio: tooBig })), ctx);
    await expectError(res, 413, 'AUDIO_TOO_LARGE');
  });

  it('415s when the MIME type is not an allowed audio prefix', async () => {
    const wrong = new File([new Uint8Array([1, 2, 3])], 'doc.txt', { type: 'text/plain' });
    const res = await POST(req(makeAudioFormData({ audio: wrong })), ctx);
    await expectError(res, 415, 'AUDIO_INVALID_TYPE');
  });

  it('accepts audio/webm with a codecs parameter', async () => {
    const ok = new File([new Uint8Array([1, 2])], 'voice.webm', { type: 'audio/webm;codecs=opus' });
    expect((await POST(req(makeAudioFormData({ audio: ok })), ctx)).status).toBe(200);
  });

  it('400s when the language hint is malformed', async () => {
    const res = await POST(req(makeAudioFormData({ language: 'not-a-lang!!' })), ctx);
    await expectError(res, 400, 'INVALID_LANGUAGE');
  });

  it('400s INVALID_BODY when the body is not multipart', async () => {
    const bad = {
      method: 'POST',
      headers: new Headers(),
      formData: () => Promise.reject(new Error('not multipart')),
      url: URL,
    } as unknown as NextRequest;
    const res = await POST(bad, ctx);
    await expectError(res, 400, 'INVALID_BODY');
  });
});

describe('provider routing', () => {
  it('503s NO_AUDIO_PROVIDER when no audio provider is configured', async () => {
    vi.mocked(getAudioProvider).mockResolvedValue(null);
    const res = await POST(req(makeAudioFormData()), ctx);
    await expectError(res, 503, 'NO_AUDIO_PROVIDER');
  });

  it('502s TRANSCRIPTION_FAILED when the provider throws, without leaking the message', async () => {
    const audio = audioResolution();
    audio.provider.transcribe.mockRejectedValue(
      new Error('401 Unauthorized: invalid api_key=sk-leaked-12345')
    );
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(502);
    const body = await parseJson<{ success: false; error: { code: string; message: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
    expect(body.error.message).toBe('Transcription failed');
    expect(body.error.message).not.toContain('sk-');
    expect(body.error.message).not.toContain('api_key');
  });
});

describe('happy path', () => {
  it('returns the transcript text, duration and language', async () => {
    resolveTranscribe({ text: 'hello world', durationMs: 2500, language: 'en' });
    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: true;
      data: { text: string; durationMs: number; language: string };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.text).toBe('hello world');
    expect(body.data.durationMs).toBe(2500);
    expect(body.data.language).toBe('en');
  });

  it('writes a transcription cost log row (sessionId metadata, no agentId)', async () => {
    resolveTranscribe({ text: 'hi', durationMs: 5000, language: 'en' });
    await POST(req(makeAudioFormData()), ctx);

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'transcription',
        durationMs: 5000,
        model: 'whisper-1',
        provider: 'openai',
        metadata: expect.objectContaining({ sessionId: 'sess-1', language: 'en' }),
      })
    );
    const call = vi.mocked(logCost).mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('agentId');
  });

  it('threads the language hint and filename/MIME through to the provider', async () => {
    const audio = resolveTranscribe({ text: 'hola', durationMs: 1000 });
    const file = new File([new Uint8Array([1, 2])], 'recording.mp4', {
      type: 'audio/mp4;codecs=mp4a.40.2',
    });
    await POST(req(makeAudioFormData({ audio: file, language: 'es' })), ctx);

    expect(audio.provider.transcribe).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        language: 'es',
        filename: 'recording.mp4',
        mimeType: 'audio/mp4;codecs=mp4a.40.2',
      })
    );
  });

  it('falls back to audio.webm when the upload has no filename', async () => {
    const audio = resolveTranscribe({ text: 'ok', durationMs: 1000 });
    const file = new File([new Uint8Array([1, 2])], '', { type: 'audio/webm' });
    await POST(req(makeAudioFormData({ audio: file })), ctx);
    expect(audio.provider.transcribe).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ filename: 'audio.webm' })
    );
  });
});

describe('pre-parse body-size guard', () => {
  it('413s AUDIO_TOO_LARGE and never parses the body when Content-Length is oversized', async () => {
    const formDataSpy = vi.fn(() => Promise.resolve(makeAudioFormData()));
    const bad = {
      method: 'POST',
      headers: new Headers({ 'content-length': '1073741824' }), // 1 GB
      formData: formDataSpy,
      url: URL,
    } as unknown as NextRequest;

    const res = await POST(bad, ctx);
    expect(res.status).toBe(413);
    expect((await parseJson<{ error: { code: string } }>(res)).error.code).toBe('AUDIO_TOO_LARGE');
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});

describe('retention regression — audio is never persisted', () => {
  it('writes nothing to session/turn/answer tables on the happy path', async () => {
    resolveTranscribe({ text: 'hello world', durationMs: 2500, language: 'en' });
    const res = await POST(req(makeAudioFormData()), ctx);
    expect(res.status).toBe(200);

    expect(prisma.appQuestionnaireTurn.create).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireTurn.update).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireTurn.upsert).not.toHaveBeenCalled();
    expect(prisma.appAnswerSlot.create).not.toHaveBeenCalled();
    expect(prisma.appAnswerSlot.update).not.toHaveBeenCalled();
    expect(prisma.appAnswerSlot.upsert).not.toHaveBeenCalled();
    expect(prisma.appAnswerSlot.createMany).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('logCost arguments never carry binary data or audio-shaped keys', async () => {
    resolveTranscribe({ text: 'hello', durationMs: 1500, language: 'en' });
    await POST(req(makeAudioFormData()), ctx);
    assertNoAudioPersistence(vi.mocked(logCost), 'logCost');
  });

  it('writes nothing on the error path (TRANSCRIPTION_FAILED)', async () => {
    const audio = audioResolution();
    audio.provider.transcribe.mockRejectedValue(new Error('upstream blew up'));
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    expect((await POST(req(makeAudioFormData()), ctx)).status).toBe(502);
    expect(prisma.appQuestionnaireTurn.create).not.toHaveBeenCalled();
    expect(prisma.appAnswerSlot.create).not.toHaveBeenCalled();
  });
});
