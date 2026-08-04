/**
 * @vitest-environment jsdom
 *
 * ResumeByRefForm — cross-device "continue with your code" entry (session resume).
 *
 * Pins: the segmented field submits itself on the eighth character (and only once); what it sends
 * is the normalised code, so a respondent typing lower case or the Crockford look-alikes still
 * matches; a successful lookup persists the durable credential + tab marker and reloads; a miss
 * (404) and a throttle (429) surface friendly errors without writing storage or reloading.
 *
 * @see components/app/questionnaire/chat/resume-by-ref-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResumeByRefForm } from '@/components/app/questionnaire/chat/resume-by-ref-form';
import { anonCredsKey, anonMarkerKey } from '@/lib/app/questionnaire/chat/anon-session-storage';

const reload = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  reload.mockClear();
  assign.mockClear();
  Object.defineProperty(window, 'location', {
    value: { reload, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init: { body: string }) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MATCH_BODY = {
  success: true,
  data: {
    session: { id: 'sess-1', versionId: 'v-1' },
    accessToken: 'tok.sig',
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

/** Type a code into the segmented field. The eighth character submits it — no button press. */
async function enterCode(code = '7F3K-9M2P') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/session reference code/i), code);
}

describe('ResumeByRefForm', () => {
  it('submits itself on the eighth character, exactly once', async () => {
    const fetchMock = mockFetch(200, MATCH_BODY);
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // The button press that used to be required is now redundant, not a second lookup.
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/found it/i);
  });

  it('keeps the submit disabled until the code is complete', async () => {
    mockFetch(200, MATCH_BODY);
    render(<ResumeByRefForm versionId="v-1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/session reference code/i), '7F3K');

    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('normalises what it sends — case and Crockford look-alikes are folded', async () => {
    const fetchMock = mockFetch(200, MATCH_BODY);
    render(<ResumeByRefForm versionId="v-1" />);
    // `o` → `0`, `i` → `1`, lower case → upper, grouping dash dropped.
    await enterCode('7f3o-i m2p');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ ref: '7F301M2P' });
  });

  it('persists the credential + tab marker and reloads on a match', async () => {
    mockFetch(200, MATCH_BODY);
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    const stored = JSON.parse(window.localStorage.getItem(anonCredsKey('v-1', false))!);
    expect(stored).toMatchObject({ sessionId: 'sess-1', accessToken: 'tok.sig' });
    expect(window.sessionStorage.getItem(anonMarkerKey('v-1'))).toBe('1');
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates to the resolved version when the code belongs to a different questionnaire', async () => {
    // The page is v-1 but the entered code resolves to a session on v-2 (publicRef is global).
    mockFetch(200, {
      success: true,
      data: {
        session: { id: 'sess-2', versionId: 'v-2' },
        accessToken: 'tok.2',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/q/v-2'));
    // Credential is keyed on the RESOLVED version, not the page's — so it's findable on v-2.
    expect(window.localStorage.getItem(anonCredsKey('v-2', false))).not.toBeNull();
    expect(window.localStorage.getItem(anonCredsKey('v-1', false))).toBeNull();
    expect(window.sessionStorage.getItem(anonMarkerKey('v-2'))).toBe('1');
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a friendly error and does not reload on a miss (404)', async () => {
    mockFetch(404, { success: false, error: { code: 'NO_RESUMABLE_SESSION' } });
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn't find an in-progress session/i
    );
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(anonCredsKey('v-1', false))).toBeNull();
    // The code stays put and the field stays live so it can be corrected in place.
    expect(screen.getByLabelText(/session reference code/i)).toHaveValue('7F3K9M2P');
  });

  it('clears the error as soon as the respondent edits the code', async () => {
    mockFetch(404, { success: false, error: { code: 'NO_RESUMABLE_SESSION' } });
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/session reference code/i), '{backspace}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a throttle message on 429', async () => {
    mockFetch(429, {});
    render(<ResumeByRefForm versionId="v-1" />);
    await enterCode();

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
    expect(reload).not.toHaveBeenCalled();
  });
});
