/**
 * Client-side storage for the no-login respondent surface's session credential (F7.1 + session
 * resume).
 *
 * The anonymous surface holds its `{ sessionId, accessToken, expiresAt }` on the client (the signed
 * token must never be serialized into server-rendered HTML). WHERE it lives depends on whether the
 * questionnaire opted into session resume:
 *
 *  - **Durable** (`sessionResumeEnabled` on, the public walk-up path) → `localStorage`, so the
 *    session survives a browser/tab close and the respondent can return to it. A per-tab
 *    `sessionStorage` MARKER records that this tab already entered the session, so a same-tab
 *    refresh resumes silently while a genuine return (new tab / after close) can show the
 *    "Continue where you left off / Start new" chooser.
 *  - **Ephemeral** (resume off, or the admin-preview / frictionless-invite paths) → `sessionStorage`
 *    only, the pre-resume behaviour: it survives a refresh within the 24h token TTL but not a close.
 *
 * Pure client helpers — every access is wrapped so private-mode / disabled storage degrades to
 * in-memory-only (the caller's token still works for the current load). No server imports.
 *
 * @see components/app/questionnaire/chat/anonymous-session-boot.tsx
 * @see components/app/questionnaire/chat/resume-by-ref-form.tsx
 */

export interface StoredAnonSession {
  sessionId: string;
  accessToken: string;
  expiresAt: string;
}

/**
 * The credential storage key. Invite sessions key on the token (truncated) so a shared device never
 * crosses two invitees; preview and public-anon key on the version. Matches the original boot key
 * scheme exactly so an in-flight session is found across the resume upgrade.
 */
export function anonCredsKey(versionId: string, preview: boolean, inviteToken?: string): string {
  if (inviteToken) return `qn.invite.${inviteToken.slice(0, 16)}`;
  return `${preview ? 'qn.preview' : 'qn.anon'}.${versionId}`;
}

/** The per-tab "this tab already entered the session" marker key (durable/public-anon path only). */
export function anonMarkerKey(versionId: string): string {
  return `qn.anon.active.${versionId}`;
}

/** Read + validate the stored credential from the given store, honouring its expiry. */
export function readAnonSession(key: string, durable: boolean): StoredAnonSession | null {
  try {
    const store = durable ? window.localStorage : window.sessionStorage;
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAnonSession>;
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      new Date(parsed.expiresAt).getTime() > Date.now()
    ) {
      return parsed as StoredAnonSession;
    }
  } catch {
    // Corrupt / unavailable storage — treat as absent (fall through to a fresh create).
  }
  return null;
}

/** Persist the credential to the appropriate store. Silent no-op when storage is unavailable. */
export function writeAnonSession(key: string, durable: boolean, value: StoredAnonSession): void {
  try {
    const store = durable ? window.localStorage : window.sessionStorage;
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode) — the in-memory token still works for this load.
  }
}

/** Remove the credential from BOTH stores (belt-and-braces on "Start new" / terminal / stale). */
export function clearAnonSession(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Whether this tab has already entered the session (a same-tab refresh, not a fresh return). */
export function hasTabMarker(versionId: string): boolean {
  try {
    return window.sessionStorage.getItem(anonMarkerKey(versionId)) === '1';
  } catch {
    return false;
  }
}

/** Mark this tab as having entered the session (so a subsequent refresh resumes silently). */
export function setTabMarker(versionId: string): void {
  try {
    window.sessionStorage.setItem(anonMarkerKey(versionId), '1');
  } catch {
    /* ignore */
  }
}

/** Clear this tab's entered-session marker (on "Start new", before re-entering fresh). */
export function clearTabMarker(versionId: string): void {
  try {
    window.sessionStorage.removeItem(anonMarkerKey(versionId));
  } catch {
    /* ignore */
  }
}
