/**
 * @vitest-environment jsdom
 *
 * ResumeByRefForm — cross-device "continue with your code" entry (session resume).
 *
 * Pins: a successful lookup persists the durable credential + tab marker and reloads; a miss (404)
 * and a throttle (429) surface friendly errors without writing storage or reloading.
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      })
    )
  );
}

async function typeAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/session reference code/i), '7F3K-9M2P');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

describe('ResumeByRefForm', () => {
  it('persists the credential + tab marker and reloads on a match', async () => {
    mockFetch(200, {
      success: true,
      data: {
        session: { id: 'sess-1', versionId: 'v-1' },
        accessToken: 'tok.sig',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    render(<ResumeByRefForm versionId="v-1" />);
    await typeAndSubmit();

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
    await typeAndSubmit();

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
    await typeAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn't find an in-progress session/i
    );
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(anonCredsKey('v-1', false))).toBeNull();
  });

  it('shows a throttle message on 429', async () => {
    mockFetch(429, {});
    render(<ResumeByRefForm versionId="v-1" />);
    await typeAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
    expect(reload).not.toHaveBeenCalled();
  });
});
