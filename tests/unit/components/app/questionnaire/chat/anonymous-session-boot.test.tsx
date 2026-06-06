/**
 * AnonymousSessionBoot — client-side bootstrap for the no-login respondent surface (F7.1).
 *
 * Stubs fetch and sessionStorage to test the three boot paths without a real network or
 * browser environment: (1) valid stored token → renders QuestionnaireChat directly;
 * (2) no token → POSTs, on success renders QuestionnaireChat and writes storage;
 * (3) create failure → renders the error UI with the server message and a "Try again" button;
 * (4) fetch throws → renders the connection error UI.
 *
 * `QuestionnaireChat` is replaced with a stub that writes its sessionId and accessToken into
 * `data-*` attributes so we can assert props without rendering the full hook+SSE tree.
 * `buildWelcomeTurns` is mocked to a no-op so the greeting module is not exercised here.
 *
 * @see components/app/questionnaire/chat/anonymous-session-boot.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { QuestionnaireChatProps } from '@/components/app/questionnaire/chat/questionnaire-chat';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Stub QuestionnaireChat — renders sessionId + accessToken into data-* attributes so
 * tests can assert they were forwarded without mounting the full streaming component.
 */
vi.mock('@/components/app/questionnaire/chat/questionnaire-chat', () => ({
  QuestionnaireChat: ({ sessionId, accessToken }: QuestionnaireChatProps) => (
    <div
      data-testid="questionnaire-chat"
      data-session-id={sessionId}
      data-access-token={accessToken ?? ''}
    />
  ),
}));

/**
 * Mock buildWelcomeTurns — the greeting module has its own unit test; here we only care
 * that the array it returns is forwarded to QuestionnaireChat (initialTurns).
 */
vi.mock('@/lib/app/questionnaire/chat/greeting', () => ({
  buildWelcomeTurns: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fakeFetch: ReturnType<typeof vi.fn>;
let fakeStorage: Storage;

beforeEach(() => {
  fakeFetch = vi.fn();
  vi.stubGlobal('fetch', fakeFetch);

  fakeStorage = makeSessionStorage();
  vi.stubGlobal('sessionStorage', fakeStorage);
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

    it('does NOT call fetch when a valid stored token is found', async () => {
      // Arrange
      fakeStorage.setItem(
        STORAGE_KEY,
        storedSession('stored-sess-2', 'stored-tok-2', futureExpiry())
      );

      // Act
      render(<AnonymousSessionBoot versionId={VERSION_ID} />);

      // Assert: no network call — the stored token is sufficient.
      await waitFor(() => {
        expect(screen.getByTestId('questionnaire-chat')).toBeInTheDocument();
      });
      expect(fakeFetch).not.toHaveBeenCalled();
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
});
