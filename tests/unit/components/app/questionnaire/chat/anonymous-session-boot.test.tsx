/**
 * AnonymousSessionBoot — client-side bootstrap for the no-login respondent surface (F7.1).
 *
 * Stubs fetch and sessionStorage to test the boot paths without a real network or browser
 * environment: (1) valid stored token → renders the session workspace directly;
 * (2) no token → POSTs, on success renders the workspace and writes storage;
 * (3) create failure → renders the error UI with the server message and a "Try again" button;
 * (4) fetch throws → renders the connection error UI;
 * (5) StrictMode double-invoke → resolves (no spinner hang) and creates exactly one session;
 * (6) preview mode → POSTs to the admin `/preview` endpoint under its own storage key;
 * (7) resume → a transcript read returning prior turns seeds them and suppresses the auto-open.
 *
 * After resolving a session+token (stored or freshly created), the boot reads `GET …/transcript`
 * to decide whether to replay a prior conversation. The default fake `fetch` dispatches by URL:
 * a transcript read returns an empty transcript (fresh), and a create POST returns a success body;
 * individual tests override via `mockResolvedValue`/`mockRejectedValue` as before.
 *
 * `SessionWorkspace` (chat + answer panel) is replaced with a stub that writes its sessionId,
 * accessToken, the seeded turn count, and autoStart into `data-*` attributes so we can assert
 * props without mounting the full hook+SSE tree. `buildWelcomeTurns` is mocked to a no-op so the
 * greeting module is not exercised here.
 *
 * @see components/app/questionnaire/chat/anonymous-session-boot.tsx
 */

import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { SessionWorkspaceProps } from '@/components/app/questionnaire/session-workspace';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Stub SessionWorkspace — renders sessionId + accessToken into data-* attributes so
 * tests can assert they were forwarded without mounting the full streaming component.
 */
vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({
    sessionId,
    accessToken,
    autoStart,
    initialTurns,
    initialInspectorTurns,
    intro,
  }: SessionWorkspaceProps & { intro?: { enabled?: boolean } | null }) => (
    <div
      data-testid="questionnaire-chat"
      data-session-id={sessionId}
      data-access-token={accessToken ?? ''}
      data-auto-start={String(autoStart ?? false)}
      data-turn-count={String(initialTurns?.length ?? 0)}
      data-inspector-count={String(initialInspectorTurns?.length ?? 0)}
      data-intro-enabled={String(intro?.enabled ?? false)}
    />
  ),
}));

/**
 * Mock buildWelcomeTurns — the greeting module has its own unit test; here we only care
 * that the array it returns is forwarded to the workspace (initialTurns).
 */
