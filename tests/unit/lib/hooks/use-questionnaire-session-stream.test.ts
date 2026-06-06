/**
 * useQuestionnaireSessionStream — the respondent turn loop.
 *
 * Fakes the streaming fetch so we can assert optimistic append, content accumulation, the
 * side-band warning banner, and the pre-stream HTTP failure mapping (402/409/429) without a
 * real network or rAF (the committed turn uses the raw accumulator, not the typing buffer).
 *
 * @see lib/hooks/use-questionnaire-session-stream.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { API } from '@/lib/api/endpoints';

const SESSION_ID = 's1';

/** A fake streaming Response: each frame is read out in order, then `done`. */
function streamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    read: async () => {
      if (i < frames.length) {
        return { value: encoder.encode(frames[i++]), done: false };
      }
      return { value: undefined, done: true };
    },
  };
  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
    json: async () => ({}),
  } as unknown as Response;
}

/** A fake non-2xx Response carrying the standard error envelope. */
function errorResponse(status: number, code: string, message = 'nope'): Response {
  return {
    ok: false,
    status,
    body: null,
    json: async () => ({ success: false, error: { code, message } }),
  } as unknown as Response;
}

function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const HAPPY_FRAMES = [
  frame('start', { conversationId: SESSION_ID, messageId: SESSION_ID }),
  frame('content', { delta: 'Hello ' }),
  frame('content', { delta: 'there.' }),
  frame('done', { costUsd: 0.001 }),
];

