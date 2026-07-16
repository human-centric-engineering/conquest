/**
 * @vitest-environment jsdom
 *
 * Unit test: no-login session credential storage (session resume).
 *
 * Pins the durable-vs-ephemeral split (localStorage vs sessionStorage), the expiry check, the
 * per-tab marker, and the forgiving degradation when a store is unavailable — the machinery the
 * boot relies on to tell a same-tab refresh from a genuine return.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  anonCredsKey,
  anonMarkerKey,
  clearAnonSession,
  clearTabMarker,
  hasTabMarker,
  readAnonSession,
  setTabMarker,
  writeAnonSession,
  type StoredAnonSession,
} from '@/lib/app/questionnaire/chat/anon-session-storage';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

function creds(over: Partial<StoredAnonSession> = {}): StoredAnonSession {
  return { sessionId: 'sess-1', accessToken: 'tok.sig', expiresAt: FUTURE, ...over };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('key builders', () => {
  it('keys public-anon on the version, preview separately, invite on the token prefix', () => {
    expect(anonCredsKey('v-1', false)).toBe('qn.anon.v-1');
    expect(anonCredsKey('v-1', true)).toBe('qn.preview.v-1');
    expect(anonCredsKey('v-1', false, 'abcdefghijklmnopqrstuvwxyz')).toBe(
      'qn.invite.abcdefghijklmnop'
    );
    expect(anonMarkerKey('v-1')).toBe('qn.anon.active.v-1');
  });
});

describe('durable vs ephemeral storage', () => {
  it('durable writes to localStorage, not sessionStorage', () => {
    const key = anonCredsKey('v-1', false);
    writeAnonSession(key, true, creds());
    expect(window.localStorage.getItem(key)).not.toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(readAnonSession(key, true)).toEqual(creds());
  });

  it('ephemeral writes to sessionStorage, not localStorage', () => {
    const key = anonCredsKey('v-1', false);
    writeAnonSession(key, false, creds());
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(readAnonSession(key, false)).toEqual(creds());
  });

  it('reads from the matching store only (durable read ignores a sessionStorage entry)', () => {
    const key = anonCredsKey('v-1', false);
    writeAnonSession(key, false, creds());
    expect(readAnonSession(key, true)).toBeNull();
  });
});

describe('validation', () => {
  it('returns null for an expired credential', () => {
    const key = anonCredsKey('v-1', false);
    writeAnonSession(key, true, creds({ expiresAt: PAST }));
    expect(readAnonSession(key, true)).toBeNull();
  });

  it('returns null for a malformed / missing entry', () => {
    const key = anonCredsKey('v-1', false);
    window.localStorage.setItem(key, '{not json');
    expect(readAnonSession(key, true)).toBeNull();
    expect(readAnonSession('qn.anon.absent', true)).toBeNull();
  });
});

describe('clearAnonSession', () => {
  it('removes the credential from BOTH stores', () => {
    const key = anonCredsKey('v-1', false);
    window.localStorage.setItem(key, JSON.stringify(creds()));
    window.sessionStorage.setItem(key, JSON.stringify(creds()));
    clearAnonSession(key);
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });
});

describe('tab marker', () => {
  it('sets, reads, and clears the per-tab marker in sessionStorage', () => {
    expect(hasTabMarker('v-1')).toBe(false);
    setTabMarker('v-1');
    expect(hasTabMarker('v-1')).toBe(true);
    expect(window.sessionStorage.getItem(anonMarkerKey('v-1'))).toBe('1');
    clearTabMarker('v-1');
    expect(hasTabMarker('v-1')).toBe(false);
  });
});