vi.mock('@/lib/app/questionnaire/chat/greeting', () => ({
  buildWelcomeTurns: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import { API } from '@/lib/api/endpoints';

// ---------------------------------------------------------------------------
// sessionStorage stub
// ---------------------------------------------------------------------------

/** A simple in-memory sessionStorage replacement. */
function makeSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERSION_ID = 'ver-unit-test-001';
const STORAGE_KEY = `qn.anon.${VERSION_ID}`;

/** A future expiry ISO string (well within the 24h TTL). */
function futureExpiry(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

/** Build a stored session JSON string. */
function storedSession(sessionId: string, accessToken: string, expiresAt: string): string {
  return JSON.stringify({ sessionId, accessToken, expiresAt });
}

/** Build a successful anonymous-create API response body. */
function successBody(sessionId: string, accessToken: string) {
  return {
    success: true,
    data: {
      session: { id: sessionId },
      accessToken,
      expiresAt: futureExpiry(),
    },
  };
}

/** A fake `fetch` Response that resolves with a JSON body. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

/** A transcript-read response body (`GET …/transcript`). Optionally carries the admin-only
 *  Preview Turn Inspector traces (present only for a preview session with the toggle on). */
function transcriptResponse(
  turns: Array<{ role: string; content: string }>,
  inspectorTurns?: unknown[]
) {
  return { success: true, data: { turns, ...(inspectorTurns ? { inspectorTurns } : {}) } };
}

/** A resolved-intro response body (`GET …/intro`) that passes `introResponseSchema`. */
function introResponse(enabled: boolean) {
  return {
    success: true,
    data: {
      intro: {
        enabled,
        questionnaireTitle: 'Test Questionnaire',
        background: '',
        videoUrl: '',
        copy: {
          howItWorks: { heading: 'How it works', body: 'A short chat.' },
          whatYouGet: null,
          goodToKnow: [],
          buttonLabel: 'Begin',
        },
      },
    },
  };
}

/** A minimal valid persisted inspector turn (passes `inspectorTurnSchema`). */
function inspectorTurn(turnIndex: number) {
  return {
    turnIndex,
    calls: [
      {
        label: 'Interviewer',
        model: 'm',
        provider: 'p',
        latencyMs: 5,
        costUsd: 0.001,
        prompt: [],
        response: 'r',
      },
    ],
  };
}

/** Was a create POST (anonymous or preview) issued? Transcript GETs don't count. */
function createCalls(): unknown[][] {
  return fakeFetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fakeFetch: ReturnType<typeof vi.fn>;
let fakeStorage: Storage;
let fakeLocalStorage: Storage;

beforeEach(() => {
  // Default: dispatch by URL — a transcript read returns an empty transcript (fresh session), a
  // create POST returns a generic success body. Tests that exercise create explicitly override
  // with `mockResolvedValue`/`mockRejectedValue` (which then applies to every call, incl. the
  // follow-up transcript read — whose non-transcript body fails to parse and degrades to fresh).
  fakeFetch = vi.fn((url: unknown) => {
    if (typeof url === 'string' && url.includes('/transcript')) {
      return Promise.resolve(jsonResponse(transcriptResponse([])));
    }
    return Promise.resolve(jsonResponse(successBody('default-sess', 'default-tok')));
  });
  vi.stubGlobal('fetch', fakeFetch);

  fakeStorage = makeSessionStorage();
  vi.stubGlobal('sessionStorage', fakeStorage);
  // Durable-resume path (F7.11) keeps credentials in localStorage; stub it too. Non-resume tests
  // never touch it (they run the sessionStorage path), so this is inert for them.
  fakeLocalStorage = makeSessionStorage();
  vi.stubGlobal('localStorage', fakeLocalStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnonymousSessionBoot', () => {
  // -------------------------------------------------------------------------
  // (1) Valid stored token — no fetch required
  // -------------------------------------------------------------------------

  describe('valid stored token', () => {
    it('renders QuestionnaireChat with the stored sessionId and accessToken', async () => {
      // Arrange: seed sessionStorage with a valid, non-expired token.
      fakeStorage.setItem(
        STORAGE_KEY,
        storedSession('stored-sess-1', 'stored-tok-1', futureExpiry())
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: QuestionnaireChat is mounted with the stored credentials.
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-session-id', 'stored-sess-1');
      expect(chat).toHaveAttribute('data-access-token', 'stored-tok-1');
    });

    it('does NOT POST a create when a valid stored token is found (reads the transcript only)', async () => {
      // Arrange
      fakeStorage.setItem(
        STORAGE_KEY,
        storedSession('stored-sess-2', 'stored-tok-2', futureExpiry())
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the stored token is sufficient — no create POST is issued (the only call is the
      // transcript read that decides replay-vs-fresh).
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      expect(createCalls()).toHaveLength(0);
    });

    it('replays a prior transcript and suppresses the auto-open when the session has turns', async () => {
      // Arrange: a stored token (so the only fetch is the transcript read) whose response carries
      // prior turns.
      fakeStorage.setItem(STORAGE_KEY, storedSession('resume-sess', 'resume-tok', futureExpiry()));
      fakeFetch.mockResolvedValueOnce(
        jsonResponse(
          transcriptResponse([
            { role: 'assistant', content: 'Earlier question?' },
            { role: 'user', content: 'An earlier answer' },
          ])
        )
      );

      // The greeting mock accumulates across tests (no global clearMocks) — reset it so the
      // "not called on resume" assertion reflects only this render.
      vi.mocked(buildWelcomeTurns).mockClear();

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: the replayed turns are seeded and the kickoff is suppressed (the last asked
      // question is already on screen); the fresh greeting is NOT built on resume.
      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-turn-count', '2');
      expect(chat).toHaveAttribute('data-auto-start', 'false');
      expect(buildWelcomeTurns).not.toHaveBeenCalled();
    });

    it('seeds persisted inspector traces so a resumed preview re-hydrates the drawer', async () => {
      fakeStorage.setItem(STORAGE_KEY, storedSession('prev-sess', 'prev-tok', futureExpiry()));
      fakeFetch.mockResolvedValueOnce(
        jsonResponse(
          transcriptResponse(
            [{ role: 'assistant', content: 'Earlier question?' }],
            [inspectorTurn(0)]
          )
        )
      );

      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute('data-inspector-count', '1');
    });

    it('keeps the replayed transcript when a malformed inspector trace is returned (fail-soft)', async () => {
      // A corrupt/oversized inspector trace must NOT take down the whole transcript parse — the
      // conversation has to survive even when the admin-only debug data is unusable.
      fakeStorage.setItem(STORAGE_KEY, storedSession('prev-sess', 'prev-tok', futureExpiry()));
      fakeFetch.mockResolvedValueOnce(
        jsonResponse(
          transcriptResponse(
            [
              { role: 'assistant', content: 'Earlier question?' },
              { role: 'user', content: 'An earlier answer' },
            ],
            // calls:[] violates inspectorTurnSchema's min(1) — a malformed element.
            [{ turnIndex: 0, calls: [] }]
          )
        )
      );
      vi.mocked(buildWelcomeTurns).mockClear();

      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Transcript preserved (2 turns, no fresh greeting); inspector degraded to empty.
      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-turn-count', '2');
      expect(chat).toHaveAttribute('data-inspector-count', '0');
      expect(buildWelcomeTurns).not.toHaveBeenCalled();
    });

    it('forwards the voice + anonymity guidance flags to the opening turn', async () => {
      // Arrange: a ready session, with voice and anonymity both on.
      fakeStorage.setItem(
        STORAGE_KEY,
        storedSession('stored-sess-3', 'stored-tok-3', futureExpiry())
      );

      // Act
      render(
        <AnonymousSessionBoot
          versionId={VERSION_ID}
          welcomeCopy="Brand intro."
          voiceInputEnabled
          anonymous
        />
      );

      // Assert: the opening-turn builder receives the flags so it can append the mic nudge
      // and the "won't be passed on" reassurance.
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      expect(buildWelcomeTurns).toHaveBeenCalledWith({
        welcomeCopy: 'Brand intro.',
        voiceInputEnabled: true,
        anonymous: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Intro splash carousel — the intro rides the workspace as a tab, so it must
  // survive a mid-session refresh (a resume), not just front a fresh session.
  // -------------------------------------------------------------------------

  describe('intro splash on resume', () => {
    // With a valid stored token the boot fetches in order: transcript first (replay-vs-fresh), then
    // the intro. So ordered once-mocks map cleanly to that sequence.

    it('still resolves and forwards the intro on a resumed session so the tab persists across a refresh', async () => {
      // A refresh mid-session finds a stored token whose transcript has turns (resume). The intro
      // rides the carousel as a tab, so it must still be fetched and passed through — only the
      // auto-open is suppressed. (Regression: the boot used to force intro=null on resume, dropping
      // the splash tab entirely after a refresh.)
      fakeStorage.setItem(STORAGE_KEY, storedSession('resume-sess', 'resume-tok', futureExpiry()));
      fakeFetch
        .mockResolvedValueOnce(
          jsonResponse(transcriptResponse([{ role: 'assistant', content: 'Earlier question?' }]))
        )
        .mockResolvedValueOnce(jsonResponse(introResponse(true)));

      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-intro-enabled', 'true');
      // Resume still suppresses the kickoff — the prior conversation is already on screen.
      expect(chat).toHaveAttribute('data-auto-start', 'false');
    });
  });

  // -------------------------------------------------------------------------
  // (2) No stored token — POST to ANONYMOUS route
  // -------------------------------------------------------------------------

  describe('no stored token — successful create', () => {
    it('renders QuestionnaireChat with the session and token from the API response', async () => {
      // Arrange: empty storage; API returns a new session.
      fakeFetch.mockResolvedValue(jsonResponse(successBody('api-sess-1', 'api-tok-1')));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the session from the API body is forwarded to QuestionnaireChat.
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      const chat = screen.getByTestId('questionnaire-chat');
      expect(chat).toHaveAttribute('data-session-id', 'api-sess-1');
      expect(chat).toHaveAttribute('data-access-token', 'api-tok-1');
    });

    it('POSTs to API.APP.QUESTIONNAIRE_SESSIONS.ANONYMOUS', async () => {
      // Arrange
      fakeFetch.mockResolvedValue(jsonResponse(successBody('s1', 't1')));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: the correct endpoint is called.
      const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.ANONYMOUS);
      expect(init.method).toBe('POST');
    });

    it('sends the versionId in the POST body', async () => {
      // Arrange
      fakeFetch.mockResolvedValue(jsonResponse(successBody('s1', 't1')));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: the server needs versionId to create the right session.
      const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { versionId: string };
      expect(body.versionId).toBe(VERSION_ID);
    });

    it('writes the token to sessionStorage after a successful create', async () => {
      // Arrange
      const body = successBody('api-sess-2', 'api-tok-2');
      fakeFetch.mockResolvedValue(jsonResponse(body));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: the token is stored so a page refresh reuses it without a new POST.
      const stored = JSON.parse(fakeStorage.getItem(STORAGE_KEY) ?? '{}') as {
        sessionId: string;
        accessToken: string;
      };
      expect(stored.sessionId).toBe('api-sess-2');
      expect(stored.accessToken).toBe('api-tok-2');
    });
  });

  // -------------------------------------------------------------------------
  // (3) Create failure — res.ok=false or body.success=false
  // -------------------------------------------------------------------------

  describe('create failure — server returns an error', () => {
    it('renders the error heading when res.ok is false', async () => {
      // Arrange: HTTP error (e.g. 400 Bad Request) with a failure body.
      fakeFetch.mockResolvedValue(
        jsonResponse(
          { success: false, error: { message: 'This version is not active.' } },
          false // res.ok = false
        )
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the error heading is shown, NOT the chat component.
      // Use a partial text matcher since the apostrophe may be a curly Unicode character.
      await waitFor(() => {
        expect(screen.getByText(/couldn.*t start the questionnaire/i)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('questionnaire-chat')).toBeNull();
    });

    it('renders the server error message when provided', async () => {
      // Arrange
      fakeFetch.mockResolvedValue(
        jsonResponse({ success: false, error: { message: 'This version is not active.' } }, false)
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the server message is surfaced to the respondent.
      await waitFor(() => {
        expect(screen.getByText('This version is not active.')).toBeInTheDocument();
      });
    });

    it('renders the error heading when body.success is false even if res.ok is true', async () => {
      // Arrange: a 200 response with a success=false body (shouldn't happen in practice,
      // but the component checks both `res.ok` and `body.success`).
      fakeFetch.mockResolvedValue(
        jsonResponse({ success: false, error: { message: 'Unexpected failure.' } }, true)
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: use regex to handle Unicode curly apostrophe in the heading.
      await waitFor(() => {
        expect(screen.getByText(/couldn.*t start the questionnaire/i)).toBeInTheDocument();
      });
    });

    it('falls back to a generic message when the server provides no error.message', async () => {
      // Arrange: failure body with no message field.
      fakeFetch.mockResolvedValue(jsonResponse({ success: false, error: {} }, false));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the component fills in its own fallback copy.
      await waitFor(() => {
        expect(
          screen.getByText('This questionnaire is not available right now.')
        ).toBeInTheDocument();
      });
    });

    it('renders a "Try again" button on the error screen', async () => {
      // Arrange
      fakeFetch.mockResolvedValue(
        jsonResponse({ success: false, error: { message: 'Nope' } }, false)
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the respondent can attempt to reload and retry.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // (4) fetch throws — connection error
  // -------------------------------------------------------------------------

  describe('fetch throws — connection error', () => {
    it('renders the connection error message', async () => {
      // Arrange: simulate a network failure (fetch promise rejects).
      fakeFetch.mockRejectedValue(new Error('Network error'));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the component falls back to the catch-path message.
      await waitFor(() => {
        expect(
          screen.getByText(
            'We could not start the questionnaire. Please check your connection and try again.'
          )
        ).toBeInTheDocument();
      });
    });

    it('renders the error heading when fetch throws', async () => {
      // Arrange
      fakeFetch.mockRejectedValue(new TypeError('Failed to fetch'));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: use regex to handle Unicode curly apostrophe in the heading.
      await waitFor(() => {
        expect(screen.getByText(/couldn.*t start the questionnaire/i)).toBeInTheDocument();
      });
    });

    it('does NOT render QuestionnaireChat when fetch throws', async () => {
      // Arrange
      fakeFetch.mockRejectedValue(new Error('Timeout'));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: the chat stub is absent -- the error UI is shown instead.
      await waitFor(() => {
        expect(screen.getByText(/couldn.*t start the questionnaire/i)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('questionnaire-chat')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // (5) StrictMode double-invoke — must not hang, must create exactly once
  // -------------------------------------------------------------------------

  describe('StrictMode double-invoke', () => {
    it('reaches the workspace (does not hang in the spinner) and creates exactly one session', async () => {
      // Arrange: StrictMode double-invokes the effect (setup → cleanup → setup), reproducing
      // the dev runtime. The boot must still resolve, and only one session may be minted.
      fakeFetch.mockResolvedValue(jsonResponse(successBody('sm-sess', 'sm-tok')));

      // Act
      render(
        <StrictMode>
          <AnonymousSessionBoot versionId={VERSION_ID} />
        </StrictMode>
      );

      // Assert: it transitions out of 'creating' to the workspace…
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'sm-sess'
      );
      // …and the create POST ran once despite the double-invoke (no duplicate session) — the
      // follow-up transcript read is a separate GET and doesn't count as a create.
      expect(createCalls()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // (6) Admin preview mode (preview prop)
  // -------------------------------------------------------------------------

  describe('preview mode', () => {
    it('POSTs to the PREVIEW endpoint and stores under the preview key (not the anon key)', async () => {
      // Arrange
      fakeFetch.mockResolvedValue(jsonResponse(successBody('pv-sess', 'pv-tok')));

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} preview />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: preview routes to the admin-gated endpoint and isolates its stored token.
      const [url] = fakeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.PREVIEW);
      expect(fakeStorage.getItem(`qn.preview.${VERSION_ID}`)).not.toBeNull();
      expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('reuses a stored preview token without fetching', async () => {
      // Arrange: a valid token under the preview key.
      fakeStorage.setItem(
        `qn.preview.${VERSION_ID}`,
        storedSession('pv-stored', 'pv-stored-tok', futureExpiry())
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} preview />);
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });

      // Assert: the stored preview token is sufficient — no create POST (only the transcript read).
      expect(createCalls()).toHaveLength(0);
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'pv-stored'
      );
    });
  });

  // -------------------------------------------------------------------------
  // (8) Session resume (durable localStorage path, F7.11) — resumeEnabled
  // -------------------------------------------------------------------------

  describe('session resume (durable)', () => {
    const MARKER_KEY = `qn.anon.active.${VERSION_ID}`;

    /** A status-read body (`GET …/status`) with the fields the resume gate reads. */
    function statusResponse(
      status: string,
      answeredCount: number,
      ref: string | null = '7F3K9M2P'
    ) {
      return {
        success: true,
        data: { status, ref, completion: { answeredCount } },
      };
    }

    /** A fetch that dispatches the resume URLs; create POST returns a fresh session. */
    function resumeFetch(statusBody: unknown) {
      return vi.fn((url: unknown, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/status')) return Promise.resolve(jsonResponse(statusBody));
        if (u.includes('/transcript')) return Promise.resolve(jsonResponse(transcriptResponse([])));
        if (u.includes('/lifecycle')) return Promise.resolve(jsonResponse({ success: true }));
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse(successBody('fresh-sess', 'fresh-tok')));
        }
        return Promise.resolve(jsonResponse(transcriptResponse([])));
      });
    }

    function seedDurableCreds(sessionId = 'dur-sess', accessToken = 'dur-tok') {
      fakeLocalStorage.setItem(STORAGE_KEY, storedSession(sessionId, accessToken, futureExpiry()));
    }

    it('shows the welcome-back gate on a genuine return (durable creds, no tab marker, resumable)', async () => {
      seedDurableCreds();
      fakeFetch = resumeFetch(statusResponse('active', 3));
      vi.stubGlobal('fetch', fakeFetch);

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);

      expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
      expect(screen.getByText('7F3K-9M2P')).toBeInTheDocument();
      // Not entered the chat yet, and no fresh session minted.
      expect(screen.queryByTestId('questionnaire-chat')).not.toBeInTheDocument();
      expect(createCalls()).toHaveLength(0);
    });

    it('resumes silently on a same-tab refresh (marker present) — no gate', async () => {
      seedDurableCreds('same-tab-sess', 'same-tab-tok');
      fakeStorage.setItem(MARKER_KEY, '1');
      fakeFetch = resumeFetch(statusResponse('active', 3));
      vi.stubGlobal('fetch', fakeFetch);

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);

      await waitFor(() => expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument());
      expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'same-tab-sess'
      );
    });

    it('starts fresh for a zero-progress session (no gate — do not nag a barely-started returner)', async () => {
      seedDurableCreds('barely-started', 'bs-tok');
      // Active but answeredCount 0 → below the resume threshold → treat as not worth resuming.
      fakeFetch = resumeFetch(statusResponse('active', 0));
      vi.stubGlobal('fetch', fakeFetch);

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);

      await waitFor(() => expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument());
      expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
      expect(createCalls()).toHaveLength(1); // stale creds cleared, fresh session minted
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'fresh-sess'
      );
    });

    it('starts fresh when the stored session is terminal (clears stale creds, no gate)', async () => {
      seedDurableCreds('old-done', 'old-tok');
      fakeFetch = resumeFetch(statusResponse('completed', 5));
      vi.stubGlobal('fetch', fakeFetch);

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);

      await waitFor(() => expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument());
      expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
      expect(createCalls()).toHaveLength(1); // a fresh session was minted
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'fresh-sess'
      );
    });

    it('Continue enters the existing session and marks the tab', async () => {
      seedDurableCreds('resume-me', 'resume-tok');
      fakeFetch = resumeFetch(statusResponse('active', 2));
      vi.stubGlobal('fetch', fakeFetch);
      const user = userEvent.setup();

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);
      await user.click(await screen.findByRole('button', { name: /continue where you left off/i }));

      await waitFor(() => expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument());
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'resume-me'
      );
      expect(fakeStorage.getItem(MARKER_KEY)).toBe('1');
      expect(createCalls()).toHaveLength(0); // continued, never created
    });

    it('Start new abandons the old session and mints a fresh one', async () => {
      seedDurableCreds('abandon-me', 'abandon-tok');
      fakeFetch = resumeFetch(statusResponse('active', 4));
      vi.stubGlobal('fetch', fakeFetch);
      const user = userEvent.setup();

      render(<AnonymousSessionBoot versionId={VERSION_ID} resumeEnabled />);
      await user.click(await screen.findByRole('button', { name: /start a new questionnaire/i }));

      await waitFor(() => expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument());
      // A lifecycle abandon POST fired for the old session, and a fresh session was created.
      const lifecycleCall = fakeFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/lifecycle')
      );
      expect(lifecycleCall).toBeTruthy();
      expect(JSON.parse((lifecycleCall![1] as RequestInit).body as string)).toMatchObject({
        action: 'abandon',
      });
      expect(screen.getByTestId('questionnaire-chat')).toHaveAttribute(
        'data-session-id',
        'fresh-sess'
      );
    });
  });
});