describe('useQuestionnaireSessionStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Stub rAF so useTypingAnimation resolves synchronously inside act().
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('optimistically appends the user turn, accumulates content, and commits the reply', async () => {
    fetchMock.mockResolvedValue(streamResponse(HAPPY_FRAMES));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.turns).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there.' },
    ]);
    expect(result.current.streaming).toBe(false);
    expect(result.current.status).toBe('idle');
    expect(result.current.canSend).toBe(true);
  });

  it('POSTs to the messages endpoint with the trimmed message and no token header by default', async () => {
    fetchMock.mockResolvedValue(streamResponse(HAPPY_FRAMES));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('  hi  ');
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.messages(SESSION_ID));
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi' });
    expect((init.headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
  });

  it('sends the X-Session-Token header in anonymous mode', async () => {
    fetchMock.mockResolvedValue(streamResponse(HAPPY_FRAMES));

    const { result } = renderHook(() =>
      useQuestionnaireSessionStream({ sessionId: SESSION_ID, accessToken: 'tok-123' })
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Session-Token']).toBe('tok-123');
  });

  it('surfaces a warning frame without blocking the turn', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        frame('start', { conversationId: SESSION_ID, messageId: SESSION_ID }),
        frame('warning', { code: 'CONTRADICTION', message: 'That differs from earlier.' }),
        frame('content', { delta: 'Noted.' }),
        frame('done', { costUsd: 0 }),
      ])
    );

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.warning).toEqual({
      code: 'CONTRADICTION',
      message: 'That differs from earlier.',
    });
    expect(result.current.turns.at(-1)).toEqual({ role: 'assistant', content: 'Noted.' });
    expect(result.current.status).toBe('idle');
  });

  it('maps a 402 to a terminal cost-capped state and keeps the user turn', async () => {
    fetchMock.mockResolvedValue(errorResponse(402, 'COST_CAP_REACHED'));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.status).toBe('cost_capped');
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('COST_CAP_REACHED');
    expect(result.current.turns).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.current.canSend).toBe(false);
  });

  it('maps a 409 to a not-active state', async () => {
    fetchMock.mockResolvedValue(errorResponse(409, 'SESSION_NOT_ACTIVE'));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.status).toBe('not_active');
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('SESSION_NOT_ACTIVE');
    expect(result.current.canSend).toBe(false);
  });

  it('maps a 429 to a transient error that still allows retry', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, 'RATE_LIMITED'));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('RATE_LIMITED');
    expect(result.current.canSend).toBe(true);
  });

  it('maps a 401 in anonymous mode to an expired state', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, 'SESSION_TOKEN_INVALID'));

    const { result } = renderHook(() =>
      useQuestionnaireSessionStream({ sessionId: SESSION_ID, accessToken: 'tok' })
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.status).toBe('expired');
    expect(result.current.canSend).toBe(false);
    expect(result.current.error!.code).toBe('SESSION_TOKEN_INVALID');
  });

  it('maps a 401 in authenticated mode to a terminal (non-retryable) state, not a retry loop', async () => {
    // Arrange: an authenticated (cookie) session whose cookie was revoked server-side.
    fetchMock.mockResolvedValue(errorResponse(401, 'SESSION_UNAUTHORIZED'));

    // Act: no accessToken → authenticated mode.
    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: terminal, composer disabled — retrying would 401 again, so no retry loop.
    expect(result.current.status).toBe('not_active');
    expect(result.current.canSend).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('SESSION_UNAUTHORIZED');
  });

  it('maps a 403 in authenticated mode to the same terminal state', async () => {
    // Arrange
    fetchMock.mockResolvedValue(errorResponse(403, 'FORBIDDEN'));

    // Act
    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: terminal, composer disabled.
    expect(result.current.status).toBe('not_active');
    expect(result.current.canSend).toBe(false);
    expect(result.current.error!.code).toBe('FORBIDDEN');
  });

  it('ignores empty / whitespace-only messages', async () => {
    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('   ');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.turns).toEqual([]);
  });

  it('seeds a blocking error when mounted in a non-active status', () => {
    const { result } = renderHook(() =>
      useQuestionnaireSessionStream({ sessionId: SESSION_ID, initialStatus: 'not_active' })
    );

    expect(result.current.status).toBe('not_active');
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('SESSION_NOT_ACTIVE');
    expect(result.current.canSend).toBe(false);
  });

  // ── New tests (coverage additions) ──────────────────────────────────────────

  it('dismissError clears the error banner while leaving status unchanged', async () => {
    // Arrange: drive to an error state via 429
    fetchMock.mockResolvedValue(errorResponse(429, 'RATE_LIMITED'));
    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(result.current.error).not.toBeNull();

    // Act
    act(() => {
      result.current.dismissError();
    });

    // Assert: error is cleared, status stays 'error' (dismissError does not reset status)
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('error');
  });

  it('maps a 500 with a JSON error body to the returned error code', async () => {
    // Arrange: 500 with a parseable error envelope
    fetchMock.mockResolvedValue(errorResponse(500, 'INTERNAL_SERVER_ERROR'));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: fallthrough branch maps to 'error' status with the wire code
    expect(result.current.status).toBe('error');
    expect(result.current.error!.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('maps a 500 with a non-JSON body to STREAM_ERROR (fallback code)', async () => {
    // Arrange: 500 whose json() throws (non-JSON body)
    const badResponse = {
      ok: false,
      status: 500,
      body: null,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    fetchMock.mockResolvedValue(badResponse);

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: code falls back to the synthetic STREAM_ERROR
    expect(result.current.status).toBe('error');
    expect(result.current.error!.code).toBe('STREAM_ERROR');
  });

  it('does not call fetch when status is a blocking status (not_active)', async () => {
    // Arrange: mount with a blocking initial status
    const { result } = renderHook(() =>
      useQuestionnaireSessionStream({ sessionId: SESSION_ID, initialStatus: 'not_active' })
    );

    // Act: attempt to send while blocked
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: no network call and no optimistic user turn appended
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.turns).toEqual([]);
  });

  it('surfaces an in-stream error frame as a terminal error', async () => {
    // Arrange: stream that carries an SSE error frame mid-reply
    const streamWithError = [
      frame('start', { conversationId: SESSION_ID, messageId: SESSION_ID }),
      frame('content', { delta: 'partial' }),
      frame('error', { code: 'BOOM', message: 'bad' }),
      frame('done', { costUsd: 0 }),
    ];
    fetchMock.mockResolvedValue(streamResponse(streamWithError));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: hook surfaces the in-stream error code
    expect(result.current.status).toBe('error');
    expect(result.current.error!.code).toBe('BOOM');
  });

  it('does not append an empty assistant turn for a start+done stream with no content', async () => {
    // Arrange: stream with no content frames
    const emptyStream = [
      frame('start', { conversationId: SESSION_ID, messageId: SESSION_ID }),
      frame('done', { costUsd: 0 }),
    ];
    fetchMock.mockResolvedValue(streamResponse(emptyStream));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: only the user turn is present — no empty assistant bubble
    expect(result.current.turns).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('seeds initialTurns into the transcript before any send', () => {
    // Arrange: pre-populate with a resume greeting
    const resumeTurn = { role: 'assistant' as const, content: 'Resume greeting.' };
    const { result } = renderHook(() =>
      useQuestionnaireSessionStream({ sessionId: SESSION_ID, initialTurns: [resumeTurn] })
    );

    // Assert: the seed turn is visible before any interaction
    expect(result.current.turns[0]).toEqual(resumeTurn);
  });

  it('surfaces a network interruption mid-stream as NETWORK_ERROR with interrupted message', async () => {
    // Arrange: reader delivers one delta then throws
    const encoder = new TextEncoder();
    let readCount = 0;
    const brokenReader = {
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return { value: encoder.encode(frame('content', { delta: 'partial' })), done: false };
        }
        throw new TypeError('network');
      },
    };
    const brokenResponse = {
      ok: true,
      status: 200,
      body: { getReader: () => brokenReader },
      json: async () => ({}),
    } as unknown as Response;
    fetchMock.mockResolvedValue(brokenResponse);

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: partial content was accumulated, so the message is "interrupted"
    expect(result.current.status).toBe('error');
    expect(result.current.error!.code).toBe('NETWORK_ERROR');
    expect(result.current.error!.message).toContain('interrupted');
  });

  it('does not set error state when fetch is aborted (AbortError early-return)', async () => {
    // Arrange: fetch rejects with an AbortError (e.g. unmount during in-flight request)
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const { result } = renderHook(() => useQuestionnaireSessionStream({ sessionId: SESSION_ID }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // Assert: AbortError is swallowed — error stays null, status is not 'error'
    expect(result.current.error).toBeNull();
    expect(result.current.status).not.toBe('error');
  });
});
